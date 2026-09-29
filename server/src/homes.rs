use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgExecutor, Row, postgres::PgRow};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{User, current_user, optional_user, username},
    error::{ApiError, ApiResult, bad, conflict, forbidden, not_found},
    rebac::{Checker, Object, Subject},
    security::client_address,
};

const MAX_WORLD_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOMAINS: usize = 64;
const VISIBILITIES: [&str; 3] = ["public", "ilchon", "private"];
const MOODS: i16 = 4;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes", get(list))
        .route("/api/homes/me", get(mine).patch(update))
        .route("/api/homes/me/world", put(save_world).layer(DefaultBodyLimit::max(MAX_WORLD_BYTES + 64 * 1024)))
        .route("/api/homes/{username}", get(view))
        .route("/api/homes/{username}/visits", post(visit))
        .route("/api/homes/{username}/world", get(world))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeProfile {
    pub owner_id: Uuid,
    pub username: String,
    pub owner_name: String,
    pub title: String,
    pub status_message: String,
    pub mood: i16,
    pub minime: String,
    pub emoji: String,
    pub visibility: String,
    pub updated_at: DateTime<Utc>,
}

const PROFILE_SELECT: &str = "SELECT h.owner_id, u.username, u.display_name AS owner_name, h.title, h.status_message,
    h.mood, h.minime, h.emoji, h.visibility, h.updated_at FROM homes h JOIN users u ON u.id = h.owner_id";

fn profile(row: &PgRow) -> HomeProfile {
    HomeProfile {
        owner_id: row.get("owner_id"),
        username: row.get("username"),
        owner_name: row.get("owner_name"),
        title: row.get("title"),
        status_message: row.get("status_message"),
        mood: row.get("mood"),
        minime: row.get("minime"),
        emoji: row.get("emoji"),
        visibility: row.get("visibility"),
        updated_at: row.get("updated_at"),
    }
}

const HOME_PRIVATE: ApiError = forbidden("home_private", "주인이 공개하지 않은 섬입니다.");

/// The home behind `/@username` if `viewer` holds `home:<owner>#viewer` (see [`crate::rebac`]): it is public, theirs,
/// open to 일촌 and they are one, or they were granted it.
pub async fn visible_home(state: &AppState, name: &str, viewer: Option<&User>) -> ApiResult<(HomeProfile, bool)> {
    let name = username(name)?;
    let row = sqlx::query(&format!("{PROFILE_SELECT} WHERE u.username = $1"))
        .bind(&name)
        .fetch_optional(&state.db)
        .await?
        .ok_or(not_found("home_not_found", "없는 섬입니다."))?;
    let home = profile(&row);
    let is_owner = viewer.is_some_and(|user| user.id == home.owner_id);
    let mut checker = Checker::new(&state.db);
    checker.know_home(home.owner_id, &home.visibility);
    let subject = viewer.map_or(Subject::Anonymous, |user| Subject::User(user.id));
    if checker.check(subject, &Object::home(home.owner_id), "viewer").await? {
        Ok((home, is_owner))
    } else {
        Err(HOME_PRIVATE)
    }
}

async fn visits(state: &AppState, owner: Uuid) -> ApiResult<Value> {
    let row = sqlx::query(
        "SELECT (SELECT count(*) FROM home_visits WHERE owner_id = $1 AND day = (now() AT TIME ZONE 'Asia/Seoul')::date) AS today,
                (SELECT visits_total FROM homes WHERE owner_id = $1) AS total",
    )
    .bind(owner)
    .fetch_one(&state.db)
    .await?;
    Ok(json!({"today": row.get::<i64, _>("today"), "total": row.get::<Option<i64>, _>("total").unwrap_or(0)}))
}

async fn home_view(state: &AppState, home: HomeProfile, is_owner: bool) -> ApiResult<Json<Value>> {
    let visits = visits(state, home.owner_id).await?;
    Ok(Json(json!({"profile": home, "visits": visits, "isOwner": is_owner})))
}

/// Gives `owner` an island named after them, unless they already have one.
pub async fn create(db: impl PgExecutor<'_>, owner: &User) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO homes (owner_id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(owner.id)
        .bind(format!("{}의 섬", owner.display_name))
        .execute(db)
        .await?;
    Ok(())
}

async fn my_home(state: &AppState, user: &User) -> ApiResult<HomeProfile> {
    create(&state.db, user).await?;
    let row =
        sqlx::query(&format!("{PROFILE_SELECT} WHERE h.owner_id = $1")).bind(user.id).fetch_one(&state.db).await?;
    Ok(profile(&row))
}

/// `?limit=&before=` on a newest-first listing: at most 50 rows (20 unless asked), older than `before`.
#[derive(Deserialize)]
pub struct Page {
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
}

impl Page {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(20).clamp(1, 50)
    }

    pub fn before(&self) -> DateTime<Utc> {
        self.before.unwrap_or_else(|| Utc::now() + chrono::Duration::minutes(1))
    }
}

async fn list(State(state): State<AppState>, Query(page): Query<Page>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        "SELECT u.username, u.display_name AS owner_name, h.title, h.status_message, h.emoji, h.updated_at, h.visits_total
         FROM homes h JOIN users u ON u.id = h.owner_id
         WHERE h.visibility = 'public' AND h.updated_at < $1 ORDER BY h.updated_at DESC LIMIT $2",
    )
    .bind(page.before())
    .bind(page.limit())
    .fetch_all(&state.db)
    .await?;
    let homes: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "username": row.get::<String, _>("username"),
                "ownerName": row.get::<String, _>("owner_name"),
                "title": row.get::<String, _>("title"),
                "statusMessage": row.get::<String, _>("status_message"),
                "emoji": row.get::<String, _>("emoji"),
                "updatedAt": row.get::<DateTime<Utc>, _>("updated_at"),
                "total": row.get::<i64, _>("visits_total"),
            })
        })
        .collect();
    Ok(Json(json!({"homes": homes})))
}

async fn mine(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    let home = my_home(&state, &user).await?;
    home_view(&state, home, true).await
}

async fn view(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, is_owner) = visible_home(&state, &name, viewer.as_ref()).await?;
    home_view(&state, home, is_owner).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileChanges {
    title: Option<String>,
    status_message: Option<String>,
    mood: Option<i16>,
    minime: Option<String>,
    emoji: Option<String>,
    visibility: Option<String>,
}

fn trimmed(value: Option<String>, min: usize, max: usize, field: &'static str) -> ApiResult<Option<String>> {
    let Some(value) = value.map(|v| v.trim().to_owned()) else { return Ok(None) };
    let count = value.chars().count();
    if count < min || count > max || value.chars().any(char::is_control) {
        return Err(bad(field, "입력한 값의 길이를 확인해 주세요."));
    }
    Ok(Some(value))
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(changes): Json<ProfileChanges>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    my_home(&state, &user).await?;
    let title = trimmed(changes.title, 1, 30, "invalid_title")?;
    let status = trimmed(changes.status_message, 0, 60, "invalid_status")?;
    let minime = trimmed(changes.minime, 1, 64, "invalid_minime")?;
    if minime.as_deref().is_some_and(|id| !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))) {
        return Err(bad("invalid_minime", "미니미를 확인해 주세요."));
    }
    // Only what the picker offers: a published catalog 미니미, or a built-in one (always shipped with the app).
    if let Some(id) = minime.as_deref() {
        let pickable: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM catalog_items WHERE id = $1 AND kind = 'minime'
             AND (status = 'published' OR source = 'builtin'))",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
        if !pickable {
            return Err(bad("invalid_minime", "고를 수 없는 미니미입니다."));
        }
    }
    let emoji = trimmed(changes.emoji, 1, 16, "invalid_emoji")?;
    if changes.mood.is_some_and(|mood| !(0..MOODS).contains(&mood)) {
        return Err(bad("invalid_mood", "기분을 확인해 주세요."));
    }
    if changes.visibility.as_deref().is_some_and(|v| !VISIBILITIES.contains(&v)) {
        return Err(bad("invalid_visibility", "공개 범위를 확인해 주세요."));
    }
    // Picking a 미니미 means walking as it: a look the owner wore comes off.
    let picked = minime.is_some();
    sqlx::query(
        "UPDATE homes SET title = COALESCE($2, title), status_message = COALESCE($3, status_message),
         mood = COALESCE($4, mood), minime = COALESCE($5, minime), emoji = COALESCE($6, emoji),
         visibility = COALESCE($7, visibility), updated_at = now() WHERE owner_id = $1",
    )
    .bind(user.id)
    .bind(title)
    .bind(status)
    .bind(changes.mood)
    .bind(minime)
    .bind(emoji)
    .bind(changes.visibility)
    .execute(&state.db)
    .await?;
    if picked {
        crate::looks::take_off(&state.db, user.id).await?;
    }
    let home = my_home(&state, &user).await?;
    home_view(&state, home, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisitBody {
    visitor_id: Option<Uuid>,
}

/// Counts one visit per visitor per Seoul day; the owner's own visits do not count.
async fn visit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<VisitBody>,
) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, is_owner) = visible_home(&state, &name, viewer.as_ref()).await?;
    if !is_owner {
        let visitor = match (&viewer, body.visitor_id) {
            (Some(user), _) => format!("u:{}", user.id),
            (None, Some(id)) => format!("a:{id}"),
            (None, None) => format!("ip:{}", client_address(&headers)),
        };
        let mut tx = state.db.begin().await?;
        let fresh = sqlx::query(
            "INSERT INTO home_visits (owner_id, day, visitor) VALUES ($1, (now() AT TIME ZONE 'Asia/Seoul')::date, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(home.owner_id)
        .bind(visitor)
        .execute(&mut *tx)
        .await?;
        if fresh.rows_affected() > 0 {
            sqlx::query("UPDATE homes SET visits_total = visits_total + 1 WHERE owner_id = $1")
                .bind(home.owner_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(Json(visits(&state, home.owner_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorldQuery {
    world_id: String,
}

fn world_id(value: &str) -> ApiResult<&str> {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(bad("invalid_world_id", "섬 식별자가 올바르지 않습니다."));
    }
    Ok(value)
}

fn world_json(row: &PgRow) -> Value {
    json!({
        "worldId": row.get::<String, _>("world_id"),
        "revision": row.get::<i64, _>("revision"),
        "data": row.get::<Value, _>("data"),
        "updatedAt": row.get::<DateTime<Utc>, _>("updated_at"),
    })
}

/// 204 until the owner first saves: a fresh island is the normal state, not an error.
async fn world(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<WorldQuery>,
) -> ApiResult<Response> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let row = sqlx::query(
        "SELECT world_id, revision, data, updated_at FROM home_worlds WHERE owner_id = $1 AND world_id = $2",
    )
    .bind(home.owner_id)
    .bind(world_id(&query.world_id)?)
    .fetch_optional(&state.db)
    .await?;
    Ok(match row {
        Some(row) => Json(world_json(&row)).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorld {
    world_id: String,
    base_revision: i64,
    data: Map<String, Value>,
}

/// Keys whose string values a visitor's browser fetches: model, texture and image URLs.
fn fetched_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.ends_with("url") || key.ends_with("texture")
}

/// Assets the platform serves, and inline images; anything else would make visitors fetch a stranger's host.
pub fn safe_asset_url(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    if ["data:image/svg+xml", "data:image/png", "data:image/webp", "data:image/jpeg"]
        .iter()
        .any(|prefix| lower.starts_with(prefix) && matches!(lower.as_bytes().get(prefix.len()), Some(b';' | b',')))
    {
        return true;
    }
    if crate::models::is_model_url(value) {
        return true;
    }
    value.strip_prefix('/').unwrap_or(value).strip_prefix("gltf/").is_some_and(|rest| {
        !rest.is_empty()
            && !rest.contains("..")
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
    })
}

fn unsafe_url(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(unsafe_url),
        Value::Object(map) => map.iter().any(|(key, child)| match child {
            Value::String(text) if fetched_key(key) => !safe_asset_url(text),
            other => unsafe_url(other),
        }),
        _ => false,
    }
}

/// Why the save envelope may not be stored: the runtime's envelope rules and the asset URL allowlist.
fn world_problem(data: &Map<String, Value>) -> Option<&'static str> {
    if data.get("version").and_then(Value::as_i64).is_none_or(|v| v < 1) {
        return Some("version");
    }
    if !data.get("savedAt").and_then(Value::as_f64).is_some_and(|v| v.is_finite() && v >= 0.0) {
        return Some("savedAt");
    }
    let Some(domains) = data.get("domains").and_then(Value::as_object) else { return Some("domains") };
    if domains.len() > MAX_DOMAINS {
        return Some("domains");
    }
    domains.values().any(unsafe_url).then_some("url")
}

async fn save_world(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SaveWorld>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    my_home(&state, &user).await?;
    let world_id = world_id(&body.world_id)?.to_owned();
    let data = Value::Object(body.data);
    let byte_size = serde_json::to_vec(&data).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
    if byte_size > MAX_WORLD_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "world_too_large", "저장할 섬이 너무 큽니다."));
    }
    if let Some(problem) = data.as_object().and_then(world_problem) {
        tracing::warn!(problem, user = %user.id, "Rejected world save");
        return Err(bad("invalid_world", "저장할 수 없는 섬 데이터입니다."));
    }
    let domains = data.get("domains").and_then(Value::as_object);
    if let Some(problem) = match domains {
        Some(domains) => crate::residents::problem(&state.db, domains).await?,
        None => None,
    } {
        tracing::warn!(problem, user = %user.id, "Rejected world save");
        return Err(bad("invalid_residents", "섬에 둘 수 없는 주민이 있습니다."));
    }
    let row = if body.base_revision == 0 {
        sqlx::query(
            "INSERT INTO home_worlds (owner_id, world_id, revision, data, byte_size) VALUES ($1, $2, 1, $3, $4)
             ON CONFLICT DO NOTHING RETURNING world_id, revision, data, updated_at",
        )
    } else {
        sqlx::query(
            "UPDATE home_worlds SET revision = revision + 1, data = $3, byte_size = $4, updated_at = now()
             WHERE owner_id = $1 AND world_id = $2 AND revision = $5 RETURNING world_id, revision, data, updated_at",
        )
    }
    .bind(user.id)
    .bind(&world_id)
    .bind(&data)
    .bind(byte_size as i32)
    .bind(body.base_revision)
    .fetch_optional(&state.db)
    .await?
    .ok_or(conflict("revision_conflict", "다른 곳에서 먼저 저장했어요. 새로 불러온 뒤 다시 저장해 주세요."))?;
    sqlx::query("UPDATE homes SET updated_at = now() WHERE owner_id = $1").bind(user.id).execute(&state.db).await?;
    Ok(Json(world_json(&row)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_urls_stay_on_the_platform() {
        assert!(safe_asset_url("gltf/props/bed.glb"));
        assert!(safe_asset_url("/gltf/nature/kenney/bush.glb"));
        assert!(safe_asset_url(&format!("/models/{}.glb", "a".repeat(64))));
        assert!(safe_asset_url("data:image/svg+xml;utf8,%3Csvg%3E"));
        assert!(!safe_asset_url("https://evil.example/x.glb"));
        assert!(!safe_asset_url("gltf/../../etc/passwd"));
        assert!(!safe_asset_url("javascript:alert(1)"));
        assert!(!safe_asset_url(&format!("/models/{}.glb", "A".repeat(64))));
    }

    #[test]
    fn world_envelope_and_nested_urls_are_checked() {
        let ok = json!({"version": 1, "savedAt": 1, "domains": {"building": {"objects": [{"config": {"modelUrl": "gltf/props/bed.glb"}}]}}});
        assert_eq!(world_problem(ok.as_object().unwrap()), None);
        let evil = json!({"version": 1, "savedAt": 1, "domains": {"building": {"meshes": [{"mapTextureUrl": "https://x.y/t.png"}]}}});
        assert_eq!(world_problem(evil.as_object().unwrap()), Some("url"));
        assert_eq!(
            world_problem(json!({"version": 0, "savedAt": 1, "domains": {}}).as_object().unwrap()),
            Some("version")
        );
        assert_eq!(
            world_problem(json!({"version": 1, "savedAt": -1, "domains": {}}).as_object().unwrap()),
            Some("savedAt")
        );
    }
}
