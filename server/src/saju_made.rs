//! What the server makes for a 사주 home with a paid model: a reading of its 사주 and 자미두수 written by a GPT model
//! ("사주·자미두수 풀이", `saju_reading`), and its island drawn again as a 미연시 illustration by an image model ("미연시
//! 시그"). Each is made once for the home's current birth ([`Birth::key`]) and shown to whoever may see the home; the
//! owner may ask for it again within limits. A request records the work as pending and answers at once; the work runs
//! on a task of its own and records what it came to, and a read shows how far it is. A pending one older than
//! [`STALE_MINUTES`] was cut short by a restart and reads as failed.

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use image::{ImageFormat, ImageReader};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgExecutor, PgPool, Row, postgres::PgRow};
use std::{io::Cursor, panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{current_user, optional_user},
    config::OpenAi,
    error::{ApiError, ApiResult, conflict, internal, not_found},
    homes::{limited_body, same_owner, visible_home},
    openai::{self, Failure, Image},
    runtime::retry,
    saju::Birth,
    saju_reading::{self, ReadingChart},
    security::rate_limit,
};

/// A pending reading or picture older than this was cut short (a restart) and reads as failed, `interrupted`. Work
/// ends well inside it: a call waits at most [`CALL_WAIT`] for its turn and takes at most the configured timeout.
const STALE_MINUTES: i32 = 10;
/// How long work waits for one of the calls allowed at once before it fails as busy.
const CALL_WAIT: Duration = Duration::from_secs(60);
/// A reading request: the chart and the fields around it.
const READING_REQUEST_BYTES: usize = 64 * 1024;
/// The island picture sent to be drawn again: exactly this wide and tall, and at most this many bytes decoded.
pub const PICTURE_EDGE: u32 = 1024;
pub const MAX_PICTURE_BYTES: usize = 3 * 1024 * 1024;
/// A picture request: the picture as base64 and the fields around it.
const MAX_PICTURE_REQUEST_BYTES: usize = MAX_PICTURE_BYTES.div_ceil(3) * 4 + 4096;
/// The largest side a drawn picture may come back with.
const MAX_DRAWN_EDGE: u32 = 4096;
/// Requests for a reading or a picture one member may make in the rate window (ten minutes).
const REQUESTS_PER_WINDOW: u32 = 30;
/// Work of each kind admitted at once across the server (waiting for its call or calling), and calls under way.
const READINGS_ADMITTED: usize = 32;
const READINGS_CALLING: usize = 8;
const PICTURES_ADMITTED: usize = 8;
const PICTURES_CALLING: usize = 3;
/// What the island is drawn again as.
const PICTURE_PROMPT: &str = "Redraw this isometric island diorama as a background CG from a Korean or Japanese \
    visual novel (a bishoujo game, 미연시): clean line art, soft cel shading, luminous colour, and a dreamy sky at the \
    hour of day the island is shown at. Keep the island's composition and viewpoint, the house with its shape and its \
    colours, the garden and its plants, the guardian dog, and the lanterns. No people, no text or letters, no logo, no \
    watermark, no frame.";

const NO_HOME: ApiError = not_found("saju_not_found", "아직 지은 사주 집이 없어요.");
const STALE_BIRTH: ApiError = conflict("stale_birth", "집의 생일이 바뀌었어요. 화면을 새로 불러와 주세요.");
const INVALID_CHART: ApiError = ApiError::new(StatusCode::BAD_REQUEST, "invalid_chart", "풀이할 수 없는 명식이에요.");
const INVALID_IMAGE: ApiError =
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_image", "1024×1024 크기의 WebP·PNG·JPEG 그림만 보낼 수 있어요.");
const IMAGE_TOO_LARGE: ApiError =
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "image_too_large", "그림이 너무 커요. 3MB까지 보낼 수 있어요.");
const IMAGE_CUT_SHORT: ApiError =
    ApiError::new(StatusCode::BAD_REQUEST, "incomplete_image", "그림을 끝까지 받지 못했어요. 다시 보내 주세요.");

/// What a member's home has made for it with a paid model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Reading,
    Picture,
}

impl Kind {
    /// Its name in `saju_paid_calls` and `saju_paid_months`.
    fn name(self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Picture => "picture",
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Reading => "saju_readings",
            Self::Picture => "saju_pictures",
        }
    }

    /// The columns that hold what was made.
    fn made(self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Picture => "url, width, height",
        }
    }

    fn model(self, openai: &OpenAi) -> &str {
        match self {
            Self::Reading => &openai.reading_model,
            Self::Picture => &openai.picture_model,
        }
    }

    fn monthly(self, openai: &OpenAi) -> i64 {
        match self {
            Self::Reading => openai.readings_monthly,
            Self::Picture => openai.pictures_monthly,
        }
    }

    /// Calls a member may make to replace one already made (`again`), and the window they are counted in.
    fn again(self) -> (i64, &'static str) {
        match self {
            Self::Reading => (3, "1 day"),
            Self::Picture => (2, "1 month"),
        }
    }

    /// Without a key, or with the month's budget spent.
    fn unavailable(self) -> ApiError {
        match self {
            Self::Reading => {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "reading_unavailable", "지금은 풀이를 받을 수 없어요.")
            }
            Self::Picture => {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "picture_unavailable", "지금은 그림을 그릴 수 없어요.")
            }
        }
    }

    fn limited(self) -> ApiError {
        match self {
            Self::Reading => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "reading_limit",
                "풀이는 하루에 세 번까지 다시 받을 수 있어요.",
            ),
            Self::Picture => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "picture_limit",
                "그림은 한 달에 두 번까지 다시 그릴 수 있어요.",
            ),
        }
    }

    /// All the work of its kind the server takes at once is under way.
    fn busy(self) -> ApiError {
        let code = match self {
            Self::Reading => "reading_busy",
            Self::Picture => "picture_busy",
        };
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, code, self.message("provider_busy"))
    }

    /// What a failed one says, by its code: this server's own words, never the provider's.
    fn message(self, code: &str) -> &'static str {
        match (self, code) {
            (Self::Reading, "interrupted") => "서버가 다시 시작되어 풀이가 멈췄어요. 다시 요청해 주세요.",
            (Self::Reading, "timeout") => "풀이가 너무 오래 걸려 멈췄어요. 다시 요청해 주세요.",
            (Self::Reading, "refused") => "이 명식으로는 풀이를 받지 못했어요. 다시 요청해 주세요.",
            (Self::Reading, "incomplete") => "풀이가 끝까지 쓰이지 못했어요. 다시 요청해 주세요.",
            (Self::Reading, "bad_output") => "풀이를 제대로 받지 못했어요. 다시 요청해 주세요.",
            (Self::Reading, "provider_busy") => "지금 풀이를 쓰는 사람이 많아요. 잠시 뒤에 다시 요청해 주세요.",
            (Self::Reading, "provider_unavailable") => "풀이 서버에 닿지 못했어요. 잠시 뒤에 다시 요청해 주세요.",
            (Self::Reading, _) => "풀이를 쓰지 못했어요. 다시 요청해 주세요.",
            (Self::Picture, "interrupted") => "서버가 다시 시작되어 그림이 멈췄어요. 다시 요청해 주세요.",
            (Self::Picture, "timeout") => "그림이 너무 오래 걸려 멈췄어요. 다시 요청해 주세요.",
            (Self::Picture, "refused") => "이 섬 그림으로는 다시 그리지 못했어요. 다시 요청해 주세요.",
            (Self::Picture, "bad_output") => "그림을 제대로 받지 못했어요. 다시 요청해 주세요.",
            (Self::Picture, "provider_busy") => "지금 그림을 그리는 사람이 많아요. 잠시 뒤에 다시 요청해 주세요.",
            (Self::Picture, "provider_unavailable") => "그림 서버에 닿지 못했어요. 잠시 뒤에 다시 요청해 주세요.",
            (Self::Picture, _) => "그림을 그리지 못했어요. 다시 요청해 주세요.",
        }
    }
}

/// Work admitted and calls under way, per kind (see [`READINGS_ADMITTED`]).
#[derive(Clone)]
pub struct Slots {
    readings: Arc<Semaphore>,
    reading_calls: Arc<Semaphore>,
    pictures: Arc<Semaphore>,
    picture_calls: Arc<Semaphore>,
}

impl Default for Slots {
    fn default() -> Self {
        Self {
            readings: Arc::new(Semaphore::new(READINGS_ADMITTED)),
            reading_calls: Arc::new(Semaphore::new(READINGS_CALLING)),
            pictures: Arc::new(Semaphore::new(PICTURES_ADMITTED)),
            picture_calls: Arc::new(Semaphore::new(PICTURES_CALLING)),
        }
    }
}

impl Slots {
    fn admitted(&self, kind: Kind) -> &Arc<Semaphore> {
        match kind {
            Kind::Reading => &self.readings,
            Kind::Picture => &self.pictures,
        }
    }

    fn calling(&self, kind: Kind) -> &Arc<Semaphore> {
        match kind {
            Kind::Reading => &self.reading_calls,
            Kind::Picture => &self.picture_calls,
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        // A chart has a body limit of its own, whatever the routes around it take; the picture route reads its own
        // body up to a picture's size (`draw`).
        .route("/api/homes/me/saju/reading", post(read).layer(DefaultBodyLimit::max(READING_REQUEST_BYTES)))
        .route("/api/homes/me/saju/picture", post(draw))
        .route("/api/homes/{username}/saju/reading", get(reading))
        .route("/api/homes/{username}/saju/picture", get(picture))
}

/// The birth `owner`'s home was built from, None without a home. `lock` holds the home's row until the transaction
/// ends: a home built again meanwhile waits, and two requests of its owner's take turns.
async fn home_birth(db: impl PgExecutor<'_>, owner: Uuid, lock: bool) -> Result<Option<Birth>, sqlx::Error> {
    let lock = if lock { " FOR UPDATE" } else { "" };
    let row = sqlx::query(&format!(
        "SELECT calendar, birth_year, birth_month, birth_day, leap_month, birth_time, gender
         FROM saju_homes WHERE owner_id = $1{lock}"
    ))
    .bind(owner)
    .fetch_optional(db)
    .await?;
    Ok(row.as_ref().map(Birth::of))
}

fn failed(kind: Kind, code: &str) -> Value {
    json!({"status": "failed", "code": code, "message": kind.message(code)})
}

/// A stored row as the app reads it (`Made<T>` in frontend/src/api/types.ts).
fn shown(kind: Kind, row: &PgRow) -> Value {
    let status: String = row.get("status");
    match status.as_str() {
        "pending" if row.get::<bool, _>("stale") => failed(kind, "interrupted"),
        "pending" => json!({"status": "pending", "since": row.get::<DateTime<Utc>, _>("started_at")}),
        "ready" => {
            let mut ready = json!({
                "status": "ready",
                "model": row.get::<String, _>("model"),
                "createdAt": row.get::<Option<DateTime<Utc>>, _>("finished_at"),
            });
            match kind {
                Kind::Reading => match row.get::<Option<Value>, _>("reading") {
                    Some(reading) => ready["reading"] = reading,
                    None => return failed(kind, "internal"),
                },
                Kind::Picture => match row.get::<Option<String>, _>("url") {
                    Some(url) => {
                        ready["url"] = url.into();
                        ready["width"] = row.get::<Option<i32>, _>("width").into();
                        ready["height"] = row.get::<Option<i32>, _>("height").into();
                    }
                    None => return failed(kind, "internal"),
                },
            }
            ready
        }
        _ => failed(kind, row.get::<Option<String>, _>("error_code").as_deref().unwrap_or("internal")),
    }
}

/// What `owner`'s home has of `kind` for the birth `key`.
async fn state_of(db: impl PgExecutor<'_>, kind: Kind, owner: Uuid, key: &str) -> Result<Value, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT status, model, error_code, started_at, finished_at, {made},
         started_at < now() - make_interval(mins => {STALE_MINUTES}) AS stale
         FROM {table} WHERE owner_id = $1 AND birth_key = $2",
        made = kind.made(),
        table = kind.table(),
    ))
    .bind(owner)
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(row.map_or_else(|| json!({"status": "none"}), |row| shown(kind, &row)))
}

/// `GET /api/homes/{username}/saju/reading`: the home's reading, as far as it has been written, for whoever may see
/// the home (as `GET /api/homes/{username}/saju`).
async fn reading(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    view(&state, &headers, &name, Kind::Reading).await
}

/// `GET /api/homes/{username}/saju/picture`: the home's 미연시 picture, as far as it has been drawn.
async fn picture(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    view(&state, &headers, &name, Kind::Picture).await
}

async fn view(state: &AppState, headers: &HeaderMap, name: &str, kind: Kind) -> ApiResult<Json<Value>> {
    let viewer = optional_user(state, headers).await?;
    let (home, _) = visible_home(state, name, viewer.as_ref()).await?;
    let Some(birth) = home_birth(&state.db, home.owner_id, false).await? else {
        return Ok(Json(json!({"status": "none"})));
    };
    let mut shown = state_of(&state.db, kind, home.owner_id, &birth.key()).await?;
    // Nothing made, and nothing can be now: the page shows no card and does not get ready a request that would be
    // refused (for the picture, the island drawn a second time off the page).
    if shown["status"] == "none" && !makes(state, kind).await? {
        shown["off"] = json!(true);
    }
    Ok(Json(shown))
}

/// Whether `kind` can be made now: there is a key, and the month's budget has a call left (as `begin` counts them).
async fn makes(state: &AppState, kind: Kind) -> Result<bool, sqlx::Error> {
    let openai = &state.config.openai;
    let monthly = kind.monthly(openai);
    if openai.api_key.is_none() || monthly <= 0 {
        return Ok(false);
    }
    let calls: Option<i32> = sqlx::query_scalar(
        "SELECT calls FROM saju_paid_months WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND kind = $1",
    )
    .bind(kind.name())
    .fetch_optional(&state.db)
    .await?;
    Ok(calls.is_none_or(|calls| i64::from(calls) < monthly))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest {
    /// The account the page was loaded for. A missing value must refuse the request.
    expected_owner_id: Option<Uuid>,
    chart: Value,
    again: Option<bool>,
}

/// `POST /api/homes/me/saju/reading` `{expectedOwnerId, chart, again?}`: the caller's reading, written from the chart
/// the browser drew from the home's birth. 200 with the reading already written for this birth (unless `again`) or
/// the one being written; otherwise 202, pending, and the reading is written in the background.
async fn read(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> ApiResult<Response> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("saju-reading:{}", user.id), REQUESTS_PER_WINDOW)?;
    let request: ReadRequest = serde_json::from_value(body).map_err(|_| INVALID_CHART)?;
    same_owner(request.expected_owner_id, user.id)?;
    let chart: ReadingChart = serde_json::from_value(request.chart).map_err(|_| INVALID_CHART)?;
    let birth = home_birth(&state.db, user.id, false).await?.ok_or(NO_HOME)?;
    let key = birth.key();
    if chart.birth.key() != key {
        return Err(STALE_BIRTH);
    }
    if !chart.valid() {
        return Err(INVALID_CHART);
    }
    let work = Work::Reading {
        request: saju_reading::request(&chart, &state.config.openai.reading_model),
        ziwei: chart.has_ziwei(),
    };
    start(&state, user.id, request.again.unwrap_or(false), key, work).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DrawRequest {
    /// The account the page was loaded for. A missing value must refuse the request.
    expected_owner_id: Option<Uuid>,
    /// A `data:image/webp;base64,…` (or PNG, JPEG) URL of the island alone, 1024×1024.
    image: String,
    again: Option<bool>,
}

/// `POST /api/homes/me/saju/picture` `{expectedOwnerId, image, again?}`: the caller's island drawn again as a 미연시
/// illustration. Answered as a reading request is. The body is read only once the sender is known and within their
/// budget, and only up to a picture's size.
async fn draw(State(state): State<AppState>, headers: HeaderMap, body: Body) -> ApiResult<Response> {
    let user = current_user(&state, &headers).await?;
    rate_limit(&state, format!("saju-picture:{}", user.id), REQUESTS_PER_WINDOW)?;
    // A body that says it is past the limit is refused before anything waits for it.
    let declared = headers.get(header::CONTENT_LENGTH).and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_PICTURE_REQUEST_BYTES as u64) {
        return Err(IMAGE_TOO_LARGE);
    }
    let bytes = limited_body(body, MAX_PICTURE_REQUEST_BYTES, IMAGE_TOO_LARGE, IMAGE_CUT_SHORT).await?;
    let request: DrawRequest = serde_json::from_slice(&bytes).map_err(|_| INVALID_IMAGE)?;
    drop(bytes);
    same_owner(request.expected_owner_id, user.id)?;
    let birth = home_birth(&state.db, user.id, false).await?.ok_or(NO_HOME)?;
    let island = island(request.image).await?;
    start(&state, user.id, request.again.unwrap_or(false), birth.key(), Work::Picture(island)).await
}

/// A picture's kind, read from its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Webp,
    Png,
    Jpeg,
}

impl Format {
    fn media_type(self) -> &'static str {
        match self {
            Self::Webp => "image/webp",
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }

    /// As the model store names its files.
    fn extension(self) -> &'static str {
        match self {
            Self::Webp => "webp",
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }
}

/// A WebP's canvas size, from its first chunk: VP8X (extended), VP8L (lossless) or VP8 (lossy).
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let le24 = |at: &[u8]| u32::from(at[0]) | u32::from(at[1]) << 8 | u32::from(at[2]) << 16;
    match bytes.get(12..16)? {
        b"VP8X" => {
            let size = bytes.get(24..30)?;
            Some((1 + le24(&size[..3]), 1 + le24(&size[3..])))
        }
        b"VP8L" => {
            let header = bytes.get(20..25)?;
            if header[0] != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
            Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
        }
        b"VP8 " => {
            let frame = bytes.get(20..30)?;
            if frame[3..6] != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let side = |low: u8, high: u8| u32::from(u16::from_le_bytes([low, high]) & 0x3fff);
            Some((side(frame[6], frame[7]), side(frame[8], frame[9])))
        }
        _ => None,
    }
}

/// What `bytes` say they are and how large, from their header alone: nothing is decoded.
fn picture_header(bytes: &[u8]) -> Option<(Format, u32, u32)> {
    if bytes.get(..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        let (width, height) = webp_size(bytes)?;
        return Some((Format::Webp, width, height));
    }
    let (format, read) = match image::guess_format(bytes).ok()? {
        ImageFormat::Png => (Format::Png, ImageFormat::Png),
        ImageFormat::Jpeg => (Format::Jpeg, ImageFormat::Jpeg),
        _ => return None,
    };
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), read).into_dimensions().ok()?;
    Some((format, width, height))
}

/// The island picture to draw again.
struct Island {
    bytes: Vec<u8>,
    format: Format,
}

/// The picture in `data`, a `data:image/webp;base64,` (or PNG, JPEG) URL, if it is what it says it is and exactly
/// [`PICTURE_EDGE`] on each side. Its size is checked before it is decoded, on a blocking thread.
async fn island(data: String) -> ApiResult<Island> {
    const KINDS: [(&str, Format); 3] = [
        ("data:image/webp;base64,", Format::Webp),
        ("data:image/png;base64,", Format::Png),
        ("data:image/jpeg;base64,", Format::Jpeg),
    ];
    let (start, declared) = KINDS
        .iter()
        .find_map(|(prefix, format)| data.starts_with(prefix).then_some((prefix.len(), *format)))
        .ok_or(INVALID_IMAGE)?;
    if data.len() - start > MAX_PICTURE_BYTES.div_ceil(3) * 4 {
        return Err(IMAGE_TOO_LARGE);
    }
    tokio::task::spawn_blocking(move || {
        let bytes = STANDARD.decode(&data[start..]).map_err(|_| INVALID_IMAGE)?;
        if bytes.len() > MAX_PICTURE_BYTES {
            return Err(IMAGE_TOO_LARGE);
        }
        match picture_header(&bytes) {
            Some((format, PICTURE_EDGE, PICTURE_EDGE)) if format == declared => Ok(Island { bytes, format }),
            _ => Err(INVALID_IMAGE),
        }
    })
    .await
    .map_err(internal)?
}

/// What one request asks to be made.
enum Work {
    /// The Responses API request, written from the checked chart, and whether the chart has a 명반.
    Reading {
        request: Value,
        ziwei: bool,
    },
    Picture(Island),
}

impl Work {
    fn kind(&self) -> Kind {
        match self {
            Self::Reading { .. } => Kind::Reading,
            Self::Picture(_) => Kind::Picture,
        }
    }
}

/// What came of a request to make something: what was there already, or work just recorded as pending.
enum Begun {
    Answer(Value),
    Started { attempt: Uuid, since: DateTime<Utc>, admission: OwnedSemaphorePermit },
}

/// Starts `work` for `owner`'s home of birth `key`, unless one is ready (and not asked `again`) or being made.
async fn start(state: &AppState, owner: Uuid, again: bool, key: String, work: Work) -> ApiResult<Response> {
    let kind = work.kind();
    let task_state = state.clone();
    // Recorded and started on a task of its own: a request dropped between the two (its connection closing) would
    // leave the work pending with nothing doing it.
    let (status, body) = tokio::spawn(async move {
        match begin(&task_state, owner, kind, again, &key).await? {
            Begun::Answer(shown) => Ok::<_, ApiError>((StatusCode::OK, shown)),
            Begun::Started { attempt, since, admission } => {
                let task = Task { state: task_state, owner, attempt, work, _admission: admission };
                tokio::spawn(task.run());
                Ok((StatusCode::ACCEPTED, json!({"status": "pending", "since": since})))
            }
        }
    })
    .await
    .map_err(internal)??;
    Ok((status, Json(body)).into_response())
}

/// Decides, with the home's row locked, whether to answer with what there is or to start: a ready one is answered
/// unless asked `again`, a pending one always. Starting needs the key, an `again` within the member's limit, a place
/// among the work admitted and a call left in the month's budget; the call is counted and the work recorded as
/// pending in the same transaction, so a request that goes no further has spent nothing.
async fn begin(state: &AppState, owner: Uuid, kind: Kind, again: bool, key: &str) -> ApiResult<Begun> {
    let openai = &state.config.openai;
    let mut tx = state.db.begin().await?;
    let birth = home_birth(&mut *tx, owner, true).await?.ok_or(NO_HOME)?;
    if birth.key() != key {
        return Err(STALE_BIRTH);
    }
    let shown = state_of(&mut *tx, kind, owner, key).await?;
    let replacing = match shown["status"].as_str() {
        Some("ready") if !again => return Ok(Begun::Answer(shown)),
        Some("pending") => return Ok(Begun::Answer(shown)),
        Some("ready") => true,
        _ => false,
    };
    if openai.api_key.is_none() {
        return Err(kind.unavailable());
    }
    if replacing {
        let (most, window) = kind.again();
        let used: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM saju_paid_calls WHERE owner_id = $1 AND kind = $2 AND again
             AND created_at > now() - interval '{window}'"
        ))
        .bind(owner)
        .bind(kind.name())
        .fetch_one(&mut *tx)
        .await?;
        if used >= most {
            return Err(kind.limited());
        }
    }
    let admission = state.made.admitted(kind).clone().try_acquire_owned().map_err(|_| kind.busy())?;
    let monthly = kind.monthly(openai);
    let counted: Option<i32> = if monthly > 0 {
        sqlx::query_scalar(
            "INSERT INTO saju_paid_months (month, kind, calls)
             VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, $1, 1)
             ON CONFLICT (month, kind) DO UPDATE SET calls = saju_paid_months.calls + 1
             WHERE saju_paid_months.calls < $2 RETURNING calls",
        )
        .bind(kind.name())
        .bind(monthly)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };
    if counted.is_none() {
        tracing::warn!(kind = kind.name(), monthly, "The month's budget of paid calls is spent");
        return Err(kind.unavailable());
    }
    sqlx::query("INSERT INTO saju_paid_calls (owner_id, kind, again) VALUES ($1, $2, $3)")
        .bind(owner)
        .bind(kind.name())
        .bind(replacing)
        .execute(&mut *tx)
        .await?;
    let attempt = Uuid::new_v4();
    let cleared = kind.made().split(", ").map(|column| format!("{column} = NULL")).collect::<Vec<_>>().join(", ");
    let since: DateTime<Utc> = sqlx::query_scalar(&format!(
        "INSERT INTO {table} (owner_id, birth_key, attempt, status, model) VALUES ($1, $2, $3, 'pending', $4)
         ON CONFLICT (owner_id) DO UPDATE SET birth_key = excluded.birth_key, attempt = excluded.attempt,
           status = 'pending', model = excluded.model, {cleared}, error_code = NULL, started_at = now(),
           finished_at = NULL
         RETURNING started_at",
        table = kind.table(),
    ))
    .bind(owner)
    .bind(key)
    .bind(attempt)
    .bind(kind.model(openai))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(%owner, kind = kind.name(), again = replacing, "Paid saju call started");
    Ok(Begun::Started { attempt, since, admission })
}

/// What a call made.
enum Product {
    Reading(Value),
    Picture { url: String, width: u32, height: u32 },
}

/// One request's work, from its call to the record of what it came to.
struct Task {
    state: AppState,
    owner: Uuid,
    attempt: Uuid,
    work: Work,
    _admission: OwnedSemaphorePermit,
}

impl Task {
    async fn run(self) {
        let kind = self.work.kind();
        let outcome = AssertUnwindSafe(self.make()).catch_unwind().await.unwrap_or(Err(Failure::Internal));
        let table = kind.table();
        // Only this attempt's row, still pending: a home built again from another birth, taken down, or asked again
        // since keeps what it has.
        let recorded = match &outcome {
            Ok(Product::Reading(reading)) => {
                let sql = format!(
                    "UPDATE {table} SET status = 'ready', reading = $3, finished_at = now()
                     WHERE owner_id = $1 AND attempt = $2 AND status = 'pending'"
                );
                retry(|| sqlx::query(&sql).bind(self.owner).bind(self.attempt).bind(reading).execute(&self.state.db))
                    .await
            }
            Ok(Product::Picture { url, width, height }) => {
                let sql = format!(
                    "UPDATE {table} SET status = 'ready', url = $3, width = $4, height = $5, finished_at = now()
                     WHERE owner_id = $1 AND attempt = $2 AND status = 'pending'"
                );
                retry(|| {
                    sqlx::query(&sql)
                        .bind(self.owner)
                        .bind(self.attempt)
                        .bind(url)
                        .bind(*width as i32)
                        .bind(*height as i32)
                        .execute(&self.state.db)
                })
                .await
            }
            Err(failure) => {
                tracing::warn!(owner = %self.owner, kind = kind.name(), code = failure.code(), "Paid saju call failed");
                let sql = format!(
                    "UPDATE {table} SET status = 'failed', error_code = $3, finished_at = now()
                     WHERE owner_id = $1 AND attempt = $2 AND status = 'pending'"
                );
                retry(|| {
                    sqlx::query(&sql).bind(self.owner).bind(self.attempt).bind(failure.code()).execute(&self.state.db)
                })
                .await
            }
        };
        if let Err(error) = recorded {
            tracing::error!(%error, owner = %self.owner, kind = kind.name(), "Could not record a paid saju call");
        }
    }

    async fn make(&self) -> Result<Product, Failure> {
        let state = &self.state;
        let openai = &state.config.openai;
        let key = openai.api_key.as_deref().ok_or(Failure::Unavailable)?;
        let calling = state.made.calling(self.work.kind()).clone();
        let _call = tokio::time::timeout(CALL_WAIT, calling.acquire_owned())
            .await
            .map_err(|_| Failure::Busy)?
            .map_err(|_| Failure::Internal)?;
        match &self.work {
            Work::Reading { request, ziwei } => {
                let written = openai::respond(&state.http, openai, key, request).await?;
                let reading = saju_reading::reading(&written.text, *ziwei).ok_or(Failure::BadOutput)?;
                tracing::info!(
                    owner = %self.owner,
                    input_tokens = written.input_tokens,
                    output_tokens = written.output_tokens,
                    "Saju reading written"
                );
                Ok(Product::Reading(reading))
            }
            Work::Picture(island) => {
                let file_name = format!("island.{}", island.format.extension());
                let image =
                    Image { bytes: &island.bytes, file_name: &file_name, media_type: island.format.media_type() };
                let drawn = openai::edit_image(&state.http, openai, key, image, PICTURE_PROMPT).await?;
                let sides = 1..=MAX_DRAWN_EDGE;
                let (format, width, height) = picture_header(&drawn)
                    .filter(|(_, width, height)| sides.contains(width) && sides.contains(height))
                    .ok_or(Failure::BadOutput)?;
                let url = state.config.models.put(format.extension(), drawn).await.map_err(|_| Failure::Internal)?;
                tracing::info!(owner = %self.owner, width, height, "Saju picture drawn");
                Ok(Product::Picture { url, width, height })
            }
        }
    }
}

/// Deletes what was made for `owner`'s home from a birth other than `key`: run as the home is built again, in the
/// same transaction. A picture's file goes with the store's next sweep.
pub(crate) async fn forget_other_births(tx: &mut PgConnection, owner: Uuid, key: &str) -> Result<(), sqlx::Error> {
    for kind in [Kind::Reading, Kind::Picture] {
        sqlx::query(&format!("DELETE FROM {} WHERE owner_id = $1 AND birth_key <> $2", kind.table()))
            .bind(owner)
            .bind(key)
            .execute(&mut *tx)
            .await?;
    }
    Ok(())
}

/// Marks the readings and pictures a stopped server left pending as failed: their work ended with it. Run at startup,
/// before this server starts any of its own.
pub async fn interrupt_unfinished(db: &PgPool) -> Result<u64, sqlx::Error> {
    let mut stopped = 0;
    for kind in [Kind::Reading, Kind::Picture] {
        stopped += sqlx::query(&format!(
            "UPDATE {} SET status = 'failed', error_code = 'interrupted', finished_at = now() WHERE status = 'pending'",
            kind.table()
        ))
        .execute(db)
        .await?
        .rows_affected();
    }
    Ok(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, codecs::png::PngEncoder};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(&vec![200u8; (width * height * 3) as usize], width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::RgbImage::new(width, height).write_to(&mut out, ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    /// A WebP's RIFF header and first chunk, as far as its size is written: enough to read it from.
    fn webp(chunk: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        bytes.extend_from_slice(chunk);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn webp_1024() -> Vec<u8> {
        // VP8X: flags, three reserved bytes, then the canvas less one as 24-bit little-endian numbers.
        webp(b"VP8X", &[0, 0, 0, 0, 0xff, 0x03, 0x00, 0xff, 0x03, 0x00])
    }

    #[test]
    fn a_pictures_kind_and_size_are_read_from_its_header() {
        assert_eq!(picture_header(&png(1024, 1024)), Some((Format::Png, 1024, 1024)));
        assert_eq!(picture_header(&png(300, 200)), Some((Format::Png, 300, 200)));
        assert_eq!(picture_header(&jpeg(1024, 1024)), Some((Format::Jpeg, 1024, 1024)));
        assert_eq!(picture_header(&webp_1024()), Some((Format::Webp, 1024, 1024)));
        // Lossless: a signature byte, then width and height less one in 14 bits each.
        let bits: u32 = 1023 | (767 << 14);
        let mut lossless = vec![0x2f];
        lossless.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(picture_header(&webp(b"VP8L", &lossless)), Some((Format::Webp, 1024, 768)));
        // Lossy: a frame tag, the start code, then width and height in 14 bits each.
        let lossy = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x00, 0x04, 0x00, 0x04];
        assert_eq!(picture_header(&webp(b"VP8 ", &lossy)), Some((Format::Webp, 1024, 1024)));
        // Real files as browsers and encoders write them (1×1).
        let tiny = |data: &str| picture_header(&STANDARD.decode(data).unwrap());
        assert_eq!(tiny("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), Some((Format::Webp, 1, 1)));
        assert_eq!(tiny("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"), Some((Format::Webp, 1, 1)));
        assert_eq!(picture_header(&webp(b"VP8 ", &[0; 10])), None);
        assert_eq!(picture_header(b"GIF89a\x01\x00\x01\x00"), None);
        assert_eq!(picture_header(b""), None);
    }

    fn data_url(kind: &str, bytes: &[u8]) -> String {
        format!("data:image/{kind};base64,{}", STANDARD.encode(bytes))
    }

    #[tokio::test]
    async fn only_a_1024_island_of_the_kind_it_says_is_taken() {
        assert_eq!(island(data_url("png", &png(1024, 1024))).await.ok().map(|island| island.format), Some(Format::Png));
        assert_eq!(
            island(data_url("jpeg", &jpeg(1024, 1024))).await.ok().map(|island| island.format),
            Some(Format::Jpeg)
        );
        assert_eq!(island(data_url("webp", &webp_1024())).await.ok().map(|island| island.format), Some(Format::Webp));
        let refused = |data: String| async move { island(data).await.err().map(|error| (error.status, error.code)) };
        let invalid = Some((StatusCode::BAD_REQUEST, "invalid_image"));
        assert_eq!(refused(data_url("png", &png(1080, 1080))).await, invalid);
        assert_eq!(refused(data_url("webp", &png(1024, 1024))).await, invalid, "a PNG that says it is a WebP");
        assert_eq!(refused(data_url("gif", &png(1024, 1024))).await, invalid);
        assert_eq!(refused("data:image/png;base64,not base64!".into()).await, invalid);
        assert_eq!(refused(format!("data:image/png,{}", STANDARD.encode(png(1024, 1024)))).await, invalid);
        let large = Some((StatusCode::PAYLOAD_TOO_LARGE, "image_too_large"));
        assert_eq!(refused(data_url("png", &vec![0; MAX_PICTURE_BYTES + 1])).await, large);
    }

    #[test]
    fn a_failed_one_says_why_in_the_servers_own_words() {
        for kind in [Kind::Reading, Kind::Picture] {
            for code in ["interrupted", "timeout", "refused", "bad_output", "provider_busy", "provider_unavailable"] {
                let message = kind.message(code);
                assert!(message.chars().any(|c| ('가'..='힣').contains(&c)), "{code}");
            }
            assert_ne!(kind.message("interrupted"), kind.message("something new"));
        }
    }
}
