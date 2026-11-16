//! Pets: one dog per member, on their island. The dog's brain runs in its owner's page (frontend/src/pets); the server
//! keeps what the page saves (the trained readout as `pet-brain-v1` bytes, the drives and the training counts) and
//! checks it, and keeps the breeds members adopt from. Visitors see the pet where the owner's page relays it over the
//! island's game socket (`games`, `{"type":"Pet"}`), and resting at its home otherwise.
//!
//! - `GET /api/pets/breeds`: the published breeds, `{breeds: [breed]}` in their order.
//! - `GET /api/homes/{username}/pet`: the island's pet for whoever may view the island, `{pet: {id, name, breed,
//!   breedInfo, home} | null}`.
//! - `GET /api/pets/me`: the member's own pet with what its page needs to run it, `{pet: {…, seed, graphId, model,
//!   brain, drives, stats, revision, createdAt, updatedAt} | null}`.
//! - `POST /api/pets/me` adopts one (201), `PATCH /api/pets/me` renames it or moves its home, `PUT /api/pets/me/brain`
//!   saves its brain, drives and stats against the revision the page has, `DELETE /api/pets/me` lets it go (204).
//! - `/api/pets/admin/breeds` for the catalog's editors: every breed with its status, a breed's name, order, height and
//!   status, and a breed whose model the app ships (`/gltf/pets/*.glb`).
//!
//! Every change names the account the page was loaded for (`expectedOwnerId`) and may name the pet it has (`petId`), so
//! a page left open for another account or another pet never changes this one.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, put},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::{Row, postgres::PgRow};
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{current_user, optional_user, require},
    catalog,
    error::{ApiError, ApiResult, bad, conflict, not_found},
    homes::visible_home,
    rebac::CATALOG_EDITOR,
    security::{client_address, plain_text, rate_limit},
};

/// The brain format the server checks (frontend/src/pets/brain/codec.ts): little-endian, `MGPB`, version 1, senses,
/// actions and features as u16, the circuit's id hashed, the choice RNG's state and the learning updates as u32, then
/// the readout as f32, action-major.
pub const BRAIN_MODEL: &str = "pet-brain-v1";
/// The circuit every pet's brain reads (frontend/src/pets/brain/malecns-dna02-128.json).
pub const GRAPH_ID: &str = "malecns-v1.0-dna02-neighborhood-128";
const BRAIN_MAGIC: &[u8; 4] = b"MGPB";
const BRAIN_VERSION: u16 = 1;
const SENSES: u16 = 20;
const ACTIONS: u16 = 10;
/// A bias and one per neuron of the circuit.
const FEATURES: u16 = 129;
const BRAIN_HEADER: usize = 24;
/// 5,184 bytes.
pub const BRAIN_BYTES: usize = BRAIN_HEADER + 4 * ACTIONS as usize * FEATURES as usize;
/// As standard base64: 6,912 characters, no padding.
const BRAIN_BASE64: usize = BRAIN_BYTES.div_ceil(3) * 4;
/// The bound the brain keeps its readout weights within.
const WEIGHT_LIMIT: f32 = 12.0;
const GRAPH_HASH: u32 = fnv1a(GRAPH_ID.as_bytes());

/// The drives a page saves, each 0..1 (frontend/src/pets/drives.ts).
const DRIVES: [&str; 4] = ["energy", "satiety", "mood", "bond"];
/// The commands a pet is trained on, and what is counted of each.
const COMMANDS: [&str; 7] = ["come", "sit", "down", "stay", "fetch", "speak", "jump"];
const COMMAND_COUNTS: [&str; 5] = ["given", "treats", "praises", "scolds", "mastery"];
/// Training counts kept for the whole pet: feedback totals and the day's bond (for its daily cap).
const TOTALS: [&str; 6] = ["treats", "praises", "pats", "scolds", "bondDay", "bondGainedMilli"];
const MAX_COUNT: u64 = 1_000_000;
const MAX_STATS_BYTES: usize = 4096;

const MAX_NAME: usize = 12;
/// How far from the island's centre a pet's home may be, on each axis (as the game socket takes its frames).
const MAX_HOME: f64 = 200.0;
const SAVES_PER_WINDOW: u32 = 30;
const ADOPTIONS_PER_WINDOW: u32 = 10;
const VIEWS_PER_ADDRESS: u32 = 600;
const VIEWS_PER_MEMBER: u32 = 600;
const MAX_LABEL: usize = 40;
const MAX_CLIPS: usize = 32;
const STATUSES: [&str; 3] = ["draft", "published", "retired"];

const OWNER_CHANGED: ApiError = conflict("owner_changed", "계정이 바뀌어 저장을 중단했어요.");
const PET_EXISTS: ApiError = conflict("pet_exists", "이미 함께 지내는 펫이 있어요.");
const PET_NOT_FOUND: ApiError = not_found("pet_not_found", "함께 지내는 펫이 없어요.");
const PET_CHANGED: ApiError = conflict("pet_changed", "다른 곳에서 펫이 바뀌었어요. 다시 불러와 주세요.");
const BREED_UNAVAILABLE: ApiError = bad("breed_unavailable", "고를 수 없는 품종이에요.");
const INVALID_NAME: ApiError = bad("invalid_pet_name", "이름은 1~12자로, 보이는 글자로 입력해 주세요.");
const INVALID_HOME: ApiError = bad("invalid_home", "펫의 집 자리를 확인해 주세요.");
const INVALID_BRAIN: ApiError = bad("invalid_brain", "저장할 수 없는 펫 학습 기록이에요.");
const INVALID_DRIVES: ApiError = bad("invalid_drives", "저장할 수 없는 펫 상태예요.");
const INVALID_STATS: ApiError = bad("invalid_stats", "저장할 수 없는 훈련 기록이에요.");
const SAVES_BUSY: ApiError =
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "pet_saves_busy", "저장이 너무 잦아요. 잠시 뒤에 다시 저장해 주세요.");
const BREED_NOT_FOUND: ApiError = not_found("breed_not_found", "없는 품종이에요.");
const BREED_EXISTS: ApiError = conflict("breed_exists", "이미 있는 품종이에요.");
const INVALID_MODEL: ApiError = bad("invalid_model_url", "앱에 든 펫 모델(/gltf/pets/*.glb)만 등록할 수 있어요.");
const INVALID_PICTURE: ApiError =
    bad("invalid_thumbnail_url", "앱에 든 펫 그림(/gltf/pets/*.webp, *.png)만 쓸 수 있어요.");
const INVALID_HEIGHT: ApiError = bad("invalid_height", "키는 0.1~3 m로 입력해 주세요.");
const INVALID_CLIPS: ApiError = bad("invalid_clips", "애니메이션 이름을 확인해 주세요.");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pets/breeds", get(breeds))
        .route("/api/pets/me", get(mine).post(adopt).patch(update).delete(release))
        .route("/api/pets/me/brain", put(save_brain))
        .route("/api/pets/admin/breeds", get(admin_breeds).post(add_breed))
        .route("/api/pets/admin/breeds/{id}", patch(change_breed))
        .route("/api/homes/{username}/pet", get(island_pet))
}

/// FNV-1a 32 of `bytes`: how a brain names the circuit it was trained on.
const fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    let mut at = 0;
    while at < bytes.len() {
        hash = (hash ^ bytes[at] as u32).wrapping_mul(0x0100_0193);
        at += 1;
    }
    hash
}

/// A `real` column as JSON: the shortest decimal that reads back as it (0.55, not 0.550000011920929).
fn short(value: f32) -> f64 {
    value.to_string().parse().unwrap_or_default()
}

// ---- Checks

/// A saved brain: `pet-brain-v1` of the pets' shape and circuit, every readout weight finite and within
/// [`WEIGHT_LIMIT`].
fn brain(text: &str) -> ApiResult<Vec<u8>> {
    if text.len() != BRAIN_BASE64 {
        return Err(INVALID_BRAIN);
    }
    let bytes = STANDARD.decode(text).map_err(|_| INVALID_BRAIN)?;
    if brain_fits(&bytes) { Ok(bytes) } else { Err(INVALID_BRAIN) }
}

fn brain_fits(bytes: &[u8]) -> bool {
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    bytes.len() == BRAIN_BYTES
        && bytes[..4] == BRAIN_MAGIC[..]
        && u16_at(4) == BRAIN_VERSION
        && (u16_at(6), u16_at(8), u16_at(10)) == (SENSES, ACTIONS, FEATURES)
        && u32_at(12) == GRAPH_HASH
        && bytes[BRAIN_HEADER..].chunks_exact(4).all(|weight| {
            let weight = f32::from_le_bytes([weight[0], weight[1], weight[2], weight[3]]);
            weight.is_finite() && weight.abs() <= WEIGHT_LIMIT
        })
}

/// Drives: exactly [`DRIVES`], each 0..1.
fn drives(value: &Value) -> ApiResult<()> {
    let fits = value.as_object().is_some_and(|fields| {
        fields.len() == DRIVES.len()
            && DRIVES
                .iter()
                .all(|key| fields.get(*key).and_then(Value::as_f64).is_some_and(|v| (0.0..=1.0).contains(&v)))
    });
    if fits { Ok(()) } else { Err(INVALID_DRIVES) }
}

/// Whole counts from 0 up to `max`.
fn count(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|count| count <= max)
}

/// Training counts: the whole pet's [`TOTALS`] and, under `commands`, each command's [`COMMAND_COUNTS`] (`mastery` in
/// percent), all whole and up to [`MAX_COUNT`] (`bondGainedMilli` up to 1000), nothing else, within
/// [`MAX_STATS_BYTES`].
fn stats(value: &Value) -> ApiResult<()> {
    let command = |value: &Value| {
        value.as_object().is_some_and(|counts| {
            counts.iter().all(|(key, value)| {
                COMMAND_COUNTS.contains(&key.as_str()) && count(value, if key == "mastery" { 100 } else { MAX_COUNT })
            })
        })
    };
    let fits = value.as_object().is_some_and(|fields| {
        fields.iter().all(|(key, value)| match key.as_str() {
            "commands" => value.as_object().is_some_and(|commands| {
                commands.iter().all(|(name, counts)| COMMANDS.contains(&name.as_str()) && command(counts))
            }),
            "bondGainedMilli" => count(value, 1000),
            key => TOTALS.contains(&key) && count(value, MAX_COUNT),
        })
    });
    if fits && value.to_string().len() <= MAX_STATS_BYTES { Ok(()) } else { Err(INVALID_STATS) }
}

/// A character that shows nothing on a name tag: format characters (direction overrides, invisible marks; an emoji's
/// joiner aside), Hangul fillers and the blank braille pattern.
fn draws_nothing(c: char) -> bool {
    (c.general_category() == GeneralCategory::Format && c != '\u{200d}')
        || matches!(c, '\u{115f}' | '\u{1160}' | '\u{3164}' | '\u{ffa0}' | '\u{2800}')
}

/// A pet's name as it is kept: trimmed, 1 to [`MAX_NAME`] characters, each one that shows.
fn pet_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_NAME || !plain_text(name, false) || name.chars().any(draws_nothing) {
        return Err(INVALID_NAME);
    }
    Ok(name.to_owned())
}

/// Where a pet rests on its island's ground.
#[derive(Clone, Copy, Deserialize)]
struct Home {
    x: f64,
    z: f64,
}

fn home(home: Home) -> ApiResult<(f32, f32)> {
    let fits = |v: f64| v.is_finite() && v.abs() <= MAX_HOME;
    if fits(home.x) && fits(home.z) { Ok((home.x as f32, home.z as f32)) } else { Err(INVALID_HOME) }
}

/// Refuses a change that a page loaded for another account sends.
fn same_owner(expected: Option<Uuid>, owner: Uuid) -> ApiResult<()> {
    if expected == Some(owner) { Ok(()) } else { Err(OWNER_CHANGED) }
}

/// Why a change that matched no pet of the member's changed nothing: they have another one, or none.
async fn missing(state: &AppState, owner: Uuid) -> ApiResult<ApiError> {
    let has: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pets WHERE owner_id = $1)")
        .bind(owner)
        .fetch_one(&state.db)
        .await?;
    Ok(if has { PET_CHANGED } else { PET_NOT_FOUND })
}

// ---- Breeds

const BREED_COLUMNS: &str = "b.id AS breed_id, b.label, b.emoji, b.model_url, b.thumbnail_url, b.clips, b.height_m";

/// A breed as pages draw it: its model, picture, clips and the height the engine draws it at.
fn breed(row: &PgRow) -> Value {
    json!({
        "id": row.get::<String, _>("breed_id"),
        "label": row.get::<String, _>("label"),
        "emoji": row.get::<String, _>("emoji"),
        "modelUrl": row.get::<String, _>("model_url"),
        "thumbnailUrl": row.get::<Option<String>, _>("thumbnail_url"),
        "clips": row.get::<Vec<String>, _>("clips"),
        "heightM": short(row.get("height_m")),
    })
}

/// `GET /api/pets/breeds`: the breeds anyone may adopt, in their order.
async fn breeds(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        "SELECT {BREED_COLUMNS} FROM pet_breeds b WHERE b.status = 'published' ORDER BY b.sort_order, b.id"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({"breeds": rows.iter().map(breed).collect::<Vec<_>>()})))
}

// ---- Pets

const PET_COLUMNS: &str = "p.id, p.name, p.home_x, p.home_z";
const OWN_COLUMNS: &str =
    "p.seed, p.brain_model, p.graph_id, p.brain, p.drives, p.stats, p.revision, p.created_at, p.updated_at";

/// A pet as anyone who may view its island sees it: its name, breed and home.
fn pet(row: &PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "name": row.get::<String, _>("name"),
        "breed": row.get::<String, _>("breed_id"),
        "breedInfo": breed(row),
        "home": {"x": short(row.get("home_x")), "z": short(row.get("home_z"))},
    })
}

/// A pet as its owner's page runs it: with its seed, circuit and brain format, its saved brain (standard base64, null
/// until a first save), drives and stats, the revision the next save names, and when they were saved (`updatedAt`).
fn own_pet(row: &PgRow) -> Value {
    let mut value = pet(row);
    value["seed"] = json!(row.get::<i64, _>("seed"));
    value["graphId"] = json!(row.get::<String, _>("graph_id"));
    value["model"] = json!(row.get::<String, _>("brain_model"));
    value["brain"] = json!(row.get::<Option<Vec<u8>>, _>("brain").map(|bytes| STANDARD.encode(bytes)));
    value["drives"] = row.get::<Value, _>("drives");
    value["stats"] = row.get::<Value, _>("stats");
    value["revision"] = json!(row.get::<i64, _>("revision"));
    value["createdAt"] = json!(row.get::<DateTime<Utc>, _>("created_at"));
    value["updatedAt"] = json!(row.get::<DateTime<Utc>, _>("updated_at"));
    value
}

async fn own(state: &AppState, owner: Uuid) -> ApiResult<Option<Value>> {
    let row = sqlx::query(&format!(
        "SELECT {PET_COLUMNS}, {OWN_COLUMNS}, {BREED_COLUMNS} FROM pets p JOIN pet_breeds b ON b.id = p.breed_id
         WHERE p.owner_id = $1"
    ))
    .bind(owner)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.as_ref().map(own_pet))
}

/// `GET /api/pets/me`.
async fn mine(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    Ok(Json(json!({"pet": own(&state, user.id).await?})))
}

/// `GET /api/homes/{username}/pet`: whoever may view the island (see [`visible_home`]) sees its pet. Reads are counted
/// per address for visitors and per member for members.
async fn island_pet(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    match &viewer {
        None => rate_limit(&state, format!("pet-view:{}", client_address(&headers)), VIEWS_PER_ADDRESS)?,
        Some(user) => rate_limit(&state, format!("pet-view-member:{}", user.id), VIEWS_PER_MEMBER)?,
    }
    let (home, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let row = sqlx::query(&format!(
        "SELECT {PET_COLUMNS}, {BREED_COLUMNS} FROM pets p JOIN pet_breeds b ON b.id = p.breed_id WHERE p.owner_id = $1"
    ))
    .bind(home.owner_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(json!({"pet": row.as_ref().map(pet)})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Adoption {
    /// The account the page was loaded for. A missing value must refuse the change.
    expected_owner_id: Option<Uuid>,
    breed_id: String,
    name: String,
    home: Home,
}

/// `POST /api/pets/me`: adopts a published breed as the member's one pet, at `home`; 201 with the pet as
/// [`own_pet`]. Its seed is a random u32 the server picks.
async fn adopt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Adoption>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    let name = pet_name(&body.name)?;
    let (x, z) = home(body.home)?;
    let breed = catalog::catalog_id(&body.breed_id).map_err(|_| BREED_UNAVAILABLE)?;
    rate_limit(&state, format!("pet-adopt:{}", user.id), ADOPTIONS_PER_WINDOW)?;
    let seed = i64::from(rand::random::<u32>());
    let adopted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO pets (id, owner_id, breed_id, name, home_x, home_z, seed, brain_model, graph_id)
         SELECT $1, $2, b.id, $4, $5, $6, $7, $8, $9 FROM pet_breeds b WHERE b.id = $3 AND b.status = 'published'
         ON CONFLICT (owner_id) DO NOTHING RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(breed)
    .bind(&name)
    .bind(x)
    .bind(z)
    .bind(seed)
    .bind(BRAIN_MODEL)
    .bind(GRAPH_ID)
    .fetch_optional(&state.db)
    .await?;
    if adopted.is_none() {
        let has: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pets WHERE owner_id = $1)")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
        return Err(if has { PET_EXISTS } else { BREED_UNAVAILABLE });
    }
    let pet = own(&state, user.id).await?.ok_or(PET_NOT_FOUND)?;
    Ok((StatusCode::CREATED, Json(json!({"pet": pet}))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    expected_owner_id: Option<Uuid>,
    /// The pet the page has; a change for another one (released and adopted again elsewhere) is refused.
    pet_id: Option<Uuid>,
    name: Option<String>,
    home: Option<Home>,
}

/// `PATCH /api/pets/me`: a new name, home, or both, answered with the pet as [`own_pet`]. Neither is part of the
/// brain's revision, so the page's next brain save still names the one it has.
async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(changes): Json<Changes>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(changes.expected_owner_id, user.id)?;
    let name = changes.name.as_deref().map(pet_name).transpose()?;
    let home = changes.home.map(home).transpose()?;
    let changed = sqlx::query(
        "UPDATE pets SET name = COALESCE($3, name), home_x = COALESCE($4, home_x), home_z = COALESCE($5, home_z)
         WHERE owner_id = $1 AND ($2::uuid IS NULL OR id = $2)",
    )
    .bind(user.id)
    .bind(changes.pet_id)
    .bind(name)
    .bind(home.map(|(x, _)| x))
    .bind(home.map(|(_, z)| z))
    .execute(&state.db)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(missing(&state, user.id).await?);
    }
    Ok(Json(json!({"pet": own(&state, user.id).await?})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainSave {
    expected_owner_id: Option<Uuid>,
    pet_id: Option<Uuid>,
    /// The revision the page loaded or last saved.
    revision: i64,
    /// Standard base64 of the `pet-brain-v1` bytes. Each of `brain`, `drives` and `stats` left out (or null) keeps what
    /// is stored.
    brain: Option<String>,
    drives: Option<Value>,
    stats: Option<Value>,
}

/// `PUT /api/pets/me/brain`: stores the brain, drives and stats when the stored pet is still at `revision` (and is
/// `petId`, when given), and answers `{revision, updatedAt}`; another page's save in between makes it `pet_changed`.
/// Thirty saves in ten minutes per member. The body is a few kilobytes, so a page that is being hidden or closed sends
/// it with `fetch(…, {keepalive: true})`.
async fn save_brain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(save): Json<BrainSave>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(save.expected_owner_id, user.id)?;
    rate_limit(&state, format!("pet-save:{}", user.id), SAVES_PER_WINDOW)
        .map_err(|error| if error.status == StatusCode::TOO_MANY_REQUESTS { SAVES_BUSY } else { error })?;
    let brain = save.brain.as_deref().map(brain).transpose()?;
    if let Some(value) = &save.drives {
        drives(value)?;
    }
    if let Some(value) = &save.stats {
        stats(value)?;
    }
    let saved: Option<(i64, DateTime<Utc>)> = sqlx::query_as(
        "UPDATE pets SET brain = COALESCE($4, brain), drives = COALESCE($5, drives), stats = COALESCE($6, stats),
           revision = revision + 1, updated_at = now()
         WHERE owner_id = $1 AND revision = $2 AND ($3::uuid IS NULL OR id = $3) RETURNING revision, updated_at",
    )
    .bind(user.id)
    .bind(save.revision)
    .bind(save.pet_id)
    .bind(brain)
    .bind(save.drives)
    .bind(save.stats)
    .fetch_optional(&state.db)
    .await?;
    let Some((revision, updated_at)) = saved else { return Err(missing(&state, user.id).await?) };
    Ok(Json(json!({"revision": revision, "updatedAt": updated_at})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    expected_owner_id: Option<Uuid>,
    pet_id: Option<Uuid>,
}

/// `DELETE /api/pets/me`: lets the pet go, its brain and records with it; 204.
async fn release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Release>,
) -> ApiResult<StatusCode> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    let gone = sqlx::query("DELETE FROM pets WHERE owner_id = $1 AND ($2::uuid IS NULL OR id = $2)")
        .bind(user.id)
        .bind(body.pet_id)
        .execute(&state.db)
        .await?;
    if gone.rows_affected() == 0 {
        return Err(missing(&state, user.id).await?);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- Breeds for the catalog's editors

const ADMIN_SELECT: &str =
    "SELECT b.id AS breed_id, b.label, b.emoji, b.model_url, b.thumbnail_url, b.clips, b.height_m,
    b.species, b.source, b.source_ref, b.status, b.sort_order, b.created_at, b.updated_at,
    (SELECT count(*) FROM pets p WHERE p.breed_id = b.id) AS pets FROM pet_breeds b";

/// A breed with what the editors' screen shows: where it came from, its status and order, and how many pets are of it.
fn admin_breed(row: &PgRow) -> Value {
    let mut value = breed(row);
    value["species"] = json!(row.get::<String, _>("species"));
    value["source"] = json!(row.get::<String, _>("source"));
    value["sourceRef"] = json!(row.get::<Option<String>, _>("source_ref"));
    value["status"] = json!(row.get::<String, _>("status"));
    value["sortOrder"] = json!(row.get::<i32, _>("sort_order"));
    value["pets"] = json!(row.get::<i64, _>("pets"));
    value["createdAt"] = json!(row.get::<DateTime<Utc>, _>("created_at"));
    value["updatedAt"] = json!(row.get::<DateTime<Utc>, _>("updated_at"));
    value
}

async fn admin_one(state: &AppState, id: &str) -> ApiResult<Value> {
    let row = sqlx::query(&format!("{ADMIN_SELECT} WHERE b.id = $1")).bind(id).fetch_optional(&state.db).await?;
    row.as_ref().map(admin_breed).ok_or(BREED_NOT_FOUND)
}

/// `GET /api/pets/admin/breeds`: every breed, published or not.
async fn admin_breeds(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let rows = sqlx::query(&format!("{ADMIN_SELECT} ORDER BY b.sort_order, b.id")).fetch_all(&state.db).await?;
    Ok(Json(json!({"breeds": rows.iter().map(admin_breed).collect::<Vec<_>>()})))
}

fn status(value: Option<String>) -> ApiResult<Option<String>> {
    match value {
        Some(status) if !STATUSES.contains(&status.as_str()) => Err(bad("invalid_status", "상태를 확인해 주세요.")),
        other => Ok(other),
    }
}

fn height(value: Option<f64>) -> ApiResult<Option<f32>> {
    match value {
        Some(height) if !(0.1..=3.0).contains(&height) => Err(INVALID_HEIGHT),
        other => Ok(other.map(|height| height as f32)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BreedChanges {
    label: Option<String>,
    emoji: Option<String>,
    status: Option<String>,
    sort_order: Option<i32>,
    height_m: Option<f64>,
}

/// `PATCH /api/pets/admin/breeds/{id}`: a breed's name, emoji, status (`draft`, `published`, `retired`), order or
/// height. Pets of a breed taken off the list keep it.
async fn change_breed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(changes): Json<BreedChanges>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = catalog::catalog_id(&id).map_err(|_| BREED_NOT_FOUND)?;
    let changed = sqlx::query(
        "UPDATE pet_breeds SET label = COALESCE($2, label), emoji = COALESCE($3, emoji), status = COALESCE($4, status),
         sort_order = COALESCE($5, sort_order), height_m = COALESCE($6, height_m), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(changes.label.as_deref().map(|v| catalog::label(v, MAX_LABEL, "invalid_label")).transpose()?)
    .bind(changes.emoji.as_deref().map(|v| catalog::label(v, 16, "invalid_emoji")).transpose()?)
    .bind(status(changes.status)?)
    .bind(changes.sort_order)
    .bind(height(changes.height_m)?)
    .execute(&state.db)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(BREED_NOT_FOUND);
    }
    Ok(Json(admin_one(&state, id).await?))
}

/// A file the app ships under `/gltf/pets/`: a lowercase slug with one of `extensions`.
fn packaged(url: &str, extensions: &[&str]) -> bool {
    let Some((slug, extension)) = url.strip_prefix("/gltf/pets/").and_then(|file| file.split_once('.')) else {
        return false;
    };
    catalog::catalog_id(slug).is_ok() && extensions.contains(&extension)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewBreed {
    id: String,
    label: String,
    emoji: Option<String>,
    model_url: String,
    thumbnail_url: Option<String>,
    #[serde(default)]
    clips: Vec<String>,
    height_m: Option<f64>,
    sort_order: Option<i32>,
    status: Option<String>,
}

/// `POST /api/pets/admin/breeds`: a breed whose model the app ships (`/gltf/pets/<slug>.glb`, a picture beside it),
/// a draft unless `status` says otherwise; 201 with the breed.
async fn add_breed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NewBreed>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = catalog::catalog_id(&body.id)?;
    let label = catalog::label(&body.label, MAX_LABEL, "invalid_label")?;
    let emoji = body.emoji.as_deref().map(|v| catalog::label(v, 16, "invalid_emoji")).transpose()?;
    if !packaged(&body.model_url, &["glb"]) {
        return Err(INVALID_MODEL);
    }
    if body.thumbnail_url.as_deref().is_some_and(|url| !packaged(url, &["webp", "png"])) {
        return Err(INVALID_PICTURE);
    }
    let clip =
        |name: &String| (1..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if body.clips.len() > MAX_CLIPS || !body.clips.iter().all(clip) {
        return Err(INVALID_CLIPS);
    }
    let added: Option<String> = sqlx::query_scalar(
        "INSERT INTO pet_breeds (id, label, emoji, model_url, thumbnail_url, clips, height_m, source, status,
           sort_order)
         VALUES ($1, $2, COALESCE($3, '🐶'), $4, $5, $6, COALESCE($7, 0.55), 'builtin', COALESCE($8, 'draft'),
           COALESCE($9, 100))
         ON CONFLICT (id) DO NOTHING RETURNING id",
    )
    .bind(id)
    .bind(label)
    .bind(emoji)
    .bind(&body.model_url)
    .bind(&body.thumbnail_url)
    .bind(&body.clips)
    .bind(height(body.height_m)?)
    .bind(status(body.status)?)
    .bind(body.sort_order)
    .fetch_optional(&state.db)
    .await?;
    if added.is_none() {
        return Err(BREED_EXISTS);
    }
    Ok((StatusCode::CREATED, Json(admin_one(&state, id).await?)))
}

// ---- The game socket's relay

/// The largest pet frame the island's game socket relays, as JSON.
pub(crate) const MAX_FRAME_BYTES: usize = 512;
/// How far a relayed pet may be from the island's centre on the ground, and below and above it.
const FRAME_REACH: f64 = 200.0;
const FRAME_DEPTH: f64 = 50.0;
const FRAME_HEIGHT: f64 = 300.0;
const FRAME_SPEED: f64 = 30.0;
/// What a relayed pet may be playing, held or looped, and the one-off gestures it may make.
const FRAME_CLIPS: [&str; 7] = ["idle", "walk", "run", "sit_hold", "lie_hold", "sit", "lie"];
const FRAME_GESTURES: [&str; 4] = ["bark", "jump", "sit", "lie"];

fn finite(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|value| value.is_finite())
}

fn frame_point(value: Option<&Value>) -> Option<[f64; 3]> {
    let [x, y, z] = value?.as_array()?.as_slice() else { return None };
    let (x, y, z) = (finite(Some(x))?, finite(Some(y))?, finite(Some(z))?);
    let fits = x.abs() <= FRAME_REACH && z.abs() <= FRAME_REACH && (-FRAME_DEPTH..=FRAME_HEIGHT).contains(&y);
    fits.then_some([x, y, z])
}

/// A pet frame from its owner's page as the island's game socket sends it on: `{id, t, at, ry, move, speed, clip,
/// gesture, ball}` with each field checked and nothing else kept, or None when one is missing or out of range or the
/// frame is past [`MAX_FRAME_BYTES`]. `gesture` is null or `{clip, at}` (a page plays it when `at` changes), `ball`
/// null or `{at, held}`.
pub(crate) fn relay_frame(frame: &Value) -> Option<Value> {
    let fields: &Map<String, Value> = frame.as_object()?;
    if frame.to_string().len() > MAX_FRAME_BYTES {
        return None;
    }
    let id = fields.get("id")?.as_str().and_then(|id| Uuid::parse_str(id).ok())?;
    let speed = finite(fields.get("speed")).filter(|speed| (0.0..=FRAME_SPEED).contains(speed))?;
    let clip = fields.get("clip")?.as_str().filter(|clip| FRAME_CLIPS.contains(clip))?;
    let gesture = match fields.get("gesture") {
        None | Some(Value::Null) => Value::Null,
        Some(gesture) => {
            let clip = gesture.get("clip")?.as_str().filter(|clip| FRAME_GESTURES.contains(clip))?;
            json!({"clip": clip, "at": finite(gesture.get("at"))?})
        }
    };
    let ball = match fields.get("ball") {
        None | Some(Value::Null) => Value::Null,
        Some(ball) => json!({"at": frame_point(ball.get("at"))?, "held": ball.get("held")?.as_bool()?}),
    };
    Some(json!({
        "id": id,
        "t": finite(fields.get("t"))?,
        "at": frame_point(fields.get("at"))?,
        "ry": finite(fields.get("ry"))?,
        "move": fields.get("move")?.as_bool()?,
        "speed": speed,
        "clip": clip,
        "gesture": gesture,
        "ball": ball,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A brain as the page's codec writes it, every weight `weight`.
    fn brain_bytes(weight: f32) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(BRAIN_BYTES);
        bytes.extend_from_slice(b"MGPB");
        for value in [BRAIN_VERSION, SENSES, ACTIONS, FEATURES] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [GRAPH_HASH, 0x1234_5678, 42] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for _ in 0..usize::from(ACTIONS) * usize::from(FEATURES) {
            bytes.extend_from_slice(&weight.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn the_circuit_is_named_as_the_page_hashes_it() {
        // frontend/src/pets/brain/graph.ts `graphHash(PET_GRAPH_ID)`.
        assert_eq!(GRAPH_HASH, 0x7472_dea7);
        assert_eq!((BRAIN_BYTES, BRAIN_BASE64), (5184, 6912));
    }

    #[test]
    fn only_a_brain_of_the_pets_shape_circuit_and_bounds_is_kept() {
        let good = brain_bytes(-12.0);
        assert!(brain(&STANDARD.encode(&good)).is_ok());
        assert!(brain(&STANDARD.encode(&good[..BRAIN_BYTES - 4])).is_err(), "too short");
        assert!(brain(&format!("{}====", STANDARD.encode(&good[..BRAIN_BYTES - 3]))).is_err(), "not base64");
        let changed = |at: usize, value: &[u8]| {
            let mut bytes = good.clone();
            bytes[at..at + value.len()].copy_from_slice(value);
            STANDARD.encode(bytes)
        };
        for (at, value) in [
            (0, &b"MGPC"[..]),
            (4, &2u16.to_le_bytes()[..]),
            (6, &21u16.to_le_bytes()[..]),
            (8, &11u16.to_le_bytes()[..]),
            (10, &128u16.to_le_bytes()[..]),
            (12, &fnv1a(b"another-circuit").to_le_bytes()[..]),
            (BRAIN_HEADER, &f32::NAN.to_le_bytes()[..]),
            (BRAIN_BYTES - 4, &f32::INFINITY.to_le_bytes()[..]),
            (BRAIN_HEADER + 40, &12.001f32.to_le_bytes()[..]),
        ] {
            assert_eq!(brain(&changed(at, value)).unwrap_err().code, "invalid_brain", "offset {at}");
        }
        // The RNG state and the update count are the page's own.
        assert!(brain(&changed(16, &u32::MAX.to_le_bytes())).is_ok());
    }

    #[test]
    fn drives_are_the_four_the_page_keeps_each_from_zero_to_one() {
        assert!(drives(&json!({"energy": 1, "satiety": 0.2, "mood": 0.6, "bond": 0})).is_ok());
        for wrong in [
            json!({"energy": 1, "satiety": 0.2, "mood": 0.6}),
            json!({"energy": 1, "satiety": 0.2, "mood": 0.6, "bond": 1.01}),
            json!({"energy": 1, "satiety": 0.2, "mood": 0.6, "bond": -0.1}),
            json!({"energy": 1, "satiety": 0.2, "mood": 0.6, "bond": "0.5"}),
            json!({"energy": 1, "satiety": 0.2, "mood": 0.6, "bond": 0.5, "extra": 0}),
            json!([1, 0.2, 0.6, 0.5]),
        ] {
            assert_eq!(drives(&wrong).unwrap_err().code, "invalid_drives", "{wrong}");
        }
    }

    #[test]
    fn stats_hold_whole_counts_of_known_names_only() {
        let full = json!({
            "bondDay": 20_368, "bondGainedMilli": 1000, "treats": 12, "praises": 3, "pats": 4, "scolds": 1,
            "commands": {"sit": {"given": 20, "treats": 9, "praises": 2, "scolds": 1, "mastery": 85}, "come": {}},
        });
        assert!(stats(&full).is_ok());
        assert!(stats(&json!({})).is_ok());
        for wrong in [
            json!({"bondGainedMilli": 1001}),
            json!({"treats": 1.5}),
            json!({"treats": -1}),
            json!({"treats": 1_000_001}),
            json!({"lastTreatAt": 1}),
            json!({"commands": {"roll": {"given": 1}}}),
            json!({"commands": {"sit": {"given": 1, "note": 2}}}),
            json!({"commands": {"sit": {"mastery": 101}}}),
            json!({"commands": {"sit": 3}}),
            json!({"note": "<b>"}),
            json!([]),
        ] {
            assert_eq!(stats(&wrong).unwrap_err().code, "invalid_stats", "{wrong}");
        }
    }

    #[test]
    fn names_are_short_and_show_every_character() {
        assert_eq!(pet_name("  초코 ").unwrap(), "초코");
        assert_eq!(pet_name("가나다라마바사아자차카타").unwrap().chars().count(), 12);
        assert!(pet_name("👩\u{200d}💻").is_ok());
        for wrong in ["", "   ", "가나다라마바사아자차카타파", "초\n코", "초\u{202e}코", "\u{3164}", "초\u{200b}코"]
        {
            assert_eq!(pet_name(wrong).unwrap_err().code, "invalid_pet_name", "{wrong:?}");
        }
    }

    #[test]
    fn homes_and_packaged_files_stay_in_bounds() {
        assert_eq!(home(Home { x: -200.0, z: 3.5 }).unwrap(), (-200.0, 3.5));
        assert!(home(Home { x: 200.1, z: 0.0 }).is_err());
        assert!(home(Home { x: f64::NAN, z: 0.0 }).is_err());
        assert!(packaged("/gltf/pets/shiba-inu.glb", &["glb"]));
        assert!(!packaged("/gltf/pets/shiba-inu.webp", &["glb"]));
        assert!(!packaged("/models/aaaa.glb", &["glb"]));
        assert!(!packaged("/gltf/pets/../decor/x.glb", &["glb"]));
        assert!(!packaged("/gltf/pets/Shiba.glb", &["glb"]));
        assert_eq!(short(0.55), 0.55);
    }

    fn frame() -> Value {
        json!({"id": Uuid::nil(), "t": 12345.6, "at": [3.2, 0.1, -4.0], "ry": 1.57, "move": true, "speed": 3.0,
            "clip": "walk", "gesture": null, "ball": {"at": [5.0, 0.15, -2.0], "held": false}})
    }

    #[test]
    fn relayed_frames_keep_their_checked_fields_only() {
        assert_eq!(relay_frame(&frame()), Some(frame()));
        let mut extra = frame();
        extra["note"] = json!("dropped");
        extra["gesture"] = json!({"clip": "bark", "at": 12000.5, "loud": true});
        extra.as_object_mut().unwrap().remove("ball");
        let relayed = relay_frame(&extra).unwrap();
        assert!(relayed.get("note").is_none());
        assert_eq!(relayed["gesture"], json!({"clip": "bark", "at": 12000.5}));
        assert_eq!(relayed["ball"], Value::Null);
        for (field, wrong) in [
            ("id", json!("pet")),
            ("t", json!("now")),
            ("at", json!([200.5, 0.0, 0.0])),
            ("at", json!([0.0, -50.5, 0.0])),
            ("at", json!([0.0, 300.5, 0.0])),
            ("at", json!([0.0, 0.0])),
            ("ry", Value::Null),
            ("move", json!(1)),
            ("speed", json!(30.5)),
            ("speed", json!(-1)),
            ("clip", json!("dance")),
            ("gesture", json!({"clip": "walk", "at": 1})),
            ("gesture", json!({"clip": "bark"})),
            ("ball", json!({"at": [0.0, 0.0, 201.0], "held": false})),
            ("ball", json!({"at": [0.0, 0.0, 0.0]})),
        ] {
            let mut wrong_frame = frame();
            wrong_frame[field] = wrong;
            assert_eq!(relay_frame(&wrong_frame), None, "{field}: {}", wrong_frame[field]);
        }
        let mut long = frame();
        long["padding"] = json!("x".repeat(MAX_FRAME_BYTES));
        assert_eq!(relay_frame(&long), None, "past 512 bytes");
        assert_eq!(relay_frame(&json!([1, 2])), None);
    }
}
