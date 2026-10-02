use axum::{
    Json, Router,
    body::Body,
    extract::{OriginalUri, RawQuery, State},
    http::{HeaderMap, HeaderName, Method, StatusCode, header},
    response::Response,
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::PgExecutor;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use crate::{
    AppState,
    auth::{User, current_user, require},
    config::{Factory, FactoryAccess, FactoryToken},
    error::{ApiError, ApiResult, forbidden, internal, not_found},
    rebac::{ADMIN, OPERATOR, PAID_OPERATOR, STUDIO_VIEWER},
    security::{epoch_seconds, hmac_sha256},
};

const OPERATOR_TOKEN_SECONDS: u64 = 300;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the character server may stay silent: before it answers, or between two pieces of what it sends. Uploads
/// and downloads of 256 MB take minutes, so this catches a stalled connection and does not limit a transfer.
const READ_TIMEOUT: Duration = Duration::from_secs(600);
const FILE_TIMEOUT: Duration = Duration::from_secs(60);
/// A cold job listing can take the character server twelve seconds.
const JSON_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest JSON answer read: the job listing is the biggest and stays far below this.
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const LISTING_ATTEMPTS: u32 = 3;
const LISTING_RETRY: Duration = Duration::from_secs(2);
pub const MAX_MODEL_BYTES: usize = 64 * 1024 * 1024;
const MIN_SECRET_BYTES: usize = 32;
/// The advisory lock that serializes counting and recording paid requests; the only one this server takes.
const PAID_LOCK: i64 = 7_309_001;
/// Headers a studio request needs; cookies and the browser's own credentials never reach the character server.
const FORWARDED_REQUEST_HEADERS: [HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::ACCEPT,
    header::IF_MATCH,
    header::IF_NONE_MATCH,
    HeaderName::from_static("idempotency-key"),
];
const FORWARDED_RESPONSE_HEADERS: [HeaderName; 6] = [
    header::CONTENT_TYPE,
    header::CONTENT_DISPOSITION,
    header::ETAG,
    header::LOCATION,
    header::CACHE_CONTROL,
    header::LAST_MODIFIED,
];

const UNAVAILABLE: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "factory_unavailable", "캐릭터 서버에 연결하지 못했습니다.");
const TOO_LARGE: ApiError = ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "model_too_large", "모델 파일이 너무 큽니다.");

/// The HMAC key exactly as the character server's `auth.py` (backend/src) derives it: the stripped secret, used decoded when Python's
/// `base64.b64decode(secret, validate=False)` yields at least 32 bytes, otherwise as its UTF-8 bytes.
pub fn hmac_key(secret: &str) -> Vec<u8> {
    let secret = secret.trim();
    python_b64decode(secret)
        .filter(|decoded| decoded.len() >= MIN_SECRET_BYTES)
        .unwrap_or_else(|| secret.as_bytes().to_vec())
}

/// CPython's non-strict `binascii.a2b_base64` up to 3.12 (the character server pins 3.11): characters outside the
/// alphabet are skipped, a complete `=` run ends the input, and a dangling partial quad is an error. A `str` argument
/// must be ASCII.
fn python_b64decode(text: &str) -> Option<Vec<u8>> {
    if !text.is_ascii() {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut quad, mut pads, mut left) = (0u8, 0u8, 0u8);
    for byte in text.bytes() {
        if byte == b'=' {
            if quad >= 2 {
                pads += 1;
                if quad + pads >= 4 {
                    return Some(out);
                }
            }
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        pads = 0;
        match quad {
            0 => left = value,
            1 => {
                out.push(left << 2 | value >> 4);
                left = value & 0x0f;
            }
            2 => {
                out.push(left << 4 | value >> 2);
                left = value & 0x03;
            }
            _ => out.push(left << 6 | value),
        }
        quad = (quad + 1) % 4;
    }
    (quad == 0).then_some(out)
}

/// A five-minute HS256 access token for the character server, as its operator (`owner_id`).
pub fn operator_token(token: &FactoryToken, username: &str) -> String {
    let now = epoch_seconds();
    let claims = json!({
        "sub": token.owner_id.to_string(),
        "userId": token.owner_id,
        "roles": ["ADMIN"],
        "token_type": "access",
        "name": username,
        "iss": token.issuer,
        "aud": token.audience,
        "iat": now,
        "exp": now + OPERATOR_TOKEN_SECONDS,
    });
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let signing = format!("{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(hmac_sha256(&token.key, signing.as_bytes()));
    format!("{signing}.{signature}")
}

fn factory(state: &AppState) -> ApiResult<&Factory> {
    state.config.factory.as_ref().ok_or(UNAVAILABLE)
}

/// Refuses up front when this server has no character server to reach.
pub fn configured(state: &AppState) -> ApiResult<()> {
    factory(state).map(|_| ())
}

/// The HTTP client for the character server and the files it points to. It follows no redirect by itself: `fetch_file`
/// decides where a file may be fetched from.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("HTTP client")
}

/// Sends one request to the character server. When its instance may have powered itself off this asks EC2 first,
/// and a request that cannot reach it wakes it (`studio_power`): the caller then gets `studio_waking` or
/// `studio_stopping` to retry. Its CloudFront answers 502 or 504 while the instance is down or booting.
async fn send(state: &AppState, request: reqwest::RequestBuilder) -> ApiResult<reqwest::Response> {
    if let Some(asleep) = state.power.before().await {
        return Err(asleep);
    }
    match request.send().await {
        Ok(response)
            if matches!(response.status(), reqwest::StatusCode::BAD_GATEWAY | reqwest::StatusCode::GATEWAY_TIMEOUT) =>
        {
            match state.power.after_failure().await {
                Some(asleep) => Err(asleep),
                None => Ok(response),
            }
        }
        Ok(response) => {
            state.power.answered();
            Ok(response)
        }
        Err(error) => {
            tracing::warn!(%error, "Character server request failed");
            Err(state.power.after_failure().await.unwrap_or(UNAVAILABLE))
        }
    }
}

fn signed(request: reqwest::RequestBuilder, factory: &Factory, username: &str) -> reqwest::RequestBuilder {
    let request = match &factory.token {
        Some(token) => request.bearer_auth(operator_token(token, username)),
        None => request,
    };
    let request = match &factory.gateway_key {
        Some(key) => request.header("x-gateway-key", key),
        None => request,
    };
    match &factory.api_key {
        Some(key) => request.header("x-api-key", key),
        None => request,
    }
}

/// The paths the character studio's screens call; this server answers them under the same names, so the screens run
/// unchanged inside the app.
const STUDIO_PREFIXES: [&str; 4] = ["avatar-factory", "studio", "avatar-blueprints", "characters"];

/// Whether `path` (the full request path) belongs to the studio, including the admins' `/api/factory/*`.
pub fn is_studio_path(path: &str) -> bool {
    path.strip_prefix("/api/").is_some_and(|rest| {
        rest.starts_with("factory/")
            || STUDIO_PREFIXES
                .iter()
                .any(|prefix| rest.strip_prefix(prefix).is_some_and(|tail| tail.is_empty() || tail.starts_with('/')))
    })
}

pub fn router() -> Router<AppState> {
    let mut router = Router::new().route("/api/factory/{*path}", any(proxy));
    for prefix in STUDIO_PREFIXES {
        router = router
            .route(&format!("/api/{prefix}"), any(studio))
            .route(&format!("/api/{prefix}/{{*rest}}"), any(studio));
    }
    router
}

/// What a studio request needs from whoever sends it (permissions are in `rebac`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Need {
    /// Any signed-in member: reading the wardrobe (bodies, parts, colours, previews) and the part models it puts on.
    Member,
    /// `studio_viewer` (an operator or a catalog editor), reading anything else.
    Read,
    /// `operator`, changing the studio's records; `FACTORY_ACCESS=write` or more.
    Write,
    /// `paid_operator`, starting work that can cost money; `FACTORY_ACCESS=paid` and budget left this month.
    Paid,
}

/// Uploads, selections and local image crops that never start paid work. Every other POST is treated as paid: the
/// character server starts generation, rigging, retries and resumes with POSTs, and a new one must not slip through as
/// free.
const FREE_POSTS: [&[&str]; 10] = [
    &["avatar-factory", "jobs", "*", "native-parts", "select"],
    &["avatar-factory", "base-bodies", "glb-assets"],
    &["avatar-factory", "meshy-options", "texture-assets"],
    &["avatar-factory", "part-batches", "split-sheet"],
    &["avatar-blueprints", "assets"],
    &["studio", "glb-assets"],
    &["studio", "glb-assets", "upload"],
    &["studio", "animals", "references"],
    &["characters"],
    &["characters", "*", "sources"],
];

/// The policy for one studio request; `segments` are its path below `/api/`, read by [`path_segments`], e.g.
/// `avatar-factory`, `wardrobe`, `bodies`.
fn need(method: &Method, segments: &[String]) -> Need {
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    if matches!(*method, Method::GET | Method::HEAD) {
        let member = match segments.as_slice() {
            ["avatar-factory", "wardrobe", ..] => true,
            ["avatar-factory", "jobs", _, "native-parts", _, file] => file.ends_with(".glb"),
            _ => false,
        };
        return if member { Need::Member } else { Need::Read };
    }
    let free = |pattern: &&[&str]| {
        pattern.len() == segments.len() && pattern.iter().zip(&segments).all(|(want, got)| *want == "*" || want == got)
    };
    if *method == Method::POST && !FREE_POSTS.iter().any(free) { Need::Paid } else { Need::Write }
}

const READ_ONLY: ApiError = forbidden("factory_read_only", "이 서버에서는 캐릭터 스튜디오를 읽기만 할 수 있습니다.");
const PAID_OFF: ApiError = forbidden("factory_paid_off", "이 서버에서는 비용이 드는 캐릭터 작업을 시작할 수 없습니다.");
const BUDGET_SPENT: ApiError =
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "factory_budget", "이번 달 유료 캐릭터 작업 한도를 다 썼습니다.");

/// Paid studio requests started since the start of this month (UTC).
async fn paid_this_month(db: impl PgExecutor<'_>) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT count(*) FROM factory_requests
         WHERE paid AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    )
    .fetch_one(db)
    .await
}

const NO_SUCH_PATH: ApiError = not_found("not_found", "찾을 수 없습니다.");

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|digit| digit as u8)
}

/// One request path segment as the character server will read it: percent-decoded once. None when it could mean
/// something else on the way: empty, `.` or `..`, encoded twice (a `%` is left after decoding), a separator, a control
/// character, or bytes that are not UTF-8.
fn path_segment(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let digits = bytes.get(at + 1..at + 3)?;
            decoded.push(hex_digit(digits[0])? << 4 | hex_digit(digits[1])?);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    let text = String::from_utf8(decoded).ok()?;
    let plain = !text.is_empty()
        && text != "."
        && text != ".."
        && !text.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | '%'));
    plain.then_some(text)
}

/// A request path below `/api/` as the client wrote it, read once into the segments both the policy and the character
/// server get, so they cannot disagree about what was asked for; `NO_SUCH_PATH` unless every segment passes
/// [`path_segment`].
fn path_segments(raw: &str) -> ApiResult<Vec<String>> {
    raw.split('/').map(path_segment).collect::<Option<_>>().ok_or(NO_SUCH_PATH)
}

/// A studio request, its path already read: the policy classifies, and the character server is sent, these segments.
struct Call {
    method: Method,
    headers: HeaderMap,
    segments: Vec<String>,
    query: Option<String>,
    body: Body,
}

impl Call {
    /// `path` is the request path below `/api/` (or `/api/factory/`), still as the client wrote it.
    fn read(method: Method, headers: HeaderMap, path: &str, query: Option<String>, body: Body) -> ApiResult<Self> {
        Ok(Self { method, headers, segments: path_segments(path)?, query, body })
    }
}

/// `/api/{avatar-factory,studio,avatar-blueprints,characters}/*`: the studio's own API, checked against [`need`] and the
/// server's [`FactoryAccess`], then sent on signed as the operator. Changes are recorded in `factory_requests`.
async fn studio(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    RawQuery(query): RawQuery,
    body: Body,
) -> ApiResult<Response> {
    let call = Call::read(method, headers, uri.path().strip_prefix("/api/").unwrap_or_default(), query, body)?;
    let need = need(&call.method, &call.segments);
    let user = match need {
        Need::Member => current_user(&state, &call.headers).await?,
        Need::Read => require(&state, &call.headers, STUDIO_VIEWER).await?,
        Need::Write => require(&state, &call.headers, OPERATOR).await?,
        Need::Paid => require(&state, &call.headers, PAID_OPERATOR).await?,
    };
    relay(&state, &user, need, call).await
}

/// `/api/factory/*`: the character server's own `/api/*`, signed in as its operator. Reads (model previews on /admin)
/// are for `studio_viewer`, anything else for admins; a change then takes the road the studio's own routes take, under
/// the same server-wide ceiling and record. Bodies stream both ways.
async fn proxy(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    RawQuery(query): RawQuery,
    body: Body,
) -> ApiResult<Response> {
    let call = Call::read(method, headers, uri.path().strip_prefix("/api/factory/").unwrap_or_default(), query, body)?;
    let read = matches!(call.method, Method::GET | Method::HEAD);
    let user = require(&state, &call.headers, if read { STUDIO_VIEWER } else { ADMIN }).await?;
    let need = need(&call.method, &call.segments);
    relay(&state, &user, need, call).await
}

/// What every studio request goes through once its sender is known: the server-wide ceiling (`FACTORY_ACCESS` and the
/// month's paid budget), the record of a change in `factory_requests`, then the request itself.
async fn relay(state: &AppState, user: &User, need: Need, call: Call) -> ApiResult<Response> {
    let factory = factory(state)?;
    let paid = need == Need::Paid;
    match need {
        Need::Write if factory.access < FactoryAccess::Write => return Err(READ_ONLY),
        Need::Paid if factory.access < FactoryAccess::Paid => return Err(PAID_OFF),
        // Refused before the sleeping studio is woken for it, and counted again under the lock when it is recorded.
        Need::Paid if paid_this_month(&state.db).await? >= factory.paid_monthly => return Err(BUDGET_SPENT),
        _ => {}
    }
    let record = if matches!(need, Need::Write | Need::Paid) {
        // A change the sleeping studio cannot take is not recorded (nor counted against the paid budget).
        if let Some(asleep) = state.power.before().await {
            return Err(asleep);
        }
        Some(record_change(state, factory, user, &call.method, &call.segments, paid).await?)
    } else {
        None
    };
    let response = forward(state, &user.username, call).await;
    if let Some(id) = record {
        let status =
            response.as_ref().map_or_else(|error| error.status.as_u16(), |response| response.status().as_u16());
        let saved = sqlx::query("UPDATE factory_requests SET status = $2 WHERE id = $1")
            .bind(id)
            .bind(status as i16)
            .execute(&state.db)
            .await;
        if let Err(error) = saved {
            tracing::warn!(%error, "could not record a studio request's status");
        }
    }
    response
}

/// `GET /api/catalog/admin/factory-usage`: how far the studio reaches from here, and this month's paid requests.
pub async fn usage(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require(&state, &headers, STUDIO_VIEWER).await?;
    let Some(factory) = state.config.factory.as_ref() else {
        return Ok(Json(json!({"connected": false})));
    };
    Ok(Json(json!({
        "connected": true,
        "access": factory.access,
        "paidThisMonth": paid_this_month(&state.db).await?,
        "paidMonthly": factory.paid_monthly,
    })))
}

/// Writes a change down before it is sent, and returns its record's id. The month's paid requests are counted under a
/// lock held until the record is saved, so concurrent requests cannot spend more between them than the budget has left.
async fn record_change(
    state: &AppState,
    factory: &Factory,
    user: &User,
    method: &Method,
    segments: &[String],
    paid: bool,
) -> ApiResult<i64> {
    let path = segments.join("/");
    let mut tx = state.db.begin().await?;
    if paid {
        sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(PAID_LOCK).execute(&mut *tx).await?;
        if paid_this_month(&mut *tx).await? >= factory.paid_monthly {
            tx.rollback().await?;
            return Err(BUDGET_SPENT);
        }
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO factory_requests (user_id, method, path, paid) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.id)
    .bind(method.as_str())
    .bind(&path)
    .bind(paid)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    if paid {
        tracing::warn!(user = %user.username, %method, %path, "paid studio request");
    }
    Ok(id)
}

/// `FACTORY_URL/api/<segments>?<query>`, every segment encoded again: the character server reads exactly the segments
/// the policy saw, however the client wrote them.
fn target(factory: &Factory, segments: &[String], query: Option<&str>) -> ApiResult<reqwest::Url> {
    let mut url = reqwest::Url::parse(&factory.url).map_err(|error| {
        tracing::error!(%error, "FACTORY_URL is not a URL");
        UNAVAILABLE
    })?;
    url.path_segments_mut()
        .map_err(|()| UNAVAILABLE)?
        .extend(std::iter::once("api").chain(segments.iter().map(String::as_str)));
    url.set_query(query);
    Ok(url)
}

/// The character server's URL for one of this server's own paths under `/api/` (`a/b/c`, with `?d=e` when it has a
/// query), whose segments are ids already checked; they are read like a request's all the same.
fn api_url(factory: &Factory, api_path: &str) -> ApiResult<reqwest::Url> {
    let (path, query) = api_path.split_once('?').map_or((api_path, None), |(path, query)| (path, Some(query)));
    let segments = path_segments(path).map_err(|_| internal(format!("{api_path} is not a character server path")))?;
    target(factory, &segments, query)
}

/// Sends one request to the character server's `/api/` as the operator and streams its answer back.
async fn forward(state: &AppState, username: &str, call: Call) -> ApiResult<Response> {
    let factory = factory(state)?;
    let url = target(factory, &call.segments, call.query.as_deref())?;
    let read = matches!(call.method, Method::GET | Method::HEAD);
    let mut request = state.http.request(call.method, url);
    if !read {
        request = request.body(reqwest::Body::wrap_stream(call.body.into_data_stream()));
    }
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = call.headers.get(&name) {
            request = request.header(name, value.clone());
        }
    }
    let upstream = send(state, signed(request, factory, username)).await?;
    let mut response = Response::builder().status(upstream.status().as_u16());
    for name in FORWARDED_RESPONSE_HEADERS {
        if let Some(value) = upstream.headers().get(name.as_str()) {
            response = response.header(name, value.as_bytes());
        }
    }
    response.body(Body::from_stream(upstream.bytes_stream())).map_err(internal)
}

fn unavailable(error: reqwest::Error) -> ApiError {
    tracing::warn!(%error, "Character server request failed");
    UNAVAILABLE
}

/// How much of a download has arrived, and the size the server announced (0 when it did not).
#[derive(Default)]
pub struct Received {
    pub bytes: AtomicUsize,
    pub total: AtomicUsize,
}

/// Whether a redirect from the character server may be followed: to https, or to the character server itself (local
/// runs serve their files from it), and never to an address with credentials in it. Anything else would let the answer
/// of whatever sits behind `FACTORY_URL` aim this server's requests at its own network.
fn follows(location: &reqwest::Url, factory: &str) -> bool {
    let own = reqwest::Url::parse(factory).is_ok_and(|own| own.origin() == location.origin());
    (location.scheme() == "https" || own) && location.username().is_empty() && location.password().is_none()
}

/// A file under the character server's `/api/`, at most `limit` bytes, counting what has arrived into `received` as it
/// streams in. Its files answer with a presigned S3 redirect, followed here (see [`follows`]) without the operator
/// token or key.
pub async fn fetch_file(
    state: &AppState,
    username: &str,
    api_path: &str,
    limit: usize,
    received: Option<&Received>,
) -> ApiResult<Vec<u8>> {
    let factory = factory(state)?;
    let url = api_url(factory, api_path)?;
    let mut response = send(state, signed(state.http.get(url), factory, username).timeout(FILE_TIMEOUT)).await?;
    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(header::LOCATION.as_str())
            .and_then(|v| v.to_str().ok())
            .and_then(|v| response.url().join(v).ok())
            .ok_or(UNAVAILABLE)?;
        if !follows(&location, &factory.url) {
            // Only where it points: a presigned address carries its signature in the query.
            let to = location.origin().ascii_serialization();
            tracing::warn!(%to, api_path, "Character server redirected a file elsewhere");
            return Err(UNAVAILABLE);
        }
        response = state.http.get(location).timeout(FILE_TIMEOUT).send().await.map_err(unavailable)?;
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(not_found("factory_file_not_found", "캐릭터 서버에 그 파일이 없습니다."));
    }
    if !response.status().is_success() {
        return Err(UNAVAILABLE);
    }
    if response.content_length().is_some_and(|length| length as usize > limit) {
        return Err(TOO_LARGE);
    }
    if let (Some(received), Some(length)) = (received, response.content_length()) {
        received.total.store(length as usize, Ordering::Relaxed);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(unavailable)?);
        if bytes.len() > limit {
            return Err(TOO_LARGE);
        }
        if let Some(received) = received {
            received.bytes.store(bytes.len(), Ordering::Relaxed);
        }
    }
    Ok(bytes)
}

/// The body of a JSON answer, read up to [`MAX_JSON_BYTES`]: a larger one is not read on.
async fn read_json(response: reqwest::Response) -> ApiResult<Value> {
    if response.content_length().is_some_and(|length| length > MAX_JSON_BYTES as u64) {
        return Err(UNAVAILABLE);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(unavailable)?);
        if bytes.len() > MAX_JSON_BYTES {
            tracing::warn!("Character server sent more JSON than is read");
            return Err(UNAVAILABLE);
        }
    }
    tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes))
        .await
        .map_err(internal)?
        .map_err(|_| UNAVAILABLE)
}

/// JSON from the character server's `/api/`; None for each status in `absent`. Its job listing answers 503
/// `listing_pending` while a cold snapshot is still being read, so that is retried a few times.
async fn fetch_json_but(
    state: &AppState,
    username: &str,
    api_path: &str,
    absent: &[reqwest::StatusCode],
) -> ApiResult<Option<Value>> {
    let factory = factory(state)?;
    let url = api_url(factory, api_path)?;
    for attempt in 1..=LISTING_ATTEMPTS {
        let response =
            send(state, signed(state.http.get(url.clone()), factory, username).timeout(JSON_TIMEOUT)).await?;
        match response.status() {
            status if absent.contains(&status) => return Ok(None),
            status if status.is_success() => return read_json(response).await.map(Some),
            reqwest::StatusCode::SERVICE_UNAVAILABLE if attempt < LISTING_ATTEMPTS => {
                tokio::time::sleep(LISTING_RETRY).await;
            }
            status => {
                tracing::warn!(%status, api_path, "Character server refused a read");
                return Err(UNAVAILABLE);
            }
        }
    }
    Err(UNAVAILABLE)
}

/// JSON from the character server's `/api/`, at most [`MAX_JSON_BYTES`]; None for a 404.
pub async fn fetch_json(state: &AppState, username: &str, api_path: &str) -> ApiResult<Option<Value>> {
    fetch_json_but(state, username, api_path, &[reqwest::StatusCode::NOT_FOUND]).await
}

/// Like [`fetch_json`], and None for a 422 as well: the request was understood but does not apply (a colour palette
/// for a part without a texture).
pub async fn fetch_json_if_applicable(state: &AppState, username: &str, api_path: &str) -> ApiResult<Option<Value>> {
    let absent = [reqwest::StatusCode::NOT_FOUND, reqwest::StatusCode::UNPROCESSABLE_ENTITY];
    fetch_json_but(state, username, api_path, &absent).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_decode_like_python_b64decode_when_32_bytes_or_more() {
        let raw: Vec<u8> = (0..48).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(hmac_key(&encoded), raw);
        assert_eq!(hmac_key(&format!("  {encoded}\n")), raw);
        let plain = "not base64 because of spaces and it is long enough!";
        assert_eq!(hmac_key(plain), plain.as_bytes());
        assert_eq!(hmac_key("c2hvcnQ="), b"c2hvcnQ=".to_vec());
        // A finished pad run ends the input, as in CPython.
        let padded = base64::engine::general_purpose::STANDARD.encode(&raw[..34]);
        assert_eq!(hmac_key(&format!("{padded}tail")), raw[..34].to_vec());
    }

    #[test]
    fn operator_tokens_carry_the_claims_auth_py_reads() {
        let token = FactoryToken {
            key: vec![1; 32],
            issuer: "mogaesup".into(),
            audience: "mogaesup-client".into(),
            owner_id: 1,
        };
        let jwt = operator_token(&token, "operator");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["userId"], 1);
        assert_eq!(claims["token_type"], "access");
        assert_eq!(claims["roles"][0], "ADMIN");
        let expected = URL_SAFE_NO_PAD.encode(hmac_sha256(&token.key, format!("{}.{}", parts[0], parts[1]).as_bytes()));
        assert_eq!(parts[2], expected);
    }

    fn read(path: &str) -> Option<Vec<String>> {
        path_segments(path).ok()
    }

    fn strings(segments: &[&str]) -> Vec<String> {
        segments.iter().map(|segment| (*segment).to_owned()).collect()
    }

    #[test]
    fn a_path_is_read_once_and_nothing_that_could_mean_another_survives() {
        assert_eq!(read("avatar-factory/wardrobe/bodies"), Some(strings(&["avatar-factory", "wardrobe", "bodies"])));
        // Decoded once: letters, spaces and UTF-8 pass, and come out as the characters they stand for.
        assert_eq!(read("studio/%ED%95%9C%EA%B8%80/a%20b/%77x"), Some(strings(&["studio", "한글", "a b", "wx"])));
        for refused in [
            "",
            "a/",
            "/a",
            "a//b",
            "a/./b",
            "a/../b",
            "a/..",
            "a/%2e/b",
            "a/%2e%2e/b",
            "a/.%2e/b",
            "a/%2e./b",
            "a/%2E%2E/b",
            "a/%252e%252e/b",
            "a/%252f",
            "a/..%2fb",
            "a/b%2Fc",
            "a/b%5cc",
            "a/b\\c",
            "a/%00",
            "a/%0a",
            "a/%7f",
            "a/%c2%85",
            "a/%ff",
            "a/%c3",
            "a/%",
            "a/%2",
            "a/%zz",
            "a/%+f",
            "a/100%",
        ] {
            assert_eq!(read(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn what_a_request_needs_follows_the_segments_it_is_read_into() {
        let need_of = |method: &Method, path: &str| need(method, &read(path).unwrap());
        for path in ["avatar-factory/wardrobe/bodies", "avatar-factory/%77ardrobe/colors/j/hat"] {
            assert_eq!(need_of(&Method::GET, path), Need::Member, "{path}");
        }
        assert_eq!(need_of(&Method::GET, "avatar-factory/jobs/j1/native-parts/v2/body.glb"), Need::Member);
        for path in ["avatar-factory/jobs", "avatar-factory/jobs/j1/native-parts/v2/model.json", "studio/catalog"] {
            assert_eq!(need_of(&Method::GET, path), Need::Read, "{path}");
        }
        assert_eq!(need_of(&Method::HEAD, "avatar-factory/wardrobe/bodies"), Need::Member);
        // Uploads, selections and the local sheet crop are free; every other POST starts paid work.
        for path in [
            "avatar-factory/part-batches/split-sheet",
            "avatar-factory/jobs/j1/native-parts/select",
            "studio/glb-assets/upload",
            "characters",
        ] {
            assert_eq!(need_of(&Method::POST, path), Need::Write, "{path}");
        }
        for path in ["avatar-factory/part-batches", "avatar-factory/part-batches/b1/resume", "studio/%67enerations"] {
            assert_eq!(need_of(&Method::POST, path), Need::Paid, "{path}");
        }
        for method in [Method::PUT, Method::PATCH, Method::DELETE] {
            assert_eq!(need_of(&method, "studio/generations"), Need::Write, "{method}");
        }
    }

    fn settings(url: &str) -> Factory {
        Factory {
            url: url.into(),
            api_key: None,
            token: None,
            access: FactoryAccess::Read,
            paid_monthly: 0,
            gateway_key: None,
            instance: None,
        }
    }

    #[test]
    fn the_character_server_is_sent_each_segment_encoded_again_and_the_query_as_it_came() {
        let factory = settings("http://127.0.0.1:8000");
        let url =
            target(&factory, &strings(&["avatar-factory", "a b", "한", "x?y#z"]), Some("version=v1&q=%20")).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:8000/api/avatar-factory/a%20b/%ED%95%9C/x%3Fy%23z?version=v1&q=%20");
        assert_eq!(target(&factory, &strings(&["health"]), None).unwrap().as_str(), "http://127.0.0.1:8000/api/health");
        // The callers' own paths carry their query in the string.
        let own = api_url(&factory, "avatar-factory/wardrobe/colors/j1/hat/mask?version=v2").unwrap();
        assert_eq!(own.as_str(), "http://127.0.0.1:8000/api/avatar-factory/wardrobe/colors/j1/hat/mask?version=v2");
        assert!(api_url(&factory, "avatar-factory/../jobs").is_err());
    }

    #[test]
    fn a_redirect_is_followed_to_https_or_home_and_never_with_credentials() {
        let follow = |location: &str| follows(&reqwest::Url::parse(location).unwrap(), "http://127.0.0.1:8000");
        assert!(follow("https://bucket.s3.ap-northeast-2.amazonaws.com/key?X-Amz-Signature=1"));
        assert!(follow("http://127.0.0.1:8000/signed/a.glb"));
        assert!(!follow("http://169.254.169.254/latest/meta-data/"));
        assert!(!follow("http://127.0.0.1:9000/signed/a.glb"));
        assert!(!follow("http://bucket.s3.amazonaws.com/key"));
        assert!(!follow("https://user:secret@bucket.s3.amazonaws.com/key"));
        assert!(!follow("https://user@bucket.s3.amazonaws.com/key"));
        assert!(!follow("http://user@127.0.0.1:8000/signed/a.glb"));
        assert!(!follow("file:///etc/passwd"));
        assert!(!follows(&reqwest::Url::parse("http://127.0.0.1:8000/x").unwrap(), "not a url"));
    }
}
