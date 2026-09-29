use axum::{
    Json, Router,
    body::Body,
    extract::{OriginalUri, Path, RawQuery, State},
    http::{HeaderMap, HeaderName, Method, StatusCode, header},
    response::Response,
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use crate::{
    AppState,
    auth::{current_user, require_admin},
    config::{Factory, FactoryAccess, FactoryToken},
    error::{ApiError, ApiResult, forbidden, internal, not_found},
    security::{epoch_seconds, hmac_sha256},
};

const OPERATOR_TOKEN_SECONDS: u64 = 300;
const FILE_TIMEOUT: Duration = Duration::from_secs(60);
/// A cold job listing can take the character server twelve seconds.
const JSON_TIMEOUT: Duration = Duration::from_secs(30);
const LISTING_ATTEMPTS: u32 = 3;
const LISTING_RETRY: Duration = Duration::from_secs(2);
pub const MAX_MODEL_BYTES: usize = 64 * 1024 * 1024;
const MIN_SECRET_BYTES: usize = 32;
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

/// What a studio request needs from whoever sends it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Need {
    /// Any signed-in member: reading the wardrobe (bodies, parts, colours, previews) and the part models it puts on.
    Member,
    /// An admin, reading anything else.
    Admin,
    /// An admin, changing the studio's records; `FACTORY_ACCESS=write` or more.
    Write,
    /// An admin, starting work that can cost money; `FACTORY_ACCESS=paid` and budget left this month.
    Paid,
}

/// Uploads and selections that never start paid work. Every other POST is treated as paid: the character server starts
/// generation, rigging, retries and resumes with POSTs, and a new one must not slip through as free.
const FREE_POSTS: [&[&str]; 9] = [
    &["avatar-factory", "jobs", "*", "native-parts", "select"],
    &["avatar-factory", "base-bodies", "glb-assets"],
    &["avatar-factory", "meshy-options", "texture-assets"],
    &["avatar-blueprints", "assets"],
    &["studio", "glb-assets"],
    &["studio", "glb-assets", "upload"],
    &["studio", "animals", "references"],
    &["characters"],
    &["characters", "*", "sources"],
];

/// The policy for one studio request; `path` is below `/api/`, e.g. `avatar-factory/wardrobe/bodies`.
fn need(method: &Method, path: &str) -> Need {
    let segments: Vec<&str> = path.split('/').collect();
    if matches!(*method, Method::GET | Method::HEAD) {
        let member = match segments.as_slice() {
            ["avatar-factory", "wardrobe", ..] => true,
            ["avatar-factory", "jobs", _, "native-parts", _, file] => file.ends_with(".glb"),
            _ => false,
        };
        return if member { Need::Member } else { Need::Admin };
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
async fn paid_this_month(state: &AppState) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM factory_requests
         WHERE paid AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    )
    .fetch_one(&state.db)
    .await?)
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
    let path = uri.path().trim_start_matches("/api/").to_owned();
    let need = need(&method, &path);
    let user = match need {
        Need::Member => current_user(&state, &headers).await?,
        _ => require_admin(&state, &headers).await?,
    };
    let factory = factory(&state)?;
    let paid = need == Need::Paid;
    match need {
        Need::Write if factory.access < FactoryAccess::Write => return Err(READ_ONLY),
        Need::Paid if factory.access < FactoryAccess::Paid => return Err(PAID_OFF),
        Need::Paid if paid_this_month(&state).await? >= factory.paid_monthly => return Err(BUDGET_SPENT),
        _ => {}
    }
    // A change the sleeping studio cannot take is not recorded (nor counted against the paid budget).
    if matches!(need, Need::Write | Need::Paid)
        && let Some(asleep) = state.power.before().await
    {
        return Err(asleep);
    }
    let record = if matches!(need, Need::Write | Need::Paid) {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO factory_requests (user_id, method, path, paid) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(user.id)
        .bind(method.as_str())
        .bind(&path)
        .bind(paid)
        .fetch_one(&state.db)
        .await?;
        if paid {
            tracing::warn!(user = %user.username, %method, %path, "paid studio request");
        }
        Some(id)
    } else {
        None
    };
    let response = forward(&state, &user.username, method, &headers, &path, query, body).await;
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
    require_admin(&state, &headers).await?;
    let Some(factory) = state.config.factory.as_ref() else {
        return Ok(Json(json!({"connected": false})));
    };
    Ok(Json(json!({
        "connected": true,
        "access": factory.access,
        "paidThisMonth": paid_this_month(&state).await?,
        "paidMonthly": factory.paid_monthly,
    })))
}

/// The character server's `/api/*` for admins, signed in as its operator. Bodies stream both ways.
async fn proxy(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    body: Body,
) -> ApiResult<Response> {
    let admin = require_admin(&state, &headers).await?;
    forward(&state, &admin.username, method, &headers, &path, query, body).await
}

/// Sends one request to the character server's `/api/{path}` as the operator and streams its answer back.
async fn forward(
    state: &AppState,
    username: &str,
    method: Method,
    headers: &HeaderMap,
    path: &str,
    query: Option<String>,
    body: Body,
) -> ApiResult<Response> {
    let factory = factory(state)?;
    if path.split('/').any(|segment| segment == ".." || segment.is_empty()) {
        return Err(not_found("not_found", "찾을 수 없습니다."));
    }
    let url = format!("{}/api/{path}{}", factory.url, query.map(|q| format!("?{q}")).unwrap_or_default());
    let mut request = state.http.request(method, url).body(reqwest::Body::wrap_stream(body.into_data_stream()));
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = headers.get(&name) {
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

/// A file under the character server's `/api/`, at most `limit` bytes, counting what has arrived into `received` as it
/// streams in. Its files answer with a presigned S3 redirect, followed here without the operator token or key.
pub async fn fetch_file(
    state: &AppState,
    username: &str,
    api_path: &str,
    limit: usize,
    received: Option<&Received>,
) -> ApiResult<Vec<u8>> {
    let factory = factory(state)?;
    let url = format!("{}/api/{api_path}", factory.url);
    let mut response = send(state, signed(state.http.get(&url), factory, username).timeout(FILE_TIMEOUT)).await?;
    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(header::LOCATION.as_str())
            .and_then(|v| v.to_str().ok())
            .and_then(|v| response.url().join(v).ok())
            .ok_or(UNAVAILABLE)?;
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

/// JSON from the character server's `/api/`; None for a 404. Its job listing answers 503 `listing_pending` while a cold
/// snapshot is still being read, so that is retried a few times.
pub async fn fetch_json(state: &AppState, username: &str, api_path: &str) -> ApiResult<Option<Value>> {
    let factory = factory(state)?;
    let url = format!("{}/api/{api_path}", factory.url);
    for attempt in 1..=LISTING_ATTEMPTS {
        let response = send(state, signed(state.http.get(&url), factory, username).timeout(JSON_TIMEOUT)).await?;
        match response.status() {
            reqwest::StatusCode::NOT_FOUND => return Ok(None),
            status if status.is_success() => {
                let bytes = response.bytes().await.map_err(unavailable)?;
                return serde_json::from_slice(&bytes).map(Some).map_err(|_| UNAVAILABLE);
            }
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
}
