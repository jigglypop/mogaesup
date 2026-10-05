use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::{
    Deserialize, Serialize,
    de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value, json, value::RawValue};
use sqlx::{PgExecutor, PgPool, Row, postgres::PgRow};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    io::Write,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{User, current_user, optional_user, username},
    error::{ApiError, ApiResult, bad, conflict, forbidden, internal, not_found},
    permissions::like_escape,
    rebac::{Checker, Object, Subject},
    security::{client_address, hmac_sha256, rate_limit},
    share,
};

const MAX_WORLD_BYTES: usize = 2 * 1024 * 1024;
/// A save request: the envelope and the fields around it.
const MAX_SAVE_BYTES: usize = MAX_WORLD_BYTES + 64 * 1024;
/// Island saves one member may make in the rate window (ten minutes): the autosave writes about every ten seconds.
const WORLD_SAVES_PER_WINDOW: u32 = 120;
/// Island saves read, checked and stored at once, site-wide. Each holds its body (up to 2 MiB) and the envelope to
/// store until it is stored, and nothing is read before a save has its slot.
const SAVE_SLOTS: usize = 4;
/// How long a save waits for a slot before it is turned away; the page saves again later.
const SAVE_WAIT: Duration = Duration::from_secs(10);
/// Nodes of the residents domain read into memory at most: twelve residents take a few hundred.
const MAX_RESIDENT_NODES: usize = 2048;
/// When a world save last bumped its island's place in the listing: an island edited for an hour moves to the top
/// once every so often, not with every autosave, so pages of the listing stay put while someone reads them.
const LISTED_EVERY: &str = "10 minutes";
/// Island loads by members counted in the rate window (ten minutes), per member.
const WORLD_READS_PER_MEMBER: u32 = 600;
/// Loaded worlds kept compressed for the next load, in bytes in all.
const WORLD_CACHE_BYTES: usize = 16 * 1024 * 1024;
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
/// Island loads by anonymous visitors counted in the rate window (ten minutes), per address.
const WORLD_READS_PER_ADDRESS: u32 = 600;
/// Searches of the island listing counted in the rate window (ten minutes), per address; each one scans the islands.
const SEARCHES_PER_ADDRESS: u32 = 300;
/// Link preview pictures one member may send in the rate window (ten minutes).
const THUMBNAILS_PER_WINDOW: u32 = 20;
/// A picture save request: the picture as base64 and the fields around it.
const MAX_THUMBNAIL_REQUEST_BYTES: usize = share::MAX_PICTURE_BYTES.div_ceil(3) * 4 + 4096;
const OWNER_CHANGED: ApiError = conflict("owner_changed", "계정이 바뀌어 저장을 중단했어요.");
const WORLD_TOO_LARGE: ApiError =
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "world_too_large", "저장할 섬이 너무 큽니다.");
const INVALID_WORLD: ApiError = bad("invalid_world", "저장할 수 없는 섬 데이터입니다.");
/// A save whose body stopped coming before its end (the connection dropped): not an island too large.
const WORLD_CUT_SHORT: ApiError = ApiError::new(
    StatusCode::BAD_REQUEST,
    "incomplete_world",
    "섬 데이터를 끝까지 받지 못했습니다. 다시 저장해 주세요.",
);
const PICTURE_CUT_SHORT: ApiError =
    ApiError::new(StatusCode::BAD_REQUEST, "incomplete_picture", "사진을 끝까지 받지 못했어요. 다시 올려 주세요.");
const SAVES_BUSY: ApiError = ApiError::new(
    StatusCode::TOO_MANY_REQUESTS,
    "world_busy",
    "지금 섬을 저장하는 사람이 많아요. 잠시 뒤에 다시 저장해 주세요.",
);
const SAVE_RUNNING: ApiError = ApiError::new(
    StatusCode::TOO_MANY_REQUESTS,
    "world_saving",
    "앞선 저장이 아직 끝나지 않았어요. 잠시 뒤에 다시 저장해 주세요.",
);
const INVALID_RESIDENTS: ApiError = bad("invalid_residents", "섬에 둘 수 없는 주민이 있습니다.");

/// Island saves under way and island loads already compressed: what the server keeps between requests for them.
#[derive(Clone)]
pub struct Homes {
    /// See [`SAVE_SLOTS`].
    saving: Arc<Semaphore>,
    /// Members with a save under way: one at a time each.
    members: Arc<Mutex<HashSet<Uuid>>>,
    worlds: Arc<Mutex<WorldCache>>,
}

impl Default for Homes {
    fn default() -> Self {
        Self { saving: Arc::new(Semaphore::new(SAVE_SLOTS)), members: Default::default(), worlds: Default::default() }
    }
}

/// A member's save under way; dropped (however the request ends), the member may save again.
struct Saving {
    members: Arc<Mutex<HashSet<Uuid>>>,
    member: Uuid,
}

impl Drop for Saving {
    fn drop(&mut self) {
        self.members.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.member);
    }
}

impl Homes {
    /// `member`'s save, unless one of theirs is still under way.
    fn begin(&self, member: Uuid) -> ApiResult<Saving> {
        if !self.members.lock().unwrap_or_else(|error| error.into_inner()).insert(member) {
            return Err(SAVE_RUNNING);
        }
        Ok(Saving { members: self.members.clone(), member })
    }

    fn worlds(&self) -> MutexGuard<'_, WorldCache> {
        self.worlds.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// A world as last sent: its revision and save time, and the response body gzipped.
#[derive(Clone)]
struct CachedWorld {
    revision: i64,
    updated_at: DateTime<Utc>,
    gzipped: Bytes,
    used: u64,
}

/// Loaded worlds by owner and world id, gzipped, the least recently used dropped past [`WORLD_CACHE_BYTES`]. Each is
/// checked against the stored revision before it is sent, so a save makes it stale at once.
#[derive(Default)]
struct WorldCache {
    entries: HashMap<(Uuid, String), CachedWorld>,
    bytes: usize,
    clock: u64,
}

impl WorldCache {
    fn get(&mut self, owner: Uuid, world: &str) -> Option<CachedWorld> {
        self.clock += 1;
        let entry = self.entries.get_mut(&(owner, world.to_owned()))?;
        entry.used = self.clock;
        Some(entry.clone())
    }

    fn put(&mut self, owner: Uuid, world: &str, revision: i64, updated_at: DateTime<Utc>, gzipped: Bytes) {
        if gzipped.len() > WORLD_CACHE_BYTES / 4 {
            return;
        }
        self.clock += 1;
        let entry = CachedWorld { revision, updated_at, gzipped, used: self.clock };
        self.bytes += entry.gzipped.len();
        if let Some(old) = self.entries.insert((owner, world.to_owned()), entry) {
            self.bytes -= old.gzipped.len();
        }
        while self.bytes > WORLD_CACHE_BYTES {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, entry)| entry.used).map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(gone) = self.entries.remove(&oldest) {
                self.bytes -= gone.gzipped.len();
            }
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes", get(list))
        .route("/api/homes/me", get(mine).patch(update))
        .route("/api/homes/me/world", put(save_world))
        .route("/api/homes/me/thumbnail", put(save_thumbnail).delete(remove_thumbnail))
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
    /// The picture the island's link preview shows (see [`crate::share`]), a stored JPEG's site path; None for the
    /// site's own.
    pub thumbnail_url: Option<String>,
}

const PROFILE_SELECT: &str = "SELECT h.owner_id, u.username, u.display_name AS owner_name, h.title, h.status_message,
    h.mood, h.minime, h.emoji, h.visibility, h.updated_at, h.thumbnail_url FROM homes h JOIN users u ON u.id = h.owner_id";

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
        thumbnail_url: row.get("thumbnail_url"),
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

/// The listing's columns and order: newest first by when the island last changed, which a world save moves at most
/// every [`LISTED_EVERY`], ties by owner, so the pages a cursor (`before`) walks stay put.
const LISTING_SELECT: &str =
    "SELECT u.username, u.display_name AS owner_name, h.title, h.status_message, h.emoji, h.updated_at, h.visits_total
     FROM homes h JOIN users u ON u.id = h.owner_id
     WHERE h.visibility = 'public' AND h.updated_at < $1";
const LISTING_ORDER: &str = "ORDER BY h.updated_at DESC, h.owner_id DESC LIMIT $2";

/// `GET /api/homes?q=`: public islands, newest first; `q` keeps the ones whose owner's username or name, or title,
/// holds it (capitals do not matter). Searches are counted per address; the plain listing is not. A search looks the
/// owners and the titles up apart, each where the trigram indexes (when the database has them) find them.
async fn list(State(state): State<AppState>, headers: HeaderMap, Query(page): Query<Page>) -> ApiResult<Json<Value>> {
    let pattern = page.pattern()?;
    let rows = match pattern {
        Some(pattern) => {
            rate_limit(&state, format!("home-search:{}", client_address(&headers)), SEARCHES_PER_ADDRESS)?;
            sqlx::query(&format!(
                "{LISTING_SELECT} AND h.owner_id IN (
                   SELECT id FROM users WHERE username ILIKE $3 OR display_name ILIKE $3
                   UNION SELECT owner_id FROM homes WHERE title ILIKE $3)
                 {LISTING_ORDER}"
            ))
            .bind(page.before())
            .bind(page.limit())
            .bind(pattern)
            .fetch_all(&state.db)
            .await?
        }
        None => {
            sqlx::query(&format!("{LISTING_SELECT} {LISTING_ORDER}"))
                .bind(page.before())
                .bind(page.limit())
                .fetch_all(&state.db)
                .await?
        }
    };
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
    // Picking a 미니미 means walking as it: a look the owner wore comes off, in the same transaction, so neither change
    // is kept without the other.
    let picked = minime.is_some();
    let visibility_set = changes.visibility.is_some();
    let mut tx = state.db.begin().await?;
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
    .execute(&mut *tx)
    .await?;
    if picked {
        crate::looks::take_off(&mut *tx, user.id).await?;
    }
    tx.commit().await?;
    // Whoever stands on the island and no longer may is let out.
    if visibility_set {
        crate::rooms::revalidate(&state, &user.username).await;
    }
    let home = my_home(&state, &user).await?;
    home_view(&state, home, true).await
}

/// What a picture save sends.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PictureSave {
    /// The account the page was loaded for. A missing value must refuse the save.
    expected_owner_id: Option<Uuid>,
    /// A `data:image/jpeg;base64,` (or PNG) URL.
    image: String,
}

/// `PUT /api/homes/me/thumbnail`: the picture the island's link preview shows ([`crate::share`]), answered with the
/// island's view. The body is read only once the sender is known and within its budget, and only up to a picture's
/// size; the picture is read, cropped to the preview and encoded again before it is stored.
async fn save_thumbnail(State(state): State<AppState>, headers: HeaderMap, body: Body) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("thumbnail:{}", user.id), THUMBNAILS_PER_WINDOW)?;
    let bytes = limited_body(body, MAX_THUMBNAIL_REQUEST_BYTES, share::PICTURE_TOO_LARGE, PICTURE_CUT_SHORT).await?;
    let save: PictureSave = serde_json::from_slice(&bytes).map_err(|_| share::INVALID_PICTURE)?;
    drop(bytes);
    same_owner(save.expected_owner_id, user.id)?;
    let picture = share::picture(save.image).await?;
    let url = state.config.models.put("jpg", picture).await?;
    create(&state.db, &user).await?;
    sqlx::query("UPDATE homes SET thumbnail_url = $2, updated_at = now() WHERE owner_id = $1")
        .bind(user.id)
        .bind(url)
        .execute(&state.db)
        .await?;
    let home = my_home(&state, &user).await?;
    home_view(&state, home, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerOnly {
    expected_owner_id: Option<Uuid>,
}

/// `DELETE /api/homes/me/thumbnail`: the link preview shows the site's own picture again. The stored file stays, as
/// every stored file does (it is named by its bytes).
async fn remove_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<OwnerOnly>,
) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    create(&state.db, &user).await?;
    sqlx::query("UPDATE homes SET thumbnail_url = NULL, updated_at = now() WHERE owner_id = $1")
        .bind(user.id)
        .execute(&state.db)
        .await?;
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

/// `{worldId, revision, data, updatedAt}` with the stored envelope (`data`, the text PostgreSQL keeps) written in as it
/// is, not parsed and written again.
fn world_body(row: &PgRow, data: &str) -> String {
    format!(
        r#"{{"worldId":{},"revision":{},"data":{},"updatedAt":{}}}"#,
        Value::from(row.get::<String, _>("world_id")),
        row.get::<i64, _>("revision"),
        data,
        json!(row.get::<DateTime<Utc>, _>("updated_at")),
    )
}

/// A world's body as it is sent: gzipped, past the response compression that would compress it again for each load.
fn gzipped_world(gzipped: Bytes) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CONTENT_ENCODING, "gzip"),
            (header::VARY, "accept-encoding"),
        ],
        gzipped,
    )
        .into_response()
}

fn gzip(body: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(body)?;
    encoder.finish()
}

/// Whether the request takes a gzipped body (`Accept-Encoding: gzip`, not at q=0).
fn takes_gzip(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT_ENCODING).iter().filter_map(|value| value.to_str().ok()).any(|value| {
        value.split(',').any(|coding| {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or_default().trim();
            let weight = parts
                .find_map(|param| param.trim().strip_prefix("q=").map(|q| q.trim().parse::<f32>().unwrap_or(0.0)))
                .unwrap_or(1.0);
            (name.eq_ignore_ascii_case("gzip") || name == "*") && weight > 0.0
        })
    })
}

/// A stored world's entity tag: its revision and the microsecond it was saved. The revision alone could come back: a
/// world pushed out (see [`MAX_WORLDS`]) and saved again starts over at 1.
fn world_tag(revision: i64, updated_at: DateTime<Utc>) -> String {
    format!("\"r{revision}.{}\"", updated_at.timestamp_micros())
}

/// The revision and save time of the world the browser holds, from an `If-None-Match` in [`world_tag`]'s shape (also
/// weakened, as a cache on the way may do); None for anything else.
fn known_world(headers: &HeaderMap) -> Option<(i64, DateTime<Utc>)> {
    let tags = headers.get(header::IF_NONE_MATCH)?.to_str().ok()?;
    tags.split(',').find_map(|tag| {
        let tag = tag.trim();
        let (revision, micros) =
            tag.strip_prefix("W/").unwrap_or(tag).strip_prefix("\"r")?.strip_suffix('"')?.split_once('.')?;
        Some((revision.parse().ok()?, DateTime::from_timestamp_micros(micros.parse().ok()?)?))
    })
}

/// 204 until the owner first saves: a fresh island is the normal state, not an error. A world comes with its
/// [`world_tag`] and is checked again before each reuse; a browser that holds the stored one gets a 304, and the
/// envelope is not even read out of storage. Who may view the island is checked first either way. Loads are counted
/// per address for visitors and per member for members. A world goes out gzipped once for every load of the same
/// revision (see [`WorldCache`]), so the database sends it and the server compresses it once per save.
async fn world(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<WorldQuery>,
) -> ApiResult<Response> {
    let viewer = optional_user(&state, &headers).await?;
    match &viewer {
        None => rate_limit(&state, format!("world-read:{}", client_address(&headers)), WORLD_READS_PER_ADDRESS)?,
        Some(user) => rate_limit(&state, format!("world-read-member:{}", user.id), WORLD_READS_PER_MEMBER)?,
    }
    let (home, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let world = world_id(&query.world_id)?;
    let (revision, saved_at) = known_world(&headers).unzip();
    let gzip_taken = takes_gzip(&headers);
    let cached = if gzip_taken { state.homes.worlds().get(home.owner_id, world) } else { None };
    let row = sqlx::query(
        "SELECT world_id, revision, updated_at,
           CASE WHEN (revision = $3 AND updated_at = $4) OR (revision = $5 AND updated_at = $6) THEN NULL
             ELSE data::text END AS data
         FROM home_worlds WHERE owner_id = $1 AND world_id = $2",
    )
    .bind(home.owner_id)
    .bind(world)
    .bind(revision)
    .bind(saved_at)
    .bind(cached.as_ref().map(|cached| cached.revision))
    .bind(cached.as_ref().map(|cached| cached.updated_at))
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(StatusCode::NO_CONTENT.into_response()) };
    let stored: (i64, DateTime<Utc>) = (row.get("revision"), row.get("updated_at"));
    let mut response = if (revision, saved_at) == (Some(stored.0), Some(stored.1)) {
        StatusCode::NOT_MODIFIED.into_response()
    } else if let Some(cached) = cached.filter(|cached| (cached.revision, cached.updated_at) == stored) {
        gzipped_world(cached.gzipped)
    } else {
        let data: &str = row.get::<Option<&str>, _>("data").ok_or_else(|| internal("a world without its data"))?;
        let body = world_body(&row, data);
        if gzip_taken {
            let gzipped = Bytes::from(
                tokio::task::spawn_blocking(move || gzip(body.as_bytes()))
                    .await
                    .map_err(internal)?
                    .map_err(internal)?,
            );
            state.homes.worlds().put(home.owner_id, world, stored.0, stored.1, gzipped.clone());
            gzipped_world(gzipped)
        } else {
            ([(header::CONTENT_TYPE, "application/json")], body).into_response()
        }
    };
    let tag = HeaderValue::from_str(&world_tag(stored.0, stored.1)).map_err(internal)?;
    let headers = response.headers_mut();
    headers.insert(header::ETAG, tag);
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    Ok(response)
}

/// A save request. The envelope (`data`) stays the text it came as: it is checked as it is read (see [`scan_world`])
/// and stored as it is, never built into a tree of values (one of up to 2 MiB would take tens of megabytes).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorld<'a> {
    /// The account the page was loaded for. Missing/null is not a current-account fallback.
    expected_owner_id: Option<Uuid>,
    world_id: String,
    base_revision: i64,
    #[serde(borrow)]
    data: &'a RawValue,
}

/// Whether `key` ends with `suffix`, capitals aside.
fn ends_with_ignoring_case(key: &str, suffix: &str) -> bool {
    key.len() >= suffix.len() && key.as_bytes()[key.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

/// Keys whose string values a visitor's browser fetches: model, texture and image URLs.
fn fetched_key(key: &str) -> bool {
    ends_with_ignoring_case(key, "url") || ends_with_ignoring_case(key, "texture")
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

/// What reading a save envelope found: the runtime's envelope rules, text the database cannot keep (a NUL), asset
/// URLs off the platform, and the residents domain, the one part kept as a value (it is small, and checked against the
/// catalog).
#[derive(Default)]
struct Scan {
    /// `version`: a whole number of at least 1.
    version: bool,
    /// `savedAt`: a finite number of at least 0.
    saved_at: bool,
    /// `domains`: an object of at most [`MAX_DOMAINS`] domains, once read.
    domains: Option<bool>,
    nul: bool,
    url: bool,
    residents: Option<Value>,
    /// The residents domain was larger than any island's could be: reading stopped there.
    crowded: bool,
}

impl Scan {
    /// Why the envelope may not be stored, the runtime's rules first.
    fn problem(&self) -> Option<&'static str> {
        if !self.version {
            Some("version")
        } else if !self.saved_at {
            Some("savedAt")
        } else if self.domains != Some(true) {
            Some("domains")
        } else if self.nul {
            Some("nul")
        } else if self.url {
            Some("url")
        } else {
            None
        }
    }
}

/// A number seen where the envelope wants one.
#[derive(Clone, Copy)]
enum Seen {
    Whole(i64),
    Number(f64),
    Other,
}

/// Reads any JSON value without keeping it: a NUL in a key or string is noted, and so, inside the domains (`urls`), is
/// a string under a fetched key ([`fetched_key`]) that is not one of the platform's assets.
struct Walk<'s> {
    scan: &'s mut Scan,
    urls: bool,
    /// The value sits under a fetched key.
    fetched: bool,
}

impl<'de> DeserializeSeed<'de> for Walk<'_> {
    type Value = Seen;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Seen, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Walk<'_> {
    type Value = Seen;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Seen, E> {
        Ok(Seen::Other)
    }

    fn visit_i64<E>(self, value: i64) -> Result<Seen, E> {
        Ok(Seen::Whole(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Seen, E> {
        Ok(i64::try_from(value).map_or(Seen::Number(value as f64), Seen::Whole))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Seen, E> {
        Ok(Seen::Number(value))
    }

    fn visit_unit<E>(self) -> Result<Seen, E> {
        Ok(Seen::Other)
    }

    fn visit_str<E>(self, value: &str) -> Result<Seen, E> {
        self.scan.nul |= value.contains('\0');
        self.scan.url |= self.urls && self.fetched && !safe_asset_url(value);
        Ok(Seen::Other)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Seen, A::Error> {
        while items.next_element_seed(Walk { scan: &mut *self.scan, urls: self.urls, fetched: false })?.is_some() {}
        Ok(Seen::Other)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<Seen, A::Error> {
        while let Some(fetched) = entries.next_key_seed(Key { scan: &mut *self.scan })? {
            entries.next_value_seed(Walk { scan: &mut *self.scan, urls: self.urls, fetched })?;
        }
        Ok(Seen::Other)
    }
}

/// An object's key: a NUL in it is noted; whether a string under it is fetched comes back.
struct Key<'s> {
    scan: &'s mut Scan,
}

impl<'de> DeserializeSeed<'de> for Key<'_> {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<bool, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for Key<'_> {
    type Value = bool;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a key")
    }

    fn visit_str<E>(self, key: &str) -> Result<bool, E> {
        self.scan.nul |= key.contains('\0');
        Ok(fetched_key(key))
    }
}

/// The envelope itself: `{version, savedAt, domains, …}`.
struct Envelope<'s> {
    scan: &'s mut Scan,
}

impl<'de> DeserializeSeed<'de> for Envelope<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Envelope<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a save envelope")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<(), A::Error> {
        while let Some(key) = entries.next_key::<String>()? {
            self.scan.nul |= key.contains('\0');
            let walk = Walk { scan: &mut *self.scan, urls: false, fetched: false };
            match key.as_str() {
                "version" => {
                    let seen = entries.next_value_seed(walk)?;
                    self.scan.version = matches!(seen, Seen::Whole(version) if version >= 1);
                }
                "savedAt" => {
                    let saved = match entries.next_value_seed(walk)? {
                        Seen::Whole(at) => Some(at as f64),
                        Seen::Number(at) => Some(at),
                        Seen::Other => None,
                    };
                    self.scan.saved_at = saved.is_some_and(|at| at.is_finite() && at >= 0.0);
                }
                "domains" => {
                    self.scan.residents = None;
                    entries.next_value_seed(Domains { scan: &mut *self.scan })?;
                }
                _ => {
                    entries.next_value_seed(walk)?;
                }
            }
        }
        Ok(())
    }
}

/// The envelope's domains: an object of at most [`MAX_DOMAINS`], each read as a [`Walk`] that checks URLs, the
/// residents domain kept as a value.
struct Domains<'s> {
    scan: &'s mut Scan,
}

impl<'de> DeserializeSeed<'de> for Domains<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Domains<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("the domains")
    }

    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<(), E> {
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_str<E>(self, value: &str) -> Result<(), E> {
        self.scan.nul |= value.contains('\0');
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, items: A) -> Result<(), A::Error> {
        Walk { scan: &mut *self.scan, urls: false, fetched: false }.visit_seq(items)?;
        self.scan.domains = Some(false);
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<(), A::Error> {
        let mut count = 0;
        while let Some(key) = entries.next_key::<String>()? {
            count += 1;
            self.scan.nul |= key.contains('\0');
            if key == crate::residents::DOMAIN {
                let mut left = MAX_RESIDENT_NODES;
                match entries.next_value_seed(Capture { left: &mut left }) {
                    Ok(residents) => {
                        self.scan.nul |= holds_nul(&residents);
                        self.scan.url |= unsafe_url(&residents);
                        self.scan.residents = Some(residents);
                    }
                    Err(error) => {
                        self.scan.crowded = left == 0;
                        return Err(error);
                    }
                }
            } else {
                entries.next_value_seed(Walk { scan: &mut *self.scan, urls: true, fetched: false })?;
            }
        }
        self.scan.domains = Some(count <= MAX_DOMAINS);
        Ok(())
    }
}

/// Reads a value into memory, [`MAX_RESIDENT_NODES`] nodes at most (`left` counts down): past that, reading stops.
struct Capture<'l> {
    left: &'l mut usize,
}

impl Capture<'_> {
    fn take<E: de::Error>(&mut self) -> Result<(), E> {
        *self.left = self.left.checked_sub(1).ok_or_else(|| E::custom("too many residents"))?;
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for Capture<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Capture<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(mut self, value: bool) -> Result<Value, E> {
        self.take()?;
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(mut self, value: i64) -> Result<Value, E> {
        self.take()?;
        Ok(Value::from(value))
    }

    fn visit_u64<E: de::Error>(mut self, value: u64) -> Result<Value, E> {
        self.take()?;
        Ok(Value::from(value))
    }

    fn visit_f64<E: de::Error>(mut self, value: f64) -> Result<Value, E> {
        self.take()?;
        Ok(Value::from(value))
    }

    fn visit_unit<E: de::Error>(mut self) -> Result<Value, E> {
        self.take()?;
        Ok(Value::Null)
    }

    fn visit_str<E: de::Error>(mut self, value: &str) -> Result<Value, E> {
        self.take()?;
        Ok(Value::from(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(mut self, mut items: A) -> Result<Value, A::Error> {
        self.take()?;
        let mut list = Vec::new();
        while let Some(item) = items.next_element_seed(Capture { left: &mut *self.left })? {
            list.push(item);
        }
        Ok(Value::Array(list))
    }

    fn visit_map<A: MapAccess<'de>>(mut self, mut entries: A) -> Result<Value, A::Error> {
        self.take()?;
        let mut map = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            let value = entries.next_value_seed(Capture { left: &mut *self.left })?;
            map.insert(key, value);
        }
        Ok(Value::Object(map))
    }
}

/// Whether a string under a fetched key anywhere in `value` is not one of the platform's assets.
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

/// Reads the envelope `data` (the text of a JSON object) as [`Scan`] says, without keeping more than its residents.
/// Err when it is not an envelope at all (not an object, or residents past any island's).
fn scan_world(data: &str) -> Result<Scan, Scan> {
    let mut scan = Scan::default();
    let mut deserializer = serde_json::Deserializer::from_str(data);
    let read = Envelope { scan: &mut scan }.deserialize(&mut deserializer).and_then(|()| deserializer.end());
    match read {
        Ok(()) => Ok(scan),
        Err(_) => Err(scan),
    }
}

/// The residents a save places, as far as its own text says: a domain that is none, or the catalog items it names (none
/// without the domain).
enum Residents {
    Bad(&'static str),
    Items(Vec<String>),
}

/// A save request read and checked: its envelope as it is stored (and measured), and its residents.
struct Checked {
    world_id: String,
    base_revision: i64,
    data: String,
    residents: Residents,
}

/// The request body as `owner`'s save, its envelope measured and checked; for a blocking thread, since it is up to
/// 2 MiB. Nothing of it stays in memory but the envelope's text and its residents.
fn check_save(bytes: &[u8], owner: Uuid) -> ApiResult<Checked> {
    let save: SaveWorld = serde_json::from_slice(bytes).map_err(|_| INVALID_WORLD)?;
    same_owner(save.expected_owner_id, owner)?;
    world_id(&save.world_id)?;
    let data = save.data.get();
    if data.len() > MAX_WORLD_BYTES {
        return Err(WORLD_TOO_LARGE);
    }
    let scan = match scan_world(data) {
        Ok(scan) => scan,
        Err(scan) if scan.crowded => {
            tracing::warn!(problem = "residents_count", user = %owner, "Rejected world save");
            return Err(INVALID_RESIDENTS);
        }
        Err(_) => return Err(INVALID_WORLD),
    };
    if let Some(problem) = scan.problem() {
        tracing::warn!(problem, user = %owner, "Rejected world save");
        return Err(INVALID_WORLD);
    }
    let residents = match scan.residents.as_ref().map(crate::residents::shape) {
        None => Residents::Items(Vec::new()),
        Some(Ok(items)) => Residents::Items(items),
        Some(Err(problem)) => Residents::Bad(problem),
    };
    Ok(Checked { world_id: save.world_id, base_revision: save.base_revision, data: data.to_owned(), residents })
}

/// What a save answers with: the stored world's id, revision and time. The page has the envelope it sent, and an
/// autosave every few seconds should not carry up to 2 MiB back.
const SAVED_COLUMNS: &str = "world_id, revision, updated_at";

/// Stores a save under a lock on the owner's home: a first save makes the world's row (None when it exists already),
/// a later one needs the revision it was based on (None when another save came first). The owner then keeps at most
/// [`MAX_WORLDS`] worlds and [`MAX_MEMBER_WORLD_BYTES`] in all: the least recently updated of the others make room,
/// never the one saved here, so saves made at once cannot pass either cap. The island moves up the listing at most
/// every [`LISTED_EVERY`].
async fn store(db: &PgPool, owner: Uuid, save: &Checked) -> ApiResult<Option<PgRow>> {
    let bytes = save.data.len() as i32;
    let mut tx = db.begin().await?;
    sqlx::query("SELECT 1 FROM homes WHERE owner_id = $1 FOR UPDATE").bind(owner).execute(&mut *tx).await?;
    let row = if save.base_revision == 0 {
        sqlx::query(&format!(
            "INSERT INTO home_worlds (owner_id, world_id, revision, data, byte_size) VALUES ($1, $2, 1, $3::jsonb, $4)
             ON CONFLICT DO NOTHING RETURNING {SAVED_COLUMNS}"
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
             WHERE owner_id = $1 AND world_id = $2 AND revision = $5 RETURNING {SAVED_COLUMNS}"
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
        sqlx::query(&format!(
            "UPDATE homes SET updated_at = now() WHERE owner_id = $1 AND updated_at < now() - interval '{LISTED_EVERY}'"
        ))
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(row)
}

/// A request's body, up to `max` bytes. Only a body past that is `too_large`; one that stops coming (the connection
/// dropped) is `cut_short`.
async fn limited_body(body: Body, max: usize, too_large: ApiError, cut_short: ApiError) -> ApiResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { return Err(cut_short) };
        if chunk.len() > max.saturating_sub(bytes.len()) {
            return Err(too_large);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// `PUT /api/homes/me/world`: `{worldId, revision, updatedAt}` of the stored world. The body is read only once the
/// sender is known and within its budget, with no other save of theirs under way, and once the save has one of the
/// site's [`SAVE_SLOTS`]: however many saves come at once, a few bodies are held, and none is ever built into a tree.
async fn save_world(State(state): State<AppState>, headers: HeaderMap, body: Body) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("world:{}", user.id), WORLD_SAVES_PER_WINDOW)?;
    // A body that says it is past the limit is refused before anything waits for it.
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_SAVE_BYTES as u64) {
        return Err(WORLD_TOO_LARGE);
    }
    let _saving = state.homes.begin(user.id)?;
    let _slot = tokio::time::timeout(SAVE_WAIT, state.homes.saving.clone().acquire_owned())
        .await
        .map_err(|_| SAVES_BUSY)?
        .map_err(internal)?;
    let bytes = limited_body(body, MAX_SAVE_BYTES, WORLD_TOO_LARGE, WORLD_CUT_SHORT).await?;
    let owner = user.id;
    let save = tokio::task::spawn_blocking(move || check_save(&bytes, owner)).await.map_err(internal)??;
    create(&state.db, &user).await?;
    let problem = match &save.residents {
        Residents::Bad(problem) => Some(*problem),
        Residents::Items(items) => crate::residents::unknown(&state.db, items).await?.then_some("resident_npc"),
    };
    if let Some(problem) = problem {
        tracing::warn!(problem, user = %user.id, "Rejected world save");
        return Err(INVALID_RESIDENTS);
    }
    let row = store(&state.db, user.id, &save)
        .await?
        .ok_or(conflict("revision_conflict", "다른 곳에서 먼저 저장했어요. 새로 불러온 뒤 다시 저장해 주세요."))?;
    Ok(Json(json!({
        "worldId": row.get::<String, _>("world_id"),
        "revision": row.get::<i64, _>("revision"),
        "updatedAt": row.get::<DateTime<Utc>, _>("updated_at"),
    })))
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

    /// What reading `envelope` finds wrong with it, as a save would.
    fn world_problem(envelope: Value) -> Option<&'static str> {
        match scan_world(&envelope.to_string()) {
            Ok(scan) => scan.problem(),
            Err(scan) if scan.crowded => Some("residents_count"),
            Err(_) => Some("not_an_envelope"),
        }
    }

    #[test]
    fn world_envelope_and_nested_urls_are_checked() {
        let ok = json!({"version": 1, "savedAt": 1, "domains": {"building": {"objects": [{"config": {"modelUrl": "gltf/props/bed.glb"}}]}}});
        assert_eq!(world_problem(ok), None);
        let evil = json!({"version": 1, "savedAt": 1, "domains": {"building": {"meshes": [{"mapTextureUrl": "https://x.y/t.png"}]}}});
        assert_eq!(world_problem(evil), Some("url"));
        let shouting = json!({"version": 1, "savedAt": 1, "domains": {"building": {"MODELURL": "https://x.y/m.glb"}}});
        assert_eq!(world_problem(shouting), Some("url"));
        assert_eq!(world_problem(json!({"version": 0, "savedAt": 1, "domains": {}})), Some("version"));
        assert_eq!(world_problem(json!({"version": 1.5, "savedAt": 1, "domains": {}})), Some("version"));
        assert_eq!(world_problem(json!({"version": 1, "savedAt": -1, "domains": {}})), Some("savedAt"));
        assert_eq!(world_problem(json!({"version": 1, "savedAt": 2.5, "domains": {}})), None);
        assert_eq!(world_problem(json!({"version": 1, "savedAt": 1})), Some("domains"));
        assert_eq!(world_problem(json!({"version": 1, "savedAt": 1, "domains": [1]})), Some("domains"));
        let crowded: Map<String, Value> = (0..=MAX_DOMAINS).map(|at| (format!("d{at}"), json!({}))).collect();
        assert_eq!(world_problem(json!({"version": 1, "savedAt": 1, "domains": crowded})), Some("domains"));
        assert_eq!(world_problem(json!([1, 2])), Some("not_an_envelope"));
        // PostgreSQL cannot keep a NUL in JSON: refused here, before the database would fail on it.
        let nul = json!({"version": 1, "savedAt": 1, "domains": {"building": {"note": "a\u{0}b"}}});
        assert_eq!(world_problem(nul), Some("nul"));
        let nul_key = json!({"version": 1, "savedAt": 1, "domains": {"building": {"a\u{0}": 1}}});
        assert_eq!(world_problem(nul_key), Some("nul"));
        let nul_outside = json!({"version": 1, "savedAt": 1, "domains": {}, "note": ["a\u{0}"]});
        assert_eq!(world_problem(nul_outside), Some("nul"));
        let lines = json!({"version": 1, "savedAt": 1, "domains": {"building": {"note": "a\nb\tc"}}});
        assert_eq!(world_problem(lines), None);
        // Only strings right under a fetched key are fetched; what sits outside the domains is the runtime's own.
        let listed = json!({"version": 1, "savedAt": 1, "domains": {"building": {"modelUrl": ["https://x.y/m.glb"]}}});
        assert_eq!(world_problem(listed), None);
        let outside = json!({"version": 1, "savedAt": 1, "domains": {}, "meta": {"iconUrl": "https://x.y/i.png"}});
        assert_eq!(world_problem(outside), None);
    }

    #[test]
    fn a_huge_island_is_read_without_being_kept_and_only_its_residents_are() {
        // About a million numbers: read as values it would take tens of megabytes; here nothing of it stays.
        let numbers = format!("[{}0]", "0,".repeat(1_000_000));
        let envelope = format!(r#"{{"version":1,"savedAt":1,"domains":{{"building":{{"x":{numbers}}}}}}}"#);
        let scan = scan_world(&envelope).ok().unwrap();
        assert_eq!((scan.problem(), scan.residents.is_none()), (None, true));
        let resident =
            json!({"id": "a", "npc": "npc-hero", "name": "모개", "greeting": "", "position": [0, 0, 0], "rotation": 0});
        let residents = json!({"version": 1, "residents": [resident]});
        let scan = scan_world(&json!({"version": 1, "savedAt": 1, "domains": {"residents": residents}}).to_string());
        assert_eq!(scan.ok().unwrap().residents, Some(residents));
        // Residents past any island's stop the reading there.
        let crowd =
            format!(r#"{{"version":1,"savedAt":1,"domains":{{"residents":{{"version":1,"residents":{numbers}}}}}}}"#);
        assert!(scan_world(&crowd).err().is_some_and(|scan| scan.crowded));
        let residents_url =
            json!({"version": 1, "savedAt": 1, "domains": {"residents": {"modelUrl": "https://x.y/m.glb"}}});
        assert_eq!(world_problem(residents_url), Some("url"));
    }

    #[test]
    fn gzip_is_taken_as_the_request_says() {
        let taking = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
            takes_gzip(&headers)
        };
        assert!(taking("gzip, deflate, br, zstd"));
        assert!(taking("br;q=1.0, GZIP;q=0.5"));
        assert!(taking("*"));
        assert!(!taking("br"));
        assert!(!taking("gzip;q=0"));
        assert!(!taking("identity"));
        assert!(!takes_gzip(&HeaderMap::new()));
    }

    #[test]
    fn the_world_cache_keeps_the_most_recently_used_within_its_bytes() {
        let mut cache = WorldCache::default();
        let (owner, at) = (Uuid::new_v4(), Utc::now());
        let quarter = Bytes::from(vec![0u8; WORLD_CACHE_BYTES / 4]);
        for world in ["a", "b", "c", "d"] {
            cache.put(owner, world, 1, at, quarter.clone());
        }
        assert!(cache.get(owner, "a").is_some());
        cache.put(owner, "e", 1, at, quarter.clone());
        assert!(cache.get(owner, "b").is_none(), "the least recently used made room");
        assert!(cache.get(owner, "a").is_some() && cache.get(owner, "e").is_some());
        cache.put(owner, "a", 2, at, Bytes::from_static(b"x"));
        assert_eq!(cache.get(owner, "a").map(|entry| entry.revision), Some(2));
        assert!(cache.bytes <= WORLD_CACHE_BYTES);
        cache.put(owner, "huge", 1, at, Bytes::from(vec![0u8; WORLD_CACHE_BYTES / 4 + 1]));
        assert!(cache.get(owner, "huge").is_none());
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
