//! A member's own character: the look they put together in the studio's wardrobe (a wardrobe body, studio parts, hair
//! and garment colours). Saving it checks every part against the character server's wardrobe, then a background task
//! assembles it into one GLB (`look_bake`), checks, slims and stores it like an imported model, and the island wears it:
//! the player's model, and the model its live room is told about. Each member reads and writes only their own look.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{collections::BTreeMap, panic::AssertUnwindSafe};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{User, current_user},
    error::{ApiError, ApiResult, bad, conflict, internal, not_found},
    factory::{self, MAX_MODEL_BYTES},
    glb,
    look_bake::{self, COVERED_SLOTS, Coverage, HAIR_SLOTS, Palette, Part},
    security::rate_limit,
    slim,
    studio::segment,
};

/// Parts one look wears at most; the wardrobe has ten slots.
const MAX_PARTS: usize = 12;
/// Looks one member may save in the rate window (ten minutes); each one assembles a model.
const SAVES_PER_WINDOW: u32 = 30;
/// A bake still marked running after this long was cut short by a restart.
const STALE: chrono::Duration = chrono::Duration::minutes(10);
/// Looks being assembled at once, over every member, before a save is turned away. Each holds its part files in memory
/// until it has a slot for the heavy work.
const MAX_BAKING: i64 = 16;
const MAX_MASK_BYTES: usize = 16 * 1024 * 1024;
/// What an assembled look may weigh, as stored: it loads on every visitor's island.
const MAX_LOOK_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOOK_TRIANGLES: u64 = 150_000;

const BUSY: ApiError = ApiError::new(
    StatusCode::TOO_MANY_REQUESTS,
    "looks_busy",
    "지금 모습을 입히는 사람이 많아요. 잠시 뒤에 다시 저장해 주세요.",
);
const BAKING: ApiError = conflict("look_baking", "지금 입히는 중이에요. 끝난 뒤 다시 저장해 주세요.");
const BODY_CHANGED: ApiError = conflict("look_body_changed", "옷장 몸이 바뀌었어요. 옷장을 다시 불러와 주세요.");
const PART_CHANGED: ApiError = conflict("look_part_changed", "옷장에 없는 파츠가 있어요. 옷장을 다시 불러와 주세요.");
const INVALID: ApiError = bad("invalid_look", "입힐 수 없는 조합이에요.");
const NOT_READY: ApiError = conflict("look_not_ready", "아직 입을 수 있는 모습이 없어요.");
const NO_LOOK: ApiError = not_found("look_not_found", "저장한 모습이 없어요.");
const NOT_PLAYABLE: &str = "옷장 몸에 idle·walk 애니메이션이 없어 섬에서 걸을 수 없어요.";
const TOO_LARGE: &str = "입힌 모습이 너무 커요(16 MB, 삼각형 15만 개까지). 파츠를 줄여 주세요.";
const INTERRUPTED: &str = "서버가 다시 시작되어 입히기가 멈췄어요. 다시 저장해 주세요.";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/looks/me", get(mine).put(save).patch(wear))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartRef {
    job_id: String,
    version: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyRef {
    job_id: String,
    version: String,
}

/// `PUT /api/looks/me`: the wardrobe's body, the part worn in each slot, the hair colour and garment region colours.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LookBody {
    body: BodyRef,
    #[serde(default)]
    parts: BTreeMap<String, PartRef>,
    hair_color: Option<String>,
    #[serde(default)]
    colors: BTreeMap<String, BTreeMap<String, String>>,
}

fn sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn slot_name(value: &str) -> bool {
    (2..=20).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphabetic())
}

fn color(value: &str) -> Option<String> {
    look_bake::linear_color(value).map(|_| value.to_ascii_lowercase())
}

/// The look as stored: ids checked, colours as `#rrggbb`, colours only for worn garments (never hair), a hair colour
/// only with hair on.
pub fn request(body: LookBody) -> ApiResult<Value> {
    let ids = |job: &str, version: &str| segment(job).is_some() && segment(version).is_some();
    if !ids(&body.body.job_id, &body.body.version) || body.parts.len() > MAX_PARTS {
        return Err(INVALID);
    }
    let mut parts = Map::new();
    for (slot, part) in &body.parts {
        if !slot_name(slot) || !ids(&part.job_id, &part.version) || !sha256_hex(&part.sha256) {
            return Err(INVALID);
        }
        parts.insert(slot.clone(), json!({"jobId": part.job_id, "version": part.version, "sha256": part.sha256}));
    }
    let hair_worn = HAIR_SLOTS.iter().any(|slot| parts.contains_key(*slot));
    let hair_color = match body.hair_color.as_deref() {
        Some(value) => Some(color(value).ok_or(INVALID)?).filter(|_| hair_worn),
        None => None,
    };
    let mut colors = Map::new();
    for (slot, chosen) in &body.colors {
        if !parts.contains_key(slot) || HAIR_SLOTS.contains(&slot.as_str()) {
            return Err(INVALID);
        }
        let mut regions = Map::new();
        for (region, value) in chosen {
            if !["0", "1", "2", "3"].contains(&region.as_str()) {
                return Err(INVALID);
            }
            regions.insert(region.clone(), color(value).ok_or(INVALID)?.into());
        }
        if !regions.is_empty() {
            colors.insert(slot.clone(), Value::Object(regions));
        }
    }
    Ok(json!({
        "body": {"jobId": body.body.job_id, "version": body.body.version},
        "parts": parts,
        "hairColor": hair_color,
        "colors": colors,
    }))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

/// Whether the character server's wardrobe still lists the look's body at its version and every part as the very file
/// chosen; the body file's SHA-256 when it does.
pub fn listed(bodies: &Value, listing: &Value, look: &Value) -> ApiResult<String> {
    let body = &look["body"];
    let registered = bodies["bodies"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| text(entry, "job_id") == text(body, "jobId") && text(entry, "version") == text(body, "version"))
        .ok_or(BODY_CHANGED)?;
    let sha = text(registered, "body_sha256");
    if !sha256_hex(sha) || text(&listing["body"], "job_id") != text(body, "jobId") {
        return Err(BODY_CHANGED);
    }
    let parts = listing["parts"].as_array().map_or(&[][..], Vec::as_slice);
    for (slot, part) in look["parts"].as_object().into_iter().flatten() {
        let found = parts.iter().any(|entry| {
            text(entry, "slot") == slot
                && text(entry, "job_id") == text(part, "jobId")
                && text(entry, "version") == text(part, "version")
                && text(entry, "sha256") == text(part, "sha256")
        });
        if !found {
            return Err(PART_CHANGED);
        }
    }
    Ok(sha.to_owned())
}

const LOOK_SELECT: &str = "SELECT request, status, worn, model_url, error_code, error_message, report, updated_at
    FROM user_looks WHERE user_id = $1";

fn look_json(row: &PgRow) -> Value {
    let updated: DateTime<Utc> = row.get("updated_at");
    let mut status: String = row.get("status");
    let (mut code, mut message): (Option<String>, Option<String>) = (row.get("error_code"), row.get("error_message"));
    if status == "baking" && Utc::now() - updated > STALE {
        status = "failed".into();
        (code, message) = (Some("interrupted".into()), Some(INTERRUPTED.into()));
    }
    json!({
        "request": row.get::<Value, _>("request"),
        "status": status,
        "worn": row.get::<bool, _>("worn"),
        "modelUrl": row.get::<Option<String>, _>("model_url"),
        "error": code.map(|code| json!({"code": code, "message": message.unwrap_or_default()})),
        "report": row.get::<Option<Value>, _>("report"),
        "updatedAt": updated,
    })
}

async fn look_of(state: &AppState, user: Uuid) -> ApiResult<Option<Value>> {
    Ok(sqlx::query(LOOK_SELECT).bind(user).fetch_optional(&state.db).await?.as_ref().map(look_json))
}

/// `GET /api/looks/me`: the caller's look, or null before they save one.
async fn mine(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    Ok(Json(json!({"look": look_of(&state, user.id).await?})))
}

/// Looks being assembled now: `baking`, and not yet as old as [`STALE`].
async fn baking_now(db: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT count(*) FROM user_looks WHERE status = 'baking' AND updated_at > now() - make_interval(mins => $1)",
    )
    .bind(STALE.num_minutes() as i32)
    .fetch_one(db)
    .await
}

/// `PUT /api/looks/me`: saves the look and starts assembling it; 202 with the look, `baking` until it is worn.
async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<LookBody>) -> ApiResult<Response> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("look:{}", user.id), SAVES_PER_WINDOW)?;
    let look = request(body)?;
    factory::configured(&state)?;
    if baking_now(&state.db).await? > MAX_BAKING {
        return Err(BUSY);
    }
    let body_job = text(&look["body"], "jobId").to_owned();
    let bodies =
        factory::fetch_json(&state, &user.username, "avatar-factory/wardrobe/bodies").await?.unwrap_or_default();
    let parts_path = format!("avatar-factory/wardrobe/bodies/{body_job}/parts");
    let listing = factory::fetch_json(&state, &user.username, &parts_path).await?.ok_or(BODY_CHANGED)?;
    let body_sha = listed(&bodies, &listing, &look)?;
    // One bake at a time per member; one cut short long ago no longer holds the next.
    let revision: Option<i64> = sqlx::query_scalar(
        "INSERT INTO user_looks (user_id, request) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET request = $2, revision = user_looks.revision + 1, status = 'baking',
           error_code = NULL, error_message = NULL, wear_on_ready = true, updated_at = now()
         WHERE user_looks.status <> 'baking' OR user_looks.updated_at < now() - make_interval(mins => $3)
         RETURNING revision",
    )
    .bind(user.id)
    .bind(&look)
    .bind(STALE.num_minutes() as i32)
    .fetch_optional(&state.db)
    .await?;
    let revision = revision.ok_or(BAKING)?;
    tokio::spawn(Bake { state: state.clone(), user: user.clone(), revision, look, body_sha }.run());
    let saved = look_of(&state, user.id).await?.ok_or(NO_LOOK)?;
    Ok((StatusCode::ACCEPTED, Json(json!({"look": saved}))).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wear {
    worn: bool,
}

/// `PATCH /api/looks/me`: `{worn}`: the island wears the look, or the 미니미 again. What is chosen here also holds for a
/// look still baking, which is worn when it finishes only if the member wanted it worn.
async fn wear(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Wear>) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    let changed = sqlx::query(
        "UPDATE user_looks SET worn = $2, wear_on_ready = $2 WHERE user_id = $1 AND (NOT $2 OR model_url IS NOT NULL)
         RETURNING user_id",
    )
    .bind(user.id)
    .bind(body.worn)
    .fetch_optional(&state.db)
    .await?;
    let look = look_of(&state, user.id).await?.ok_or(NO_LOOK)?;
    if changed.is_none() {
        return Err(NOT_READY);
    }
    Ok(Json(json!({"look": look})))
}

/// Picking a 미니미 on the island takes the look off, and a look still baking is not put on when it finishes.
pub async fn take_off(db: &PgPool, user: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE user_looks SET worn = false, wear_on_ready = false WHERE user_id = $1 AND (worn OR wear_on_ready)",
    )
    .bind(user)
    .execute(db)
    .await?;
    Ok(())
}

/// Marks the looks a stopped server left baking as failed: their tasks ended with it. Run at startup, before this
/// server bakes any of its own.
pub async fn interrupt_unfinished(db: &PgPool) -> Result<u64, sqlx::Error> {
    let stopped = sqlx::query(
        "UPDATE user_looks SET status = 'failed', error_code = 'interrupted', error_message = $1, updated_at = now()
         WHERE status = 'baking'",
    )
    .bind(INTERRUPTED)
    .execute(db)
    .await?;
    Ok(stopped.rows_affected())
}

/// Why a bake failed: a code and a message for the wardrobe.
struct Failure(&'static str, String);

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self(error.code, error.message.to_owned())
    }
}

/// A garment of a covered slot whose coverage record is missing or unreadable: without it the body would show through.
fn no_coverage(slot: &str) -> Failure {
    Failure("look_coverage", format!("{slot} 파츠가 몸을 가리는 모양을 읽지 못했어요. 옷장을 다시 불러와 주세요."))
}

/// Colours chosen for a part that cannot take them (no regions or texture, a mask that cannot be read): the model would
/// come out without them.
fn no_colors(slot: &str) -> Failure {
    Failure(
        "look_colors",
        format!("{slot} 파츠에 고른 색을 입힐 수 없어요. 색을 되돌리거나 옷장을 다시 불러와 주세요."),
    )
}

/// One saved look being assembled.
struct Bake {
    state: AppState,
    user: User,
    revision: i64,
    look: Value,
    body_sha: String,
}

impl Bake {
    async fn run(self) {
        // A newer save, or the cleanup after a restart, ends this bake before it does any work.
        if !self.current().await {
            return;
        }
        let outcome = match AssertUnwindSafe(self.make()).catch_unwind().await {
            Ok(outcome) => outcome,
            Err(_) => Err(Failure("internal", "잠시 후 다시 시도해 주세요.".into())),
        };
        let saved = match outcome {
            Ok(None) => return,
            Ok(Some((model_url, report))) => {
                sqlx::query(
                    "UPDATE user_looks SET status = 'ready', model_url = $3, baked = request, report = $4,
                     worn = wear_on_ready, updated_at = now() WHERE user_id = $1 AND revision = $2",
                )
                .bind(self.user.id)
                .bind(self.revision)
                .bind(model_url)
                .bind(report)
                .execute(&self.state.db)
                .await
            }
            Err(Failure(code, message)) => {
                tracing::warn!(user = %self.user.id, code, "Look bake failed");
                sqlx::query(
                    "UPDATE user_looks SET status = 'failed', error_code = $3, error_message = $4, updated_at = now()
                     WHERE user_id = $1 AND revision = $2",
                )
                .bind(self.user.id)
                .bind(self.revision)
                .bind(code)
                .bind(message)
                .execute(&self.state.db)
                .await
            }
        };
        if let Err(error) = saved {
            tracing::error!(%error, user = %self.user.id, "Could not record a look bake");
        }
    }

    /// Whether this is still the look's latest bake and still `baking`.
    async fn current(&self) -> bool {
        let found = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM user_looks WHERE user_id = $1 AND revision = $2 AND status = 'baking')",
        )
        .bind(self.user.id)
        .bind(self.revision)
        .fetch_one(&self.state.db)
        .await;
        // A database that cannot answer cannot take the result either, which the end of the bake reports.
        found.unwrap_or(true)
    }

    /// A file under the character server's `/api/`, checked against the SHA-256 the wardrobe listed for it.
    async fn file(&self, path: &str, sha: &str, changed: ApiError) -> Result<Vec<u8>, Failure> {
        let bytes = factory::fetch_file(&self.state, &self.user.username, path, MAX_MODEL_BYTES, None).await?;
        if hex::encode(Sha256::digest(&bytes)) != sha {
            return Err(changed.into());
        }
        Ok(bytes)
    }

    async fn json(&self, path: &str) -> Result<Option<Value>, Failure> {
        Ok(factory::fetch_json(&self.state, &self.user.username, path).await?)
    }

    /// A garment's colour regions and their mask, with the colours the look chose; None when it chose none. Colours the
    /// part cannot take fail the look instead of being left off the model unseen.
    async fn palette(&self, slot: &str, part: &Value) -> Result<Option<Palette>, Failure> {
        let Some(chosen) = self.look["colors"][slot].as_object() else { return Ok(None) };
        let (job, version) = (text(part, "jobId"), text(part, "version"));
        let regions_path = format!("avatar-factory/wardrobe/colors/{job}/{slot}?version={version}");
        let Some(regions) = factory::fetch_json_if_applicable(&self.state, &self.user.username, &regions_path).await?
        else {
            return Err(no_colors(slot));
        };
        let mask_path = format!("avatar-factory/wardrobe/colors/{job}/{slot}/mask?version={version}");
        let mask = factory::fetch_file(&self.state, &self.user.username, &mask_path, MAX_MASK_BYTES, None)
            .await
            .map_err(|error| if error.status == StatusCode::NOT_FOUND { no_colors(slot) } else { error.into() })?;
        let Some(mask) = slim::decode(&mask, image::ImageFormat::Png, 4096, 256 * 1024 * 1024) else {
            return Err(no_colors(slot));
        };
        let lights = regions["regions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|region| region["light"].as_f64().unwrap_or(0.5))
            .collect();
        let colors = [0, 1, 2, 3].map(|region: usize| {
            chosen.get(&region.to_string()).and_then(Value::as_str).and_then(look_bake::linear_color)
        });
        Ok(Some(Palette {
            material: regions["material"].as_u64().unwrap_or(0) as usize,
            lights,
            mask: mask.to_rgba8(),
            colors,
        }))
    }

    /// The model's site path and the bake's report; None when a newer save took over while this one waited for a slot.
    async fn make(&self) -> Result<Option<(String, Value)>, Failure> {
        let body_ref = &self.look["body"];
        let (body_job, body_version) = (text(body_ref, "jobId"), text(body_ref, "version"));
        let body_path = format!("avatar-factory/jobs/{body_job}/native-parts/{body_version}/body.glb");
        let body = self.file(&body_path, &self.body_sha, BODY_CHANGED).await?;
        let mut files = Vec::new();
        for (slot, part) in self.look["parts"].as_object().into_iter().flatten() {
            let (job, version) = (text(part, "jobId"), text(part, "version"));
            let bytes = self
                .file(
                    &format!("avatar-factory/jobs/{job}/native-parts/{version}/{slot}.glb"),
                    text(part, "sha256"),
                    PART_CHANGED,
                )
                .await?;
            let coverage = if COVERED_SLOTS.contains(&slot.as_str()) {
                let path = format!("avatar-factory/wardrobe/bodies/{body_job}/coverage/{job}/{slot}?version={version}");
                let record = self.json(&path).await?;
                Some(record.as_ref().and_then(Coverage::parse).ok_or_else(|| no_coverage(slot))?)
            } else {
                None
            };
            let palette = self.palette(slot, part).await?;
            files.push((slot.clone(), bytes, coverage, palette));
        }
        let hair = self.look["hairColor"].as_str().and_then(look_bake::linear_color);
        // Only the heavy work takes a slot (shared with the imports); the downloads above wait for nobody.
        let slot = self.state.imports.clone().acquire_owned().await.map_err(|error| Failure::from(internal(error)))?;
        if !self.current().await {
            return Ok(None);
        }
        let (web, details, report) = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let parts: Vec<Part> = files
                .iter()
                .map(|(slot, bytes, coverage, palette)| Part {
                    slot: slot.clone(),
                    glb: bytes,
                    coverage: coverage.clone(),
                    palette: palette.clone(),
                })
                .collect();
            let baked = look_bake::bake(&body, parts, hair).map_err(|error| Failure(error.code, error.message))?;
            let details =
                glb::details(&baked.glb).ok_or_else(|| Failure("look_part", "모델을 만들지 못했어요.".into()))?;
            let web = slim::slim(&baked.glb).unwrap_or(baked.glb);
            Ok::<_, Failure>((web, details, baked.report))
        })
        .await
        .map_err(|error| Failure::from(internal(error)))??;
        if !details.summary().playable() {
            return Err(Failure("look_not_playable", NOT_PLAYABLE.into()));
        }
        if web.len() > MAX_LOOK_BYTES || details.triangles > MAX_LOOK_TRIANGLES {
            return Err(Failure("look_too_large", TOO_LARGE.into()));
        }
        let mut report = report;
        report["bytes"] = web.len().into();
        report["triangles"] = details.triangles.into();
        report["clips"] = json!(details.clips);
        let model_url = self.state.config.models.put("glb", web).await?;
        Ok(Some((model_url, report)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(seed: char) -> String {
        seed.to_string().repeat(64)
    }

    fn body(value: Value) -> LookBody {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn looks_keep_ids_colours_and_only_what_is_worn() {
        let look = request(body(json!({
            "body": {"jobId": "b1", "version": "v1"},
            "parts": {"hat": {"jobId": "p1", "version": "v2", "sha256": sha('a')}, "hair": {"jobId": "p2", "version": "v3", "sha256": sha('b')}},
            "hairColor": "#8A7998",
            "colors": {"hat": {"0": "#FF0000", "3": "#00ff00"}},
        })))
        .unwrap();
        assert_eq!(look["hairColor"], "#8a7998");
        assert_eq!(look["colors"], json!({"hat": {"0": "#ff0000", "3": "#00ff00"}}));
        assert_eq!(look["parts"]["hat"], json!({"jobId": "p1", "version": "v2", "sha256": sha('a')}));

        // A hair colour without hair is dropped; a bad id, colour, region, slot or hash is refused.
        let bare = request(body(json!({"body": {"jobId": "b1", "version": "v1"}, "hairColor": "#123456"}))).unwrap();
        assert_eq!(bare["hairColor"], Value::Null);
        for broken in [
            json!({"body": {"jobId": "../b", "version": "v1"}}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "hairColor": "blue"}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "parts": {"hat": {"jobId": "p1", "version": "v2", "sha256": "abc"}}}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "parts": {"h4t": {"jobId": "p1", "version": "v2", "sha256": sha('a')}}}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "colors": {"hat": {"0": "#ff0000"}}}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "parts": {"hat": {"jobId": "p1", "version": "v2", "sha256": sha('a')}},
                "colors": {"hat": {"4": "#ff0000"}}}),
            json!({"body": {"jobId": "b1", "version": "v1"}, "parts": {"hair": {"jobId": "p1", "version": "v2", "sha256": sha('a')}},
                "colors": {"hair": {"0": "#ff0000"}}}),
        ] {
            assert_eq!(request(body(broken.clone())).unwrap_err().code, "invalid_look", "{broken}");
        }
        assert!(
            serde_json::from_value::<LookBody>(json!({"body": {"jobId": "b", "version": "v"}, "modelUrl": "x"}))
                .is_err()
        );
    }

    #[test]
    fn a_look_must_match_the_wardrobe_file_for_file() {
        let look = json!({"body": {"jobId": "b1", "version": "v1"},
            "parts": {"hat": {"jobId": "p1", "version": "v2", "sha256": sha('a')}}});
        let bodies = json!({"bodies": [{"job_id": "b1", "version": "v1", "body_sha256": sha('c')}]});
        let listing = json!({"body": {"job_id": "b1"}, "parts": [{"job_id": "p1", "version": "v2", "slot": "hat", "sha256": sha('a')}]});
        assert_eq!(listed(&bodies, &listing, &look).unwrap(), sha('c'));
        let moved = json!({"bodies": [{"job_id": "b1", "version": "v9", "body_sha256": sha('c')}]});
        assert_eq!(listed(&moved, &listing, &look).unwrap_err().code, "look_body_changed");
        let refit = json!({"body": {"job_id": "b1"}, "parts": [{"job_id": "p1", "version": "v3", "slot": "hat", "sha256": sha('a')}]});
        assert_eq!(listed(&bodies, &refit, &look).unwrap_err().code, "look_part_changed");
        let elsewhere = json!({"body": {"job_id": "b1"}, "parts": [{"job_id": "p1", "version": "v2", "slot": "top", "sha256": sha('a')}]});
        assert_eq!(listed(&bodies, &elsewhere, &look).unwrap_err().code, "look_part_changed");
    }
}
