use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::time::Duration;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult, LOGIN_REQUIRED, bad, conflict, forbidden, internal},
    rebac::{self, Actor, Checker, PERMISSIONS, Permission, ROLE_COLUMN, Subject, Tuple},
    security::{client_address, rate_exceeded, rate_limit, rate_record},
};

const SESSION_COOKIE: &str = "mogaesup_session";
const SESSIONS_PER_USER: i64 = 8;
const SESSION_MAX_AGE_SECONDS: u32 = 30 * 24 * 60 * 60;

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

/// The session token's hash, from a well-formed session cookie.
fn token_hash(headers: &HeaderMap) -> Option<String> {
    let prefix = format!("{SESSION_COOKIE}=");
    let token = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookie| cookie.split(';'))
        .find_map(|item| item.trim().strip_prefix(prefix.as_str()))?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex::encode(Sha256::digest(token.as_bytes())))
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

async fn hash_password(state: &AppState, password: String) -> ApiResult<String> {
    let permit = state.hashing.clone().acquire_owned().await.map_err(internal)?;
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
    let permit = state.hashing.clone().acquire_owned().await.map_err(internal)?;
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
async fn create_account(db: &PgPool, user: &User, password_hash: &str) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;
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
    sqlx::query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)")
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(user.id)
        .execute(&state.db)
        .await?;
    // Bound stolen or forgotten sessions per account; every token gets the same TTL, so expiry is insertion order.
    sqlx::query(
        "DELETE FROM sessions WHERE token_hash IN
         (SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY expires_at DESC OFFSET $2)",
    )
    .bind(user.id)
    .bind(SESSIONS_PER_USER)
    .execute(&state.db)
    .await?;
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
    // Attempts are limited per address; the site-wide cap counts only created accounts, so rejected requests cannot
    // close sign-up for everyone.
    rate_limit(&state, format!("register-address:{}", client_address(&headers)), 20)?;
    rate_limit(&state, format!("register:{name}"), 5)?;
    rate_exceeded(&state, "register-created", 600)?;
    let hash = hash_password(&state, body.password).await?;
    let user = User { id: Uuid::new_v4(), username: name, display_name: display, role: "user".into() };
    if !create_account(&state.db, &user, &hash).await? {
        return Err(conflict("username_taken", "이미 사용 중인 아이디입니다."));
    }
    rate_record(&state, "register-created".into());
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
    // all players out.
    let address_key = format!("login-failed-address:{}", client_address(&headers));
    let user_key = format!("login-failed:{name}");
    rate_exceeded(&state, &address_key, 30)?;
    rate_exceeded(&state, &user_key, 50)?;
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, u.password_hash FROM users u WHERE u.username = $1"
    ))
    .bind(&name)
    .fetch_optional(&state.db)
    .await?;
    let hash = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    if !verify_password(&state, hash, body.password).await? {
        rate_record(&state, address_key);
        rate_record(&state, user_key);
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
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(hash).execute(&state.db).await?;
    }
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, session_cookie(&state, "", 0))]).into_response())
}

pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = match optional_user(&state, &headers).await? {
        Some(user) => with_permissions(&state, &user).await?,
        None => Value::Null,
    };
    Ok(Json(json!({"user": user})))
}

pub async fn realtime_ticket(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    // Each tab renews about every 40 seconds and again on every reconnect, so two tabs or a reconnect loop still fit.
    rate_limit(&state, format!("realtime-ticket:{}", user.id), 90)?;
    let (ticket, expires_at) = crate::rooms::issue_ticket(&state.config.ticket_secret, &user);
    Ok(Json(json!({"ticket": ticket, "expiresAt": expires_at, "user": user})))
}

async fn user_id(db: &PgPool, name: &str) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM users WHERE username = $1").bind(name).fetch_optional(db).await
}

/// Creates the configured operator, or takes the existing account of that name (keeping its password), and grants it
/// `system:mogaesup#admin`, so a fresh deployment has an admin.
pub async fn bootstrap_admin(state: &AppState, username_raw: &str, password: &str) -> anyhow::Result<()> {
    let name = username(username_raw)?;
    let id = match user_id(&state.db, &name).await? {
        Some(id) => id,
        None => {
            new_password(password)?;
            let hash = hash_password(state, password.to_owned()).await?;
            let user =
                User { id: Uuid::new_v4(), username: name.clone(), display_name: name.clone(), role: "user".into() };
            if create_account(&state.db, &user, &hash).await? {
                user.id
            } else {
                // Someone signed up with that name in the meantime.
                user_id(&state.db, &name).await?.ok_or_else(|| anyhow::anyhow!("bootstrap admin account vanished"))?
            }
        }
    };
    let granted =
        rebac::grant(&state.db, &Tuple::admin(id), Actor::server("bootstrap"), "BOOTSTRAP_ADMIN_USERNAME").await?;
    if granted {
        tracing::warn!(username = %name, "Bootstrap admin granted");
    }
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
