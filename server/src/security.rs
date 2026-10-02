use axum::{
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    AppState,
    error::{ApiError, ApiResult, forbidden, internal},
};

pub const FOREIGN_ORIGIN: ApiError = forbidden("origin", "허용되지 않은 요청 출처입니다.");

/// Whether the request's Origin is one of the site's own (`APP_ORIGIN`).
pub fn same_origin(state: &AppState, headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    origin.is_some_and(|origin| state.config.origins.iter().any(|v| v == origin))
}

/// Writes must come from the site itself: a matching Origin, not cross-site, and JSON bodies (a cross-site form cannot
/// send JSON without a preflight). The studio gateway carries uploads, so it only needs the Origin.
pub async fn protect(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        let headers = request.headers();
        let cross_site = headers.get("sec-fetch-site").is_some_and(|v| v == "cross-site");
        if cross_site || !same_origin(&state, headers) {
            return FOREIGN_ORIGIN.into_response();
        }
        let json =
            headers.get(header::CONTENT_TYPE).is_some_and(|v| v.to_str().unwrap_or("").starts_with("application/json"));
        // The studio's own uploads are multipart; its requests go to the character server as they came.
        if !json && !crate::factory::is_studio_path(request.uri().path()) {
            return ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required", "JSON 요청이 필요합니다.")
                .into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'none'; frame-ancestors 'none'".parse().unwrap());
    response
}

const RATE_WINDOW: Duration = Duration::from_secs(600);
const RATE_KEYS: usize = 50_000;

/// Fixed ten-minute windows per key. Expired windows are swept at most every thirty seconds, and a full table drops its
/// oldest windows: a flood of new keys must never refuse existing callers.
#[derive(Default)]
pub struct RateTable {
    windows: HashMap<String, (Instant, u32)>,
    swept: Option<Instant>,
}

impl RateTable {
    fn sweep(&mut self, now: Instant) {
        if self.swept.is_none_or(|at| now.duration_since(at) >= Duration::from_secs(30)) {
            self.windows.retain(|_, (start, _)| now.duration_since(*start) < RATE_WINDOW);
            self.swept = Some(now);
        }
    }
    fn count(&mut self, key: &str) -> u32 {
        let now = Instant::now();
        self.sweep(now);
        self.windows
            .get(key)
            .filter(|(start, _)| now.duration_since(*start) < RATE_WINDOW)
            .map_or(0, |(_, count)| *count)
    }
    fn record(&mut self, key: String) -> u32 {
        let now = Instant::now();
        self.sweep(now);
        if self.windows.len() >= RATE_KEYS && !self.windows.contains_key(&key) {
            let mut starts: Vec<Instant> = self.windows.values().map(|(start, _)| *start).collect();
            starts.sort_unstable();
            let cutoff = starts[starts.len() / 10];
            self.windows.retain(|_, (start, _)| *start > cutoff);
        }
        let entry = self.windows.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= RATE_WINDOW {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
        entry.1
    }

    fn refund(&mut self, key: &str, started: Instant) {
        if let Some((window, count)) = self.windows.get_mut(key)
            && *window == started
        {
            *count = count.saturating_sub(1);
        }
    }
}

const TOO_MANY: ApiError =
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too_many", "시도가 너무 많습니다. 10분 후 다시 시도해 주세요.");

/// Reserves the budget before asynchronous work starts. Successful checks and abandoned requests refund it;
/// failures keep it. Checking and reserving every key happen under one lock.
pub struct RateReservation {
    table: Arc<Mutex<RateTable>>,
    keys: Vec<(String, Instant)>,
    keep: bool,
}

impl RateReservation {
    pub fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for RateReservation {
    fn drop(&mut self) {
        if !self.keep
            && let Ok(mut table) = self.table.lock()
        {
            for (key, started) in &self.keys {
                table.refund(key, *started);
            }
        }
    }
}

pub fn rate_reserve(state: &AppState, limits: &[(String, u32)]) -> ApiResult<RateReservation> {
    let mut table = state.attempts.lock().map_err(internal)?;
    if limits.iter().any(|(key, max)| table.count(key) >= *max) {
        return Err(TOO_MANY);
    }
    let mut keys = Vec::with_capacity(limits.len());
    for (key, _) in limits {
        table.record(key.clone());
        keys.push((key.clone(), table.windows[key].0));
    }
    Ok(RateReservation { table: state.attempts.clone(), keys, keep: false })
}

/// Records one event and refuses once more than `max` were recorded in the window.
pub fn rate_limit(state: &AppState, key: String, max: u32) -> ApiResult<()> {
    let count = state.attempts.lock().map_err(internal)?.record(key);
    if count > max { Err(TOO_MANY) } else { Ok(()) }
}

/// Refuses once `max` events were recorded in the window, without recording one.
pub fn rate_exceeded(state: &AppState, key: &str, max: u32) -> ApiResult<()> {
    if state.attempts.lock().map_err(internal)?.count(key) >= max { Err(TOO_MANY) } else { Ok(()) }
}

pub fn rate_record(state: &AppState, key: String) {
    if let Ok(mut table) = state.attempts.lock() {
        table.record(key);
    }
}

/// The viewer address CloudFront appended to X-Forwarded-For. Earlier entries come from the client and are ignored;
/// without the header (local development) every caller shares one key.
pub fn client_address(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit(',').next())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .unwrap_or_else(|| "local".into())
}

/// Now in whole seconds since the Unix epoch, as signed tokens count their expiry.
pub fn epoch_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 64];
    if secret.len() > 64 {
        key[..32].copy_from_slice(&Sha256::digest(secret));
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for i in 0..64 {
        inner[i] ^= key[i];
        outer[i] ^= key[i];
    }
    let inner_hash = Sha256::new().chain_update(inner).chain_update(message).finalize();
    Sha256::new().chain_update(outer).chain_update(inner_hash).finalize().into()
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case_two() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex::encode(digest), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn client_address_takes_the_proxy_appended_entry() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "10.0.0.9, 203.0.113.7".parse().unwrap());
        assert_eq!(client_address(&headers), "203.0.113.7");
        assert_eq!(client_address(&HeaderMap::new()), "local");
    }
}
