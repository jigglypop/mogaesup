use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::time::Duration;
use tokio::sync::OwnedSemaphorePermit;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult, LOGIN_REQUIRED, bad, conflict, forbidden, internal},
    rebac::{self, Actor, Checker, PERMISSIONS, Permission, ROLE_COLUMN, Subject, Tuple},
    security::{client_address, rate_exceeded, rate_limit, rate_record, rate_reserve},
};

const SESSION_COOKIE: &str = "mogaesup_session";
/// Signed-in devices one account keeps. A new sign-in past it ends the sessions used least recently.
pub const SESSIONS_PER_USER: i64 = 20;
/// A session lasts this long after it was made or last renewed, and so does its cookie (`SESSION_TERM` in SQL).
const SESSION_MAX_AGE_SECONDS: u32 = 30 * 24 * 60 * 60;
const SESSION_TERM: &str = "30 days";
/// A session in use is renewed once its expiry is closer than this, about a day after its last renewal: a device used
/// every few weeks stays signed in, and a row is written at most once a day however often the app opens.
const SESSION_RENEW_BELOW: &str = "29 days";
/// Wrong passwords from one address, and for one account, in the rate window (ten minutes).
const LOGIN_FAILURES_PER_ADDRESS: u32 = 30;
const LOGIN_FAILURES_PER_ACCOUNT: u32 = 50;
/// How long a password check waits for a hashing slot: a burst of sign-ins is turned away instead of queueing forever.
const HASH_WAIT: Duration = Duration::from_secs(10);
/// How long a sign-in route may take in all.
const AUTH_DEADLINE: Duration = Duration::from_secs(30);
const BUSY: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "busy",
    "지금 로그인하는 사람이 많아요. 잠시 뒤에 다시 시도해 주세요.",
);
/// Names that read as the site's own staff. New accounts cannot take them; existing ones keep working. Usernames are
/// ASCII, so the Korean ones only matter if that ever changes.
const RESERVED_NAMES: [&str; 9] =
    ["admin", "administrator", "mogaesup", "root", "system", "support", "staff", "운영자", "관리자"];
const USERNAME_TAKEN: ApiError = conflict("username_taken", "이미 사용 중인 아이디입니다.");

/// A signed-in account. `role` is `admin` while it holds `system:mogaesup#admin` (see [`rebac`]), else `user`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: String,
}

impl User {
    fn from_row(row: &PgRow) -> Self {
        Self {
            id: row.get("id"),
            username: row.get("username"),
            display_name: row.get("display_name"),
            role: row.get("role"),
        }
    }
}

/// The token of a well-formed session cookie.
fn session_token(headers: &HeaderMap) -> Option<&str> {
    let prefix = format!("{SESSION_COOKIE}=");
    let token = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookie| cookie.split(';'))
        .find_map(|item| item.trim().strip_prefix(prefix.as_str()))?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

/// The session token's hash, from a well-formed session cookie.
pub(crate) fn token_hash(headers: &HeaderMap) -> Option<String> {
    session_token(headers).map(|token| hex::encode(Sha256::digest(token.as_bytes())))
}

pub async fn optional_user(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<User>> {
    let Some(token) = token_hash(headers) else { return Ok(None) };
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()"
    ))
    .bind(token)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.as_ref().map(User::from_row))
}

pub async fn current_user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    optional_user(state, headers).await?.ok_or(LOGIN_REQUIRED)
}

pub(crate) async fn active_session(state: &AppState, hash: &str, user: Uuid) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND expires_at > now())",
    )
    .bind(hash)
    .bind(user)
    .fetch_one(&state.db)
    .await?)
}

/// The signed-in user, when they hold `permission`; 403 with the permission's own code otherwise.
pub async fn require(state: &AppState, headers: &HeaderMap, permission: Permission) -> ApiResult<User> {
    let user = current_user(state, headers).await?;
    if Checker::new(&state.db).allows(Subject::User(user.id), &permission).await? {
        Ok(user)
    } else {
        Err(forbidden(permission.code, permission.message))
    }
}

/// `user` as the app keeps it, with the names of the [`PERMISSIONS`] it holds (`permissions`).
async fn with_permissions(state: &AppState, user: &User) -> ApiResult<Value> {
    let mut checker = Checker::new(&state.db);
    let mut held = Vec::new();
    for permission in PERMISSIONS {
        if checker.allows(Subject::User(user.id), &permission).await? {
            held.push(permission.name);
        }
    }
    let mut value = serde_json::to_value(user).map_err(internal)?;
    value["permissions"] = json!(held);
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
}

pub(crate) fn username(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_lowercase();
    if !(3..=20).contains(&name.len()) || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err(bad("invalid_username", "아이디는 영문·숫자·밑줄·하이픈 3~20자로 입력해 주세요."));
    }
    Ok(name)
}

fn display_name(raw: Option<&str>, fallback: &str) -> ApiResult<String> {
    let name = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or(fallback).to_owned();
    if name.chars().count() > 20 || name.chars().any(char::is_control) {
        return Err(bad("invalid_name", "이름은 20자 이하로 입력해 주세요."));
    }
    Ok(name)
}

fn new_password(password: &str) -> ApiResult<()> {
    if !(10..=128).contains(&password.chars().count()) {
        return Err(bad("invalid_password", "비밀번호는 10~128자로 입력해 주세요."));
    }
    if password.trim().is_empty() {
        return Err(bad("invalid_password", "비밀번호를 공백만으로 만들 수 없습니다."));
    }
    Ok(())
}

/// A hashing slot, waited for at most [`HASH_WAIT`].
async fn hashing_slot(state: &AppState) -> ApiResult<OwnedSemaphorePermit> {
    match tokio::time::timeout(HASH_WAIT, state.hashing.clone().acquire_owned()).await {
        Ok(permit) => permit.map_err(internal),
        Err(_) => Err(BUSY),
    }
}

/// The sign-in routes answer within [`AUTH_DEADLINE`], whatever they wait for.
pub async fn deadline(request: Request, next: Next) -> Response {
    tokio::time::timeout(AUTH_DEADLINE, next.run(request)).await.unwrap_or_else(|_| BUSY.into_response())
}

async fn hash_password(state: &AppState, password: String) -> ApiResult<String> {
    let permit = hashing_slot(state).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|v| v.to_string())
    })
    .await
    .map_err(internal)?
    .map_err(internal)
}

/// Checks against `hash`, or spends the same work on a throwaway hash so unknown usernames take as long.
async fn verify_password(state: &AppState, hash: Option<String>, password: String) -> ApiResult<bool> {
    verify_in(hashing_slot(state).await?, hash, password).await
}

/// [`verify_password`] in a hashing slot already held.
async fn verify_in(permit: OwnedSemaphorePermit, hash: Option<String>, password: String) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match hash {
            Some(hash) => PasswordHash::new(&hash)
                .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()),
            None => {
                let salt = SaltString::generate(&mut rand::rngs::OsRng);
                let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
                false
            }
        }
    })
    .await
    .map_err(internal)
}

/// The account and its minihome in one transaction; false when the username is taken. It holds no permission yet.
async fn create_account(db: &PgPool, user: &User, password_hash: &str, bootstrap: bool) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7309003))")
        .bind(&user.username)
        .execute(&mut *tx)
        .await?;
    if !bootstrap
        && sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM auth_reserved_usernames WHERE username = $1)")
            .bind(&user.username)
            .fetch_one(&mut *tx)
            .await?
    {
        return Ok(false);
    }
    let inserted = sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING",
    )
    .bind(user.id)
    .bind(&user.username)
    .bind(&user.display_name)
    .bind(password_hash)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    crate::homes::create(&mut *tx, user).await?;
    tx.commit().await?;
    Ok(true)
}

fn session_cookie(state: &AppState, token: &str, max_age: u32) -> String {
    let secure = if state.config.cookie_secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")
}

async fn session(state: &AppState, user: User, status: StatusCode) -> ApiResult<Response> {
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token = hex::encode(random);
    let mut tx = state.db.begin().await?;
    // Serialize admission and pruning for an account, including concurrent successful logins.
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user.id).execute(&mut *tx).await?;
    sqlx::query(&format!(
        "INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, clock_timestamp() + interval '{SESSION_TERM}')"
    ))
    .bind(hex::encode(Sha256::digest(token.as_bytes())))
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    // Bound stolen or forgotten sessions per account. A session's expiry moves with its use (see `me`, renewed at most a
    // day apart), so the latest expiries are the devices used most recently and the earliest are the ones that go.
    let expired: Vec<String> = sqlx::query_scalar(
        "DELETE FROM sessions WHERE token_hash IN
         (SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY expires_at DESC, token_hash DESC OFFSET $2) RETURNING token_hash",
    )
    .bind(user.id)
    .bind(SESSIONS_PER_USER)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    for hash in expired {
        state.rooms.end_session(&hash);
        state.games.end_session(&hash);
    }
    let cookie = session_cookie(state, &token, SESSION_MAX_AGE_SECONDS);
    let user = with_permissions(state, &user).await?;
    Ok((status, [(header::SET_COOKIE, cookie)], Json(json!({"user": user}))).into_response())
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let name = username(&body.username)?;
    new_password(&body.password)?;
    let display = display_name(body.display_name.as_deref(), &name)?;
    if RESERVED_NAMES.iter().any(|reserved| reserved.eq_ignore_ascii_case(&name)) {
        return Err(USERNAME_TAKEN);
    }
    // Attempts are limited per address; the site-wide cap counts only created accounts, so rejected requests cannot
    // close sign-up for everyone.
    rate_limit(&state, format!("register-address:{}", client_address(&headers)), 20)?;
    rate_limit(&state, format!("register:{name}"), 5)?;
    let created = rate_reserve(&state, &[("register-created".into(), 600)])?;
    let hash = hash_password(&state, body.password).await?;
    let user = User { id: Uuid::new_v4(), username: name, display_name: display, role: "user".into() };
    if !create_account(&state.db, &user, &hash, false).await? {
        return Err(USERNAME_TAKEN);
    }
    created.keep();
    session(&state, user, StatusCode::CREATED).await
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let name = username(&body.username)?;
    if body.password.is_empty() || body.password.chars().count() > 128 {
        return Err(bad("invalid_password", "비밀번호를 확인해 주세요."));
    }
    // Only wrong passwords count, per address and per account; a limit shared by everyone would let one client lock
    // all players out. Checks still running are held against the account alone: many people share one address (a
    // school, a mobile carrier), and their sign-ins in flight must not use up its budget.
    let address_key = format!("login-failed-address:{}", client_address(&headers));
    rate_exceeded(&state, &address_key, LOGIN_FAILURES_PER_ADDRESS)?;
    let attempt = rate_reserve(&state, &[(format!("login-failed:{name}"), LOGIN_FAILURES_PER_ACCOUNT)])?;
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, u.password_hash FROM users u WHERE u.username = $1"
    ))
    .bind(&name)
    .fetch_optional(&state.db)
    .await?;
    let hash = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    // Asked again once a hashing slot is held: checks run two at a time (HASHING_SLOTS), so a burst of wrong passwords
    // from one address passes its budget by a few at most, however many of them were waiting.
    let slot = hashing_slot(&state).await?;
    rate_exceeded(&state, &address_key, LOGIN_FAILURES_PER_ADDRESS)?;
    if !verify_in(slot, hash, body.password).await? {
        attempt.keep();
        rate_record(&state, address_key);
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "아이디 또는 비밀번호가 올바르지 않습니다.",
        ));
    }
    let user = User::from_row(&row.expect("verified rows exist"));
    session(&state, user, StatusCode::OK).await
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(hash) = token_hash(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(&hash).execute(&state.db).await?;
        state.rooms.end_session(&hash);
        state.games.end_session(&hash);
    }
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, session_cookie(&state, "", 0))]).into_response())
}

/// `GET /api/auth/me`, which the app asks each time it opens: who is signed in. A session whose expiry has come closer
/// than [`SESSION_RENEW_BELOW`] is renewed to a full term here, and its cookie sent again with the full Max-Age, so a
/// device in use stays signed in. Other reads of the session ([`optional_user`]) only read it.
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let Some(token) = session_token(&headers) else { return Ok(Json(json!({"user": null})).into_response()) };
    // One statement: the renewal sees the row the read finds, and a renewal already made (another tab, a moment ago)
    // leaves the expiry too far off to match again.
    let row = sqlx::query(&format!(
        "WITH renewed AS (
           UPDATE sessions SET expires_at = clock_timestamp() + interval '{SESSION_TERM}'
           WHERE token_hash = $1 AND expires_at > now() AND expires_at < now() + interval '{SESSION_RENEW_BELOW}'
           RETURNING token_hash)
         SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, EXISTS (SELECT 1 FROM renewed) AS renewed
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()"
    ))
    .bind(hex::encode(Sha256::digest(token.as_bytes())))
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(Json(json!({"user": null})).into_response()) };
    let user = with_permissions(&state, &User::from_row(&row)).await?;
    let mut response = Json(json!({"user": user})).into_response();
    if row.get::<bool, _>("renewed") {
        let cookie = session_cookie(&state, token, SESSION_MAX_AGE_SECONDS);
        response.headers_mut().insert(header::SET_COOKIE, cookie.parse().map_err(internal)?);
    }
    Ok(response)
}

pub async fn realtime_ticket(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    // A page asks for one when its room connects and again each time the connection drops (checked every second, with
    // waits that double up to 30 seconds), so several tabs or a reconnect loop still fit.
    rate_limit(&state, format!("realtime-ticket:{}", user.id), 90)?;
    let hash = token_hash(&headers).ok_or(LOGIN_REQUIRED)?;
    let (ticket, expires_at) = crate::rooms::issue_ticket(&state.config.ticket_secret, &user, &hash);
    Ok(Json(json!({"ticket": ticket, "expiresAt": expires_at, "user": user})))
}

/// Creates the configured operator, or verifies ownership of the existing account before granting it admin. An existing
/// account whose password is another keeps it and is granted nothing; the server still starts.
pub async fn bootstrap_admin(state: &AppState, username_raw: &str, password: &str) -> anyhow::Result<()> {
    let name = username(username_raw)?;
    new_password(password)?;
    sqlx::query("INSERT INTO auth_reserved_usernames (username) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(&name)
        .execute(&state.db)
        .await?;
    let existing = sqlx::query("SELECT id, password_hash FROM users WHERE username = $1")
        .bind(&name)
        .fetch_optional(&state.db)
        .await?;
    let row = match existing {
        Some(row) => row,
        None => {
            let hash = hash_password(state, password.to_owned()).await?;
            let user =
                User { id: Uuid::new_v4(), username: name.clone(), display_name: name.clone(), role: "user".into() };
            if create_account(&state.db, &user, &hash, true).await? {
                return grant_bootstrap(state, &name, user.id).await;
            }
            // A concurrent bootstrap may have created it. Ownership is still verified before any grant.
            sqlx::query("SELECT id, password_hash FROM users WHERE username = $1")
                .bind(&name)
                .fetch_one(&state.db)
                .await?
        }
    };
    if !verify_password(state, Some(row.get("password_hash")), password.to_owned()).await? {
        tracing::warn!(
            username = %name,
            "BOOTSTRAP_ADMIN_PASSWORD does not match the existing account; it keeps its password and is not made admin"
        );
        return Ok(());
    }
    grant_bootstrap(state, &name, row.get("id")).await
}

async fn grant_bootstrap(state: &AppState, name: &str, id: Uuid) -> anyhow::Result<()> {
    let granted =
        rebac::grant(&state.db, &Tuple::admin(id), Actor::server("bootstrap"), "BOOTSTRAP_ADMIN_USERNAME").await?;
    if granted {
        tracing::warn!(username = %name, "Bootstrap admin granted");
    }
    Ok(())
}

/// The historic migration promoted `ydh2244` by name. Before that migration runs on an existing database, require
/// proof that a normal account of that name belongs to the configured operator. Already migrated admins stay intact.
pub async fn verify_legacy_admin_before_migration(db: &PgPool, bootstrap: Option<(&str, &str)>) -> anyhow::Result<()> {
    let has_users: bool = sqlx::query_scalar("SELECT to_regclass('users') IS NOT NULL").fetch_one(db).await?;
    if !has_users {
        return Ok(());
    }
    let has_migrations: bool =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL").fetch_one(db).await?;
    if has_migrations
        && sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 20260930120000 AND success)",
        )
        .fetch_one(db)
        .await?
    {
        return Ok(());
    }
    let Some(hash) = sqlx::query_scalar::<_, String>(
        "SELECT password_hash FROM users WHERE username = 'ydh2244' AND role <> 'admin'",
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(());
    };
    let password = bootstrap
        .filter(|(name, _)| name.trim().eq_ignore_ascii_case("ydh2244"))
        .map(|(_, password)| password.to_owned())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "existing legacy administrator name requires verified BOOTSTRAP_ADMIN credentials before migration"
            )
        })?;
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
    })
    .await?;
    anyhow::ensure!(valid, "legacy administrator password does not match the existing account");
    Ok(())
}

const CLEANUP_INTERVAL: Duration = Duration::from_secs(600);
/// Rows nothing reads any more: expired sessions, visit marks past any counter, and guestbook entries deleted a month ago.
const CLEANUP: [&str; 3] = [
    "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < now() LIMIT 5000)",
    "DELETE FROM home_visits WHERE ctid IN (SELECT ctid FROM home_visits WHERE day < current_date - 120 LIMIT 5000)",
    "DELETE FROM guestbook_entries WHERE id IN (SELECT id FROM guestbook_entries WHERE deleted_at < now() - interval '30 days' LIMIT 5000)",
];

pub fn spawn_cleanup(db: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
        loop {
            interval.tick().await;
            for statement in CLEANUP {
                if let Err(error) = sqlx::query(statement).execute(&db).await {
                    tracing::warn!(%error, "Cleanup failed");
                }
            }
            match crate::imports::interrupt_stale(&db).await {
                Ok(0) => {}
                Ok(stalled) => tracing::warn!(stalled, "Catalog imports that stopped moving were marked failed"),
                Err(error) => tracing::warn!(%error, "Cleanup failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_lowercased_and_bounded() {
        assert_eq!(username(" Mogae_1 ").unwrap(), "mogae_1");
        assert!(username("ab").is_err());
        assert!(username("has space").is_err());
        assert!(username(&"a".repeat(21)).is_err());
    }

    #[test]
    fn new_passwords_count_characters_and_refuse_blank() {
        assert!(new_password(&"가".repeat(10)).is_ok());
        assert!(new_password(&"가".repeat(9)).is_err());
        assert!(new_password(&" ".repeat(12)).is_err());
    }

    #[test]
    fn session_cookie_parsing_needs_a_well_formed_token() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, format!("x=1; {SESSION_COOKIE}={}", "a".repeat(64)).parse().unwrap());
        assert!(token_hash(&headers).is_some());
        headers.insert(header::COOKIE, format!("{SESSION_COOKIE}=short").parse().unwrap());
        assert!(token_hash(&headers).is_none());
    }
}
