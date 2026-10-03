use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgExecutor, PgPool, Row, postgres::PgRow};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{User, current_user, optional_user, username},
    error::{ApiError, ApiResult, bad, conflict, forbidden, internal, not_found},
    permissions::like_escape,
    rebac::{Checker, Object, Subject},
    security::{client_address, hmac_sha256, rate_limit},
};

const MAX_WORLD_BYTES: usize = 2 * 1024 * 1024;
/// A save request: the envelope and the fields around it.
const MAX_SAVE_BYTES: usize = MAX_WORLD_BYTES + 64 * 1024;
/// Island saves one member may make in the rate window (ten minutes): the autosave writes about every ten seconds.
const WORLD_SAVES_PER_WINDOW: u32 = 120;
/// Islands (worlds) one member keeps, and their bytes in all. The app uses one at a time and moves to a new id when its
/// layout changes, so a save past either pushes out the least recently updated others instead of locking the member out.
const MAX_WORLDS: i64 = 8;
const MAX_MEMBER_WORLD_BYTES: i64 = 6 * 1024 * 1024;
const MAX_DOMAINS: usize = 64;
const VISIBILITIES: [&str; 3] = ["public", "ilchon", "private"];
const MOODS: i16 = 4;
const MAX_DAILY_VISITORS: i64 = 10_000;
/// Visits counted in the rate window (ten minutes): anonymous ones per address, a member's per member.
const VISITS_PER_ADDRESS: u32 = 120;
const VISITS_PER_MEMBER: u32 = 300;
const OWNER_CHANGED: ApiError = conflict("owner_changed", "계정이 바뀌어 저장을 중단했어요.");
const WORLD_TOO_LARGE: ApiError =
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "world_too_large", "저장할 섬이 너무 큽니다.");
const INVALID_WORLD: ApiError = bad("invalid_world", "저장할 수 없는 섬 데이터입니다.");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes", get(list))
        .route("/api/homes/me", get(mine).patch(update))
        .route("/api/homes/me/world", put(save_world))
        .route("/api/homes/{username}", get(view))
        .route("/api/homes/{username}/visits", post(visit))
        .route("/api/homes/{username}/world", get(world))
}

/// Whether `text` holds no control character; `multiline` lets line breaks through where the field is a text area.
pub(crate) fn plain_text(text: &str, multiline: bool) -> bool {
    text.chars().all(|c| !c.is_control() || (multiline && c == '\n'))
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

/// `?limit=&before=` on a newest-first listing: at most 50 rows (20 unless asked), older than `before`. `q` is what a
/// searchable listing looks for.
#[derive(Deserialize)]
pub struct Page {
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
    q: Option<String>,
}

impl Page {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(20).clamp(1, 50)
    }

    pub fn before(&self) -> DateTime<Utc> {
        self.before.unwrap_or_else(|| Utc::now() + chrono::Duration::minutes(1))
    }

    /// The search text as an ILIKE pattern for it anywhere in a column, its own `%`, `_` and `\` taken literally; None
    /// without one.
    fn pattern(&self) -> ApiResult<Option<String>> {
        let Some(text) = self.q.as_deref().map(str::trim).filter(|text| !text.is_empty()) else { return Ok(None) };
        if text.chars().count() > 40 || text.chars().any(char::is_control) {
            return Err(bad("invalid_query", "검색어는 40자 이하로 입력해 주세요."));
        }
        Ok(Some(format!("%{}%", like_escape(text))))
    }
}

/// `GET /api/homes?q=`: public islands, newest first; `q` keeps the ones whose owner's username or name, or title,
/// holds it (capitals do not matter).
async fn list(State(state): State<AppState>, Query(page): Query<Page>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        "SELECT u.username, u.display_name AS owner_name, h.title, h.status_message, h.emoji, h.updated_at, h.visits_total
         FROM homes h JOIN users u ON u.id = h.owner_id
         WHERE h.visibility = 'public' AND h.updated_at < $1
           AND ($3::text IS NULL OR u.username ILIKE $3 OR u.display_name ILIKE $3 OR h.title ILIKE $3)
         ORDER BY h.updated_at DESC LIMIT $2",
    )
    .bind(page.before())
    .bind(page.limit())
    .bind(page.pattern()?)
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

/// What a profile save changes. Fields this server does not know are ignored, so a newer page keeps saving to a
/// server rolled back under it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileChanges {
    /// The account the page was loaded for. A missing value must refuse the save.
    expected_owner_id: Option<Uuid>,
    title: Option<String>,
    status_message: Option<String>,
    mood: Option<i16>,
    minime: Option<String>,
    emoji: Option<String>,
    visibility: Option<String>,
}

/// Refuses a save that a page loaded for another account sends.
fn same_owner(expected: Option<Uuid>, owner: Uuid) -> ApiResult<()> {
    if expected == Some(owner) { Ok(()) } else { Err(OWNER_CHANGED) }
}

fn trimmed(
    value: Option<String>,
    min: usize,
    max: usize,
    multiline: bool,
    field: &'static str,
) -> ApiResult<Option<String>> {
    let Some(value) = value.map(|v| v.trim().to_owned()) else { return Ok(None) };
    let count = value.chars().count();
    if count < min || count > max {
        return Err(bad(field, "입력한 값의 길이를 확인해 주세요."));
    }
    if !plain_text(&value, multiline) {
        return Err(bad(field, "쓸 수 없는 문자가 들어 있어요."));
    }
    Ok(Some(value))
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(changes): Json<ProfileChanges>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(changes.expected_owner_id, user.id)?;
    my_home(&state, &user).await?;
    let title = trimmed(changes.title, 1, 30, false, "invalid_title")?;
    // The status is a two-line text area.
    let status = trimmed(changes.status_message, 0, 60, true, "invalid_status")?;
    let minime = trimmed(changes.minime, 1, 64, false, "invalid_minime")?;
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
    let emoji = trimmed(changes.emoji, 1, 16, false, "invalid_emoji")?;
    if changes.mood.is_some_and(|mood| !(0..MOODS).contains(&mood)) {
        return Err(bad("invalid_mood", "기분을 확인해 주세요."));
    }
    if changes.visibility.as_deref().is_some_and(|v| !VISIBILITIES.contains(&v)) {
        return Err(bad("invalid_visibility", "공개 범위를 확인해 주세요."));
    }
    // Picking a 미니미 means walking as it: a look the owner wore comes off.
    let picked = minime.is_some();
    let visibility_set = changes.visibility.is_some();
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
    // Whoever stands on the island and no longer may is let out.
    if visibility_set {
        crate::rooms::revalidate(&state, &user.username).await;
    }
    let home = my_home(&state, &user).await?;
    home_view(&state, home, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisitBody {
    // Kept readable for old clients, but an anonymous client cannot choose its counting identity.
    #[serde(rename = "visitorId")]
    _visitor_id: Option<Uuid>,
}

/// Counts one visit per visitor per Seoul day; the owner's own visits do not count. Anonymous visits share a budget per
/// address; members behind one address (a school, a mobile carrier) each have their own.
async fn visit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(_body): Json<VisitBody>,
) -> ApiResult<Json<Value>> {
    let address = client_address(&headers);
    let viewer = optional_user(&state, &headers).await?;
    if viewer.is_none() {
        rate_limit(&state, format!("visits-address:{address}"), VISITS_PER_ADDRESS)?;
    }
    let (home, is_owner) = visible_home(&state, &name, viewer.as_ref()).await?;
    if !is_owner {
        let visitor = match &viewer {
            Some(user) => {
                rate_limit(&state, format!("visits-user:{}", user.id), VISITS_PER_MEMBER)?;
                format!("u:{}", user.id)
            }
            None => format!("ip:{}", hex::encode(hmac_sha256(&state.config.ticket_secret, address.as_bytes()))),
        };
        let mut tx = state.db.begin().await?;
        sqlx::query("SELECT 1 FROM homes WHERE owner_id = $1 FOR UPDATE").bind(home.owner_id).execute(&mut *tx).await?;
        let full: bool = sqlx::query_scalar("SELECT count(*) >= $2 FROM home_visits WHERE owner_id = $1 AND day = (now() AT TIME ZONE 'Asia/Seoul')::date")
            .bind(home.owner_id).bind(MAX_DAILY_VISITORS).fetch_one(&mut *tx).await?;
        if full {
            tx.rollback().await?;
            return Ok(Json(visits(&state, home.owner_id).await?));
        }
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

/// The world columns a stored world is answered with; its envelope comes as the text PostgreSQL keeps.
const WORLD_COLUMNS: &str = "world_id, revision, data::text AS data, updated_at";

/// `{worldId, revision, data, updatedAt}` with the stored envelope written in as it is, not parsed and written again.
fn world_response(row: &PgRow) -> Response {
    let body = format!(
        r#"{{"worldId":{},"revision":{},"data":{},"updatedAt":{}}}"#,
        Value::from(row.get::<String, _>("world_id")),
        row.get::<i64, _>("revision"),
        row.get::<String, _>("data"),
        json!(row.get::<DateTime<Utc>, _>("updated_at")),
    );
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
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
    let row = sqlx::query(&format!("SELECT {WORLD_COLUMNS} FROM home_worlds WHERE owner_id = $1 AND world_id = $2"))
        .bind(home.owner_id)
        .bind(world_id(&query.world_id)?)
        .fetch_optional(&state.db)
        .await?;
    Ok(match row {
        Some(row) => world_response(&row),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorld {
    /// The account the page was loaded for. Missing/null is not a current-account fallback.
    expected_owner_id: Option<Uuid>,
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

/// Whether a key or string anywhere in `value` holds a NUL, which PostgreSQL cannot keep in JSON.
fn holds_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(items) => items.iter().any(holds_nul),
        Value::Object(map) => map.iter().any(|(key, child)| key.contains('\0') || holds_nul(child)),
        _ => false,
    }
}

/// Why the save envelope may not be stored: the runtime's envelope rules, text the database cannot keep and the asset
/// URL allowlist.
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
    if data.iter().any(|(key, value)| key.contains('\0') || holds_nul(value)) {
        return Some("nul");
    }
    domains.values().any(unsafe_url).then_some("url")
}

/// A save request read and checked: its envelope as it is stored (and measured), and the domains for the resident check.
struct Checked {
    world_id: String,
    base_revision: i64,
    data: String,
    domains: Option<Map<String, Value>>,
}

/// The request body as `owner`'s save, its envelope measured and checked; for a blocking thread, since it is up to
/// 2 MiB.
fn check_save(bytes: &[u8], owner: Uuid) -> ApiResult<Checked> {
    let save: SaveWorld = serde_json::from_slice(bytes).map_err(|_| INVALID_WORLD)?;
    same_owner(save.expected_owner_id, owner)?;
    world_id(&save.world_id)?;
    let data = serde_json::to_string(&save.data).map_err(internal)?;
    if data.len() > MAX_WORLD_BYTES {
        return Err(WORLD_TOO_LARGE);
    }
    if let Some(problem) = world_problem(&save.data) {
        tracing::warn!(problem, user = %owner, "Rejected world save");
        return Err(INVALID_WORLD);
    }
    let mut envelope = save.data;
    let domains = match envelope.remove("domains") {
        Some(Value::Object(domains)) => Some(domains),
        _ => None,
    };
    Ok(Checked { world_id: save.world_id, base_revision: save.base_revision, data, domains })
}

/// Stores a save under a lock on the owner's home: a first save makes the world's row (None when it exists already),
/// a later one needs the revision it was based on (None when another save came first). The owner then keeps at most
/// [`MAX_WORLDS`] worlds and [`MAX_MEMBER_WORLD_BYTES`] in all: the least recently updated of the others make room,
/// never the one saved here, so saves made at once cannot pass either cap.
async fn store(db: &PgPool, owner: Uuid, save: &Checked) -> ApiResult<Option<PgRow>> {
    let bytes = save.data.len() as i32;
    let mut tx = db.begin().await?;
    sqlx::query("SELECT 1 FROM homes WHERE owner_id = $1 FOR UPDATE").bind(owner).execute(&mut *tx).await?;
    let row = if save.base_revision == 0 {
        sqlx::query(&format!(
            "INSERT INTO home_worlds (owner_id, world_id, revision, data, byte_size) VALUES ($1, $2, 1, $3::jsonb, $4)
             ON CONFLICT DO NOTHING RETURNING {WORLD_COLUMNS}"
        ))
        .bind(owner)
        .bind(&save.world_id)
        .bind(&save.data)
        .bind(bytes)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        sqlx::query(&format!(
            "UPDATE home_worlds SET revision = revision + 1, data = $3::jsonb, byte_size = $4, updated_at = now()
             WHERE owner_id = $1 AND world_id = $2 AND revision = $5 RETURNING {WORLD_COLUMNS}"
        ))
        .bind(owner)
        .bind(&save.world_id)
        .bind(&save.data)
        .bind(bytes)
        .bind(save.base_revision)
        .fetch_optional(&mut *tx)
        .await?
    };
    if row.is_some() {
        sqlx::query(
            "DELETE FROM home_worlds WHERE owner_id = $1 AND world_id IN (
               SELECT world_id FROM (
                 SELECT world_id, row_number() OVER newest AS place, sum(byte_size) OVER newest AS kept
                 FROM home_worlds WHERE owner_id = $1 AND world_id <> $2
                 WINDOW newest AS (ORDER BY updated_at DESC, world_id)) others
               WHERE place >= $3 OR kept > $4)",
        )
        .bind(owner)
        .bind(&save.world_id)
        .bind(MAX_WORLDS)
        .bind(MAX_MEMBER_WORLD_BYTES - i64::from(bytes))
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE homes SET updated_at = now() WHERE owner_id = $1").bind(owner).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(row)
}

/// `PUT /api/homes/me/world`. The body is read only once the sender is known and within its budget.
async fn save_world(State(state): State<AppState>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("world:{}", user.id), WORLD_SAVES_PER_WINDOW)?;
    let bytes = axum::body::to_bytes(body, MAX_SAVE_BYTES).await.map_err(|_| WORLD_TOO_LARGE)?;
    let owner = user.id;
    let save = tokio::task::spawn_blocking(move || check_save(&bytes, owner)).await.map_err(internal)??;
    my_home(&state, &user).await?;
    if let Some(problem) = match &save.domains {
        Some(domains) => crate::residents::problem(&state.db, domains).await?,
        None => None,
    } {
        tracing::warn!(problem, user = %user.id, "Rejected world save");
        return Err(bad("invalid_residents", "섬에 둘 수 없는 주민이 있습니다."));
    }
    let row = store(&state.db, user.id, &save)
        .await?
        .ok_or(conflict("revision_conflict", "다른 곳에서 먼저 저장했어요. 새로 불러온 뒤 다시 저장해 주세요."))?;
    Ok(world_response(&row))
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
        // PostgreSQL cannot keep a NUL in JSON: refused here, before the database would fail on it.
        let nul = json!({"version": 1, "savedAt": 1, "domains": {"building": {"note": "a\u{0}b"}}});
        assert_eq!(world_problem(nul.as_object().unwrap()), Some("nul"));
        let nul_key = json!({"version": 1, "savedAt": 1, "domains": {"building": {"a\u{0}": 1}}});
        assert_eq!(world_problem(nul_key.as_object().unwrap()), Some("nul"));
        let lines = json!({"version": 1, "savedAt": 1, "domains": {"building": {"note": "a\nb\tc"}}});
        assert_eq!(world_problem(lines.as_object().unwrap()), None);
    }

    #[test]
    fn text_fields_take_line_breaks_only_where_they_are_text_areas() {
        assert!(plain_text("두 줄\n상태", true));
        assert!(!plain_text("두 줄\n제목", false));
        for control in ["\u{0}", "\r", "\t", "\u{7}", "\u{1b}", "\u{85}"] {
            assert!(!plain_text(&format!("a{control}b"), true), "{control:?}");
        }
        assert!(plain_text("👩‍🏫 이모지", false));
    }
}
