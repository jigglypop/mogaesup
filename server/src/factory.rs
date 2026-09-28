use axum::{
    Router,
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderName, Method, StatusCode, header},
    response::Response,
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{
    AppState,
    auth::require_admin,
    config::{Factory, FactoryToken},
    error::{ApiError, ApiResult, not_found},
    security::hmac_sha256,
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

/// The HMAC key exactly as gaesup-character's `auth.py` derives it: the stripped secret, used decoded when Python's
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
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
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

fn signed(request: reqwest::RequestBuilder, factory: &Factory, username: &str) -> reqwest::RequestBuilder {
    let request = match &factory.token {
        Some(token) => request.bearer_auth(operator_token(token, username)),
        None => request,
    };
    match &factory.api_key {
        Some(key) => request.header("x-api-key", key),
        None => request,
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/factory/{*path}", any(proxy))
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
    let factory = factory(&state)?;
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
    let upstream = signed(request, factory, &admin.username).send().await.map_err(|error| {
        tracing::warn!(%error, "Character server request failed");
        UNAVAILABLE
    })?;
    let mut response = Response::builder().status(upstream.status().as_u16());
    for name in FORWARDED_RESPONSE_HEADERS {
        if let Some(value) = upstream.headers().get(name.as_str()) {
            response = response.header(name, value.as_bytes());
        }
    }
    response.body(Body::from_stream(upstream.bytes_stream())).map_err(crate::error::internal)
}

fn unavailable(error: reqwest::Error) -> ApiError {
    tracing::warn!(%error, "Character server request failed");
    UNAVAILABLE
}

/// A file under the character server's `/api/`, at most `limit` bytes. Its files answer with a presigned S3 redirect,
/// followed here without the operator token or key.
pub async fn fetch_file(state: &AppState, username: &str, api_path: &str, limit: usize) -> ApiResult<Vec<u8>> {
    let factory = factory(state)?;
    let url = format!("{}/api/{api_path}", factory.url);
    let mut response =
        signed(state.http.get(&url), factory, username).timeout(FILE_TIMEOUT).send().await.map_err(unavailable)?;
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
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(unavailable)?);
        if bytes.len() > limit {
            return Err(too_large());
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
        let response =
            signed(state.http.get(&url), factory, username).timeout(JSON_TIMEOUT).send().await.map_err(unavailable)?;
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

pub const fn too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "model_too_large", "모델 파일이 너무 큽니다.")
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
