//! How a member dresses the island of their 사주 home: the things they place on it (their own 자미두수 flag, flags other
//! members gave them, small props, their studio character) and the flags themselves.
//!
//! Whoever may see the home ([`visible_home`]) sees what is placed on its island; only its owner places things, all of
//! them in one save. A member with a 사주 home of their own may give another member's home a flag, one a day by
//! Seoul's calendar, and the home's owner may take it down again, from wherever it was placed too.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value, json};
use sqlx::{PgConnection, Row, postgres::PgRow};
use std::collections::{BTreeSet, HashSet};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{current_user, optional_user},
    error::{ApiError, ApiResult, conflict, internal, not_found},
    homes::{TODAY, same_owner, visible_home},
    security::rate_limit,
};

/// Things one island holds at once.
const MAX_ITEMS: usize = 24;
/// An item's id: 1 to this many letters, digits, `_` or `-`.
const ID_MAX: usize = 40;
/// How far from the island's middle a thing may stand, along x and along z, and how far it may be turned either way.
const REACH: f64 = 40.0;
const MAX_TURN: f64 = 7.0;
/// What a flag item shows that is not a flag given to the owner: their own.
const MINE: &str = "mine";
/// What the character item shows: the owner's own character.
const ME: &str = "me";
/// What the board item shows: the home's photo board.
const BOARD: &str = "photo";
/// The props the app has models for.
const PROPS: &[&str] = &[
    "lantern",
    "bench",
    "jar",
    "pot",
    "barrel",
    "woodpile",
    "table",
    "parasol",
    "well",
    "bush",
    "rock",
    "tree",
    "pine-bonsai",
    "bamboo-wheel",
    "plum-planter",
    "lotus-lamp",
    "copper-brazier",
    "vermilion-lamp",
    "ochre-cairn",
    "harvest-jar",
    "clay-peaks",
    "silver-bell",
    "silver-crane",
    "gold-sphere",
    "lotus-basin",
    "rain-spout",
    "koi-fountain",
];
/// What a flag may show: the 14 main stars of 자미두수, and 공궁 for a life palace without one.
const STARS: [&str; 15] = [
    "자미", "천기", "태양", "무곡", "천동", "염정", "천부", "태음", "탐랑", "거문", "천상", "천량", "칠살", "파군",
    "공궁",
];
const ELEMENTS: [&str; 5] = ["wood", "fire", "earth", "metal", "water"];
/// Flags a home's owner reads of their own: the newest this many, and the placed ones besides.
const OWNER_FLAGS: i64 = 100;
/// Decor saves of one member in the rate window (ten minutes).
const SAVES_PER_MEMBER: u32 = 60;
/// Flags one member may give in the rate window (ten minutes).
const GIFTS_PER_MEMBER: u32 = 30;

const INVALID_DECOR: ApiError = ApiError::new(StatusCode::BAD_REQUEST, "invalid_decor", "꾸밈을 확인해 주세요.");
const INVALID_FLAG: ApiError = ApiError::new(StatusCode::BAD_REQUEST, "invalid_flag", "깃발을 확인해 주세요.");
const OWN_HOME: ApiError = ApiError::new(StatusCode::BAD_REQUEST, "own_home", "내 집에는 깃발을 보낼 수 없어요.");
const NO_HOME: ApiError = conflict("no_home", "아직 지은 사주 집이 없어요.");
const GIVER_NO_HOME: ApiError = conflict("no_home", "내 사주 집을 지어야 깃발을 보낼 수 있어요.");
const OWNER_NO_HOME: ApiError = conflict("no_home", "아직 사주 집을 짓지 않은 섬이에요.");
const ALREADY_GIVEN: ApiError = conflict("already_given", "오늘은 이미 깃발을 보냈어요.");
const NO_FLAG: ApiError = not_found("flag_not_found", "없는 깃발이에요.");

/// What [`flag`] reads of a flag (`f`) and its giver (`u`).
const FLAG_COLUMNS: &str = "f.id, f.star, f.element, f.created_at, u.username, u.display_name";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes/me/saju/decor", put(save))
        .route("/api/homes/me/saju/flags/{id}", delete(take_down))
        .route("/api/homes/{username}/saju/decor", get(view))
        .route("/api/homes/{username}/saju/flags", post(give))
}

/// What a placed thing is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    /// The owner's own flag ([`MINE`]), or one given to them (its id).
    Flag,
    /// The id of a compatibility keepsake delivered to this owner.
    Gift,
    /// One of [`PROPS`].
    Prop,
    /// The owner's character ([`ME`]).
    Character,
    /// The photo board ([`BOARD`]), where its owner put it.
    Board,
}

/// One thing on the island, as the app placed it: what it is (`kind`) and shows (`ref`), where it stands (`x`, `z`)
/// and how it is turned (`turn`). The numbers are kept as they came; fields this server does not know are not kept.
#[derive(Deserialize, Serialize)]
struct Item {
    id: String,
    kind: Kind,
    #[serde(rename = "ref")]
    reference: String,
    x: Number,
    z: Number,
    turn: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scale: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

/// The flag given to the owner that a flag item's `ref` names, written as the server writes ids. None for their own
/// flag ([`MINE`]) and for anything else.
fn given_flag(reference: &str) -> Option<Uuid> {
    Uuid::parse_str(reference).ok().filter(|id| id.to_string() == reference)
}

/// A save's items, when each of them may stand on the island: at most [`MAX_ITEMS`], each with an id of its own, a kind
/// and what it shows (a flag [`MINE`] or given to the owner, one of [`PROPS`], the one character [`ME`]), within
/// [`REACH`] and turned at most [`MAX_TURN`]. Whether the flags named were given to the owner is the database's to say
/// (in [`save`]).
fn checked(items: Value) -> ApiResult<Vec<Item>> {
    let items: Vec<Item> = serde_json::from_value(items).map_err(|_| INVALID_DECOR)?;
    let single = |kind: Kind| items.iter().filter(|item| item.kind == kind).count() > 1;
    if items.len() > MAX_ITEMS || single(Kind::Character) || single(Kind::Board) {
        return Err(INVALID_DECOR);
    }
    let within = |number: &Number, most: f64| number.as_f64().is_some_and(|v| v.is_finite() && v.abs() <= most);
    let mut ids = HashSet::new();
    for item in &items {
        let id = &item.id;
        let named =
            (1..=ID_MAX).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b));
        let shows = match item.kind {
            Kind::Flag => item.reference == MINE || given_flag(&item.reference).is_some(),
            Kind::Gift => given_flag(&item.reference).is_some(),
            Kind::Prop => PROPS.contains(&item.reference.as_str()),
            Kind::Character => item.reference == ME,
            Kind::Board => item.reference == BOARD,
        };
        let placed = within(&item.x, REACH) && within(&item.z, REACH) && within(&item.turn, MAX_TURN);
        let sized = item.scale.as_ref().is_none_or(|n| n.as_f64().is_some_and(|v| (0.5..=2.0).contains(&v)));
        let dyed = item.color.as_ref().is_none_or(|color| {
            color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        });
        if !named || !ids.insert(id.as_str()) || !shows || !placed || !sized || !dyed {
            return Err(INVALID_DECOR);
        }
    }
    Ok(items)
}

/// A flag as the app reads it: who gave it, what it shows and when.
fn flag(row: &PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "giver": {"username": row.get::<String, _>("username"), "name": row.get::<String, _>("display_name")},
        "design": {"star": row.get::<String, _>("star"), "element": row.get::<String, _>("element")},
        "givenAt": row.get::<DateTime<Utc>, _>("created_at"),
    })
}

/// `owner`'s decor as its owner (`own`) or anyone else reads it: the things placed (`items`); the flags placed, and for
/// the owner the newest [`OWNER_FLAGS`] given besides, the newest first (`flags`); and the owner's character when their
/// look is ready with a model (`character`), for anyone else only once it is placed.
pub(super) async fn shown(db: &mut PgConnection, owner: Uuid, own: bool) -> Result<Value, sqlx::Error> {
    let (items, terrain, tiles, board): (Value, String, Value, Option<Value>) = sqlx::query_as(
        "SELECT COALESCE(d.items, '[]'::jsonb), COALESCE(d.terrain, 'default'), COALESCE(d.tiles, '[]'::jsonb),
          CASE WHEN b.version IS NOT NULL THEN jsonb_build_object('version', b.version, 'width', b.width, 'height', b.height) END
         FROM (SELECT $1::uuid AS owner_id) o LEFT JOIN saju_decor d USING (owner_id)
         LEFT JOIN saju_photo_boards b USING (owner_id)",
    )
        .bind(owner)
        .fetch_one(&mut *db)
        .await?;
    let placed = items.as_array().map_or(&[][..], Vec::as_slice);
    let named: Vec<Uuid> = placed
        .iter()
        .filter(|item| item["kind"] == "flag")
        .filter_map(|item| item["ref"].as_str().and_then(given_flag))
        .collect();
    let flags = sqlx::query(&format!(
        "SELECT {FLAG_COLUMNS} FROM saju_flags f JOIN users u ON u.id = f.giver_id
         WHERE f.owner_id = $1 AND (f.id = ANY($2) OR f.id IN (
           SELECT id FROM saju_flags WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $3))
         ORDER BY f.created_at DESC, f.id DESC"
    ))
    .bind(owner)
    .bind(&named)
    .bind(if own { OWNER_FLAGS } else { 0 })
    .fetch_all(&mut *db)
    .await?;
    let character = if own || placed.iter().any(|item| item["kind"] == "character") {
        let model: Option<String> = sqlx::query_scalar(
            "SELECT model_url FROM user_looks WHERE user_id = $1 AND status = 'ready' AND model_url IS NOT NULL",
        )
        .bind(owner)
        .fetch_optional(&mut *db)
        .await?;
        model.map(|url| json!({"modelUrl": url}))
    } else {
        None
    };
    let gift_ids: Vec<Uuid> = placed
        .iter()
        .filter(|item| item["kind"] == "gift")
        .filter_map(|item| item["ref"].as_str().and_then(given_flag))
        .collect();
    let gifts = crate::saju_gifts::inventory(db, owner, own, &gift_ids).await?;
    let mut decor =
        json!({"items": items, "flags": flags.iter().map(flag).collect::<Vec<_>>(), "character": character});
    if terrain != "default" {
        decor["terrain"] = json!(terrain);
    }
    if tiles.as_array().is_some_and(|cells| !cells.is_empty()) {
        decor["tiles"] = tiles;
    }
    if !gifts.is_empty() {
        decor["gifts"] = json!(gifts);
    }
    if let Some(board) = board {
        decor["photoBoard"] = board;
    }
    Ok(decor)
}

/// `GET /api/homes/{username}/saju/decor`: the decor of the member's island (see [`shown`]), for whoever may see their
/// home, as `GET /api/homes/{username}/saju` decides it. Read in one snapshot, so a flag taken down meanwhile is both
/// placed and listed, or neither.
async fn view(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, own) = visible_home(&state, &name, viewer.as_ref()).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").execute(&mut *tx).await?;
    let decor = shown(&mut tx, home.owner_id, own).await?;
    tx.commit().await?;
    Ok(Json(decor))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Save {
    /// The account the page was loaded for. A missing value must refuse the save.
    expected_owner_id: Option<Uuid>,
    /// Read as [`Item`]s once the account is known ([`checked`]).
    items: Value,
}

/// `PUT /api/homes/me/saju/decor` `{expectedOwnerId, items}`: places the caller's things on the island of their 사주
/// home, all of them at once, and answers with the decor as its owner reads it. The flags placed must be the caller's
/// own or given to them.
async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Save>) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    let items = checked(body.items)?;
    rate_limit(&state, format!("saju-decor:{}", user.id), SAVES_PER_MEMBER)?;
    let named: BTreeSet<Uuid> =
        items.iter().filter(|item| item.kind == Kind::Flag).filter_map(|item| given_flag(&item.reference)).collect();
    let named: Vec<Uuid> = named.into_iter().collect();
    let stored = serde_json::to_value(&items).map_err(internal)?;
    let mut tx = state.db.begin().await?;
    // The home and the flags named are held until the decor is stored: the home is not taken down under the save, and a
    // flag taken down meanwhile waits for it, then takes its places on the island with it ([`take_down`]).
    let built: Option<i32> = sqlx::query_scalar("SELECT 1 FROM saju_homes WHERE owner_id = $1 FOR KEY SHARE")
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if built.is_none() {
        return Err(NO_HOME);
    }
    let given: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM saju_flags WHERE owner_id = $1 AND id = ANY($2) FOR KEY SHARE")
            .bind(user.id)
            .bind(&named)
            .fetch_all(&mut *tx)
            .await?;
    if given.len() != named.len() {
        return Err(INVALID_DECOR);
    }
    let gifts: BTreeSet<_> =
        items.iter().filter(|item| item.kind == Kind::Gift).filter_map(|item| given_flag(&item.reference)).collect();
    if !gifts.is_empty() {
        let wanted = Vec::from_iter(gifts);
        let owned: i64 = sqlx::query_scalar("SELECT count(*) FROM saju_gifts WHERE owner_id = $1 AND id = ANY($2)")
            .bind(user.id)
            .bind(&wanted)
            .fetch_one(&mut *tx)
            .await?;
        if owned != wanted.len() as i64 {
            return Err(INVALID_DECOR);
        }
    }
    sqlx::query(
        "INSERT INTO saju_decor (owner_id, items) VALUES ($1, $2)
         ON CONFLICT (owner_id) DO UPDATE SET items = excluded.items, updated_at = now()",
    )
    .bind(user.id)
    .bind(&stored)
    .execute(&mut *tx)
    .await?;
    let decor = shown(&mut tx, user.id, true).await?;
    tx.commit().await?;
    Ok(Json(decor))
}

#[derive(Deserialize)]
struct Gift {
    design: Design,
}

/// What a flag shows: one of [`STARS`] in one of [`ELEMENTS`].
#[derive(Deserialize)]
struct Design {
    star: String,
    element: String,
}

/// `POST /api/homes/{username}/saju/flags` `{design: {star, element}}`: gives the member's home a flag; 201 with it, as
/// the home's decor shows it. The giver may see the home and is not its owner, and both have built a 사주 home; each
/// member gives each home one flag a Seoul day.
async fn give(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let giver = current_user(&state, &headers).await?;
    let Gift { design } = serde_json::from_value(body).map_err(|_| INVALID_FLAG)?;
    if !STARS.contains(&design.star.as_str()) || !ELEMENTS.contains(&design.element.as_str()) {
        return Err(INVALID_FLAG);
    }
    let (home, own) = visible_home(&state, &name, Some(&giver)).await?;
    if own {
        return Err(OWN_HOME);
    }
    rate_limit(&state, format!("saju-flag:{}", giver.id), GIFTS_PER_MEMBER)?;
    let (giver_built, owner_built): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM saju_homes WHERE owner_id = $1),
                EXISTS (SELECT 1 FROM saju_homes WHERE owner_id = $2)",
    )
    .bind(giver.id)
    .bind(home.owner_id)
    .fetch_one(&state.db)
    .await?;
    if !giver_built {
        return Err(GIVER_NO_HOME);
    }
    if !owner_built {
        return Err(OWNER_NO_HOME);
    }
    // One row for each home, giver and Seoul day: a second flag the same day inserts nothing, and is refused.
    let given = sqlx::query(&format!(
        "WITH f AS (
           INSERT INTO saju_flags (id, owner_id, giver_id, star, element, given_on) VALUES ($1, $2, $3, $4, $5, {TODAY})
           ON CONFLICT (owner_id, giver_id, given_on) DO NOTHING RETURNING *)
         SELECT {FLAG_COLUMNS} FROM f JOIN users u ON u.id = f.giver_id"
    ))
    .bind(Uuid::new_v4())
    .bind(home.owner_id)
    .bind(giver.id)
    .bind(&design.star)
    .bind(&design.element)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ALREADY_GIVEN)?;
    Ok((StatusCode::CREATED, Json(flag(&given))).into_response())
}

/// `DELETE /api/homes/me/saju/flags/{id}`: takes down a flag given to the caller, and off their island wherever it was
/// placed, in one transaction.
async fn take_down(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let user = current_user(&state, &headers).await?;
    let mut tx = state.db.begin().await?;
    let taken = sqlx::query("DELETE FROM saju_flags WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if taken.rows_affected() == 0 {
        return Err(NO_FLAG);
    }
    sqlx::query(
        "UPDATE saju_decor SET updated_at = now(), items = COALESCE((
           SELECT jsonb_agg(item ORDER BY at) FROM jsonb_array_elements(items) WITH ORDINALITY AS kept (item, at)
           WHERE NOT (item @> $2)), '[]'::jsonb)
         WHERE owner_id = $1 AND items @> jsonb_build_array($2)",
    )
    .bind(user.id)
    .bind(json!({"kind": "flag", "ref": id}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lantern(change: impl FnOnce(&mut Value)) -> ApiResult<Vec<Item>> {
        let mut item = json!({"id": "a", "kind": "prop", "ref": "lantern", "x": 0, "z": 0, "turn": 0});
        change(&mut item);
        checked(json!([item]))
    }

    #[test]
    fn 놓인_것의_숫자는_보낸_그대로_두고_모르는_칸은_두지_않는다() {
        let items = lantern(|item| {
            item["x"] = json!(-40);
            item["z"] = json!(39.5);
            item["turn"] = json!(-7.0);
            item["glow"] = json!(true);
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&items).unwrap(),
            json!([{"id": "a", "kind": "prop", "ref": "lantern", "x": -40, "z": 39.5, "turn": -7.0}])
        );
    }

    #[test]
    fn 깃발은_내_것이거나_서버가_쓰는_꼴의_아이디만_가리킨다() {
        let id = Uuid::new_v4();
        assert_eq!(given_flag(&id.to_string()), Some(id));
        assert_eq!(given_flag(&id.to_string().to_uppercase()), None);
        assert_eq!(given_flag(&id.simple().to_string()), None);
        assert_eq!(given_flag(&format!("{{{id}}}")), None);
        assert_eq!(given_flag(MINE), None);
        let flag = |reference: &str| {
            lantern(|item| {
                item["kind"] = json!("flag");
                item["ref"] = json!(reference);
            })
        };
        assert!(flag(MINE).is_ok() && flag(&id.to_string()).is_ok());
        assert!(flag("yours").is_err() && flag(&id.simple().to_string()).is_err());
    }

    #[test]
    fn 전광판은_한_번만_놓이고_사진만_가리킨다() {
        let board = |id: &str, reference: &str| json!({"id": id, "kind": "board", "ref": reference, "x": 1, "z": -2, "turn": 0.78});
        assert!(checked(json!([board("a", "photo")])).is_ok());
        assert!(checked(json!([board("a", "picture")])).is_err());
        assert!(checked(json!([board("a", "photo"), board("b", "photo")])).is_err());
    }
}
