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
    security::{
        Running, client_address, constant_time_eq, hmac_sha256, rate_exceeded, rate_limit, rate_record, rate_reserve,
        rate_running,
    },
};

/// The session cookie's name over plain http (local runs), and the name it had everywhere before it took the `__Host-`
/// prefix.
const SESSION_COOKIE: &str = "mogaesup_session";
/// Its name where cookies are Secure. A `__Host-` cookie is the site's own (Secure, Path=/, no Domain): another
/// subdomain cannot set one for it.
const HOST_SESSION_COOKIE: &str = "__Host-mogaesup_session";
/// A device that signed in to an account before (see [`known_device`]), by the same two names.
const DEVICE_COOKIE: &str = "mogaesup_device";
const HOST_DEVICE_COOKIE: &str = "__Host-mogaesup_device";
/// How long a device stays known after it last signed in (browsers keep a cookie 400 days at most).
const DEVICE_MAX_AGE_SECONDS: u32 = 365 * 24 * 60 * 60;
/// Signed-in devices one account keeps. A new sign-in past it ends the sessions used least recently.
pub const SESSIONS_PER_USER: i64 = 20;
/// A session lasts this long after it was made or last renewed, and so does its cookie (`SESSION_TERM` in SQL).
const SESSION_MAX_AGE_SECONDS: u32 = 30 * 24 * 60 * 60;
const SESSION_TERM: &str = "30 days";
/// A session in use is renewed once its expiry is closer than this, about a day after its last renewal: a device used
/// every few weeks stays signed in, and a row is written at most once a day however often the app opens.
const SESSION_RENEW_BELOW: &str = "29 days";
/// However often it is renewed, a session ends this long after the sign-in that made it: a stolen one cannot be kept.
const SESSION_LIFETIME: &str = "90 days";
/// Wrong passwords from one address, for one account, and from one device known to the account, in the rate window
/// (ten minutes).
const LOGIN_FAILURES_PER_ADDRESS: u32 = 30;
const LOGIN_FAILURES_PER_ACCOUNT: u32 = 50;
const LOGIN_FAILURES_PER_DEVICE: u32 = 10;
/// Wrong current passwords one session may send while changing the password, in the rate window.
const PASSWORD_FAILURES_PER_SESSION: u32 = 10;
/// Password checks for one account (or one known device, or one session) waiting or running at once: a burst for one
/// account cannot fill the hashing queue everyone signs in through.
pub const CHECKS_UNDER_WAY: u32 = 16;
/// How long a password check waits for a hashing slot: a burst of sign-ins is turned away instead of queueing forever.
const HASH_WAIT: Duration = Duration::from_secs(10);
/// How long a sign-in route may take in all.
const AUTH_DEADLINE: Duration = Duration::from_secs(30);
const BUSY: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "busy",
    "지금 로그인하는 사람이 많아요. 잠시 뒤에 다시 시도해 주세요.",
);
const INVALID_CREDENTIALS: ApiError =
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "아이디 또는 비밀번호가 올바르지 않습니다.");
/// A wrong current password when changing it. Not 401: the app reads that as a session that ended.
const WRONG_PASSWORD: ApiError =
    ApiError::new(StatusCode::BAD_REQUEST, "wrong_password", "현재 비밀번호가 올바르지 않습니다.");
const PASSWORD_CHANGED: ApiError = conflict("password_changed", "비밀번호가 방금 바뀌었습니다. 다시 시도해 주세요.");
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

/// The value of the request's cookie `name`.
fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookie| cookie.split(';'))
        .find_map(|item| item.trim().strip_prefix(name)?.strip_prefix('='))
}

/// A session token the request presents.
struct Presented<'a> {
    token: &'a str,
    /// It came under the cookie's old name where cookies are Secure, which only sessions made before the rename may
    /// use (`sessions.legacy_cookie`).
    legacy: bool,
}

/// The well-formed session token the request presents: from the `__Host-` cookie where cookies are Secure, else (and
/// while sessions made before the rename last) from the old name.
fn presented<'a>(state: &AppState, headers: &'a HeaderMap) -> Option<Presented<'a>> {
    if state.config.cookie_secure
        && let Some(token) = cookie(headers, HOST_SESSION_COOKIE)
    {
        return well_formed(token).then_some(Presented { token, legacy: false });
    }
    let token = cookie(headers, SESSION_COOKIE).filter(|token| well_formed(token))?;
    Some(Presented { token, legacy: state.config.cookie_secure })
}

fn well_formed(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// The signed-in account and its session's hash.
async fn signed_in(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<(User, String)>> {
    let Some(presented) = presented(state, headers) else { return Ok(None) };
    let hash = token_hash(presented.token);
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND (s.legacy_cookie OR NOT $2)"
    ))
    .bind(&hash)
    .bind(presented.legacy)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|row| (User::from_row(&row), hash)))
}

pub async fn optional_user(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<User>> {
    Ok(signed_in(state, headers).await?.map(|(user, _)| user))
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

/// Whether `password` could be anyone's: something, and no longer than a new one may be.
fn plausible_password(password: &str) -> bool {
    !password.is_empty() && password.chars().count() <= 128
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

/// [`verify_password`] in a hashing slot already held, which it gives back once the hash is checked.
async fn verify_in(permit: OwnedSemaphorePermit, hash: Option<String>, password: String) -> ApiResult<bool> {
    let right = check_hash(hash, password).await;
    drop(permit);
    right
}

/// Whether `password` matches `hash`, on a blocking thread; the caller holds a hashing slot.
async fn check_hash(hash: Option<String>, password: String) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || match hash {
        Some(hash) => PasswordHash::new(&hash)
            .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()),
        None => {
            let salt = SaltString::generate(&mut rand::rngs::OsRng);
            let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
            false
        }
    })
    .await
    .map_err(internal)
}

/// The budgets one password check runs under: wrong passwords from the request's address, and for `key` (the account,
/// a device known to it, or a session changing its password), in the rate window.
///
/// Only a password found wrong counts. A check still waiting or running holds nothing against anyone, so a burst of
/// them cannot shut the owner out before a single one was found wrong; at most [`CHECKS_UNDER_WAY`] of one key wait or
/// run at once, and the rest are turned away as busy. Each budget is looked at again once a hashing slot is held, and
/// checks run `HASHING_SLOTS` at a time, so a burst of wrong passwords passes a budget by that many at most. Many
/// people share one address (a school, a mobile carrier), so their checks under way never use up its budget either.
struct PasswordCheck {
    address: String,
    key: String,
    max: u32,
    _under_way: Running,
}

impl PasswordCheck {
    fn start(state: &AppState, headers: &HeaderMap, key: String, max: u32) -> ApiResult<Self> {
        let address = format!("login-failed-address:{}", client_address(headers));
        rate_exceeded(state, &address, LOGIN_FAILURES_PER_ADDRESS)?;
        rate_exceeded(state, &key, max)?;
        let under_way = rate_running(state, &key, CHECKS_UNDER_WAY)?.ok_or(BUSY)?;
        Ok(Self { address, key, max, _under_way: under_way })
    }

    /// Whether `password` matches `hash` (None for a name nobody has, which is never right). A wrong one counts
    /// against the address, and against the key when there is an account behind it: made-up names keep no window of
    /// their own, so they cannot crowd the rate table.
    async fn verify(self, state: &AppState, hash: Option<String>, password: String) -> ApiResult<bool> {
        let slot = hashing_slot(state).await?;
        rate_exceeded(state, &self.address, LOGIN_FAILURES_PER_ADDRESS)?;
        rate_exceeded(state, &self.key, self.max)?;
        let someone = hash.is_some();
        let right = check_hash(hash, password).await?;
        if !right {
            rate_record(state, self.address);
            if someone {
                rate_record(state, self.key);
            }
        }
        // The slot goes back only once the failure counts, so the next check waiting for it sees the budget spent.
        drop(slot);
        Ok(right)
    }
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

fn cookie_line(state: &AppState, name: &str, value: &str, max_age: u32) -> String {
    let secure = if state.config.cookie_secure { "; Secure" } else { "" };
    format!("{name}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")
}

fn add_cookie(response: &mut Response, line: &str) -> ApiResult<()> {
    response.headers_mut().append(header::SET_COOKIE, line.parse().map_err(internal)?);
    Ok(())
}

/// Puts `token` in the session cookie for `max_age` seconds (an empty token and 0 end it). Where cookies are Secure, the
/// cookie under its old name goes too when the request still carries it.
fn send_session(
    state: &AppState,
    headers: &HeaderMap,
    response: &mut Response,
    token: &str,
    max_age: u32,
) -> ApiResult<()> {
    let name = if state.config.cookie_secure { HOST_SESSION_COOKIE } else { SESSION_COOKIE };
    add_cookie(response, &cookie_line(state, name, token, max_age))?;
    if state.config.cookie_secure && cookie(headers, SESSION_COOKIE).is_some() {
        add_cookie(response, &cookie_line(state, SESSION_COOKIE, "", 0))?;
    }
    Ok(())
}

fn device_cookie_name(state: &AppState) -> &'static str {
    if state.config.cookie_secure { HOST_DEVICE_COOKIE } else { DEVICE_COOKIE }
}

/// The device cookie's value for device `id` and account `name`: the id and a signature binding it to that account.
fn device_value(state: &AppState, name: &str, id: &str) -> String {
    let signature = hmac_sha256(&state.config.ticket_secret, format!("login-device\0{name}\0{id}").as_bytes());
    format!("{id}.{}", hex::encode(signature))
}

/// The id of the device the request comes from, when it has signed in to `name` before: its wrong passwords count
/// against that device alone, so others guessing at the account cannot shut its owner out of the devices they use.
fn known_device(state: &AppState, headers: &HeaderMap, name: &str) -> Option<String> {
    let value = cookie(headers, device_cookie_name(state))?;
    let (id, _) = value.split_once('.')?;
    let well_formed = id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit());
    (well_formed && constant_time_eq(device_value(state, name, id).as_bytes(), value.as_bytes())).then(|| id.to_owned())
}

/// A new session for `user`, whose password was just checked against `verified`; `device` is the known device it
/// signed in from. A password changed since the check admits nobody.
async fn session(
    state: &AppState,
    headers: &HeaderMap,
    user: User,
    verified: &str,
    device: Option<String>,
    status: StatusCode,
) -> ApiResult<Response> {
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token = hex::encode(random);
    let mut tx = state.db.begin().await?;
    // Serialize admission and pruning for an account, including concurrent successful logins and password changes.
    let current: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if current.as_deref() != Some(verified) {
        return Err(INVALID_CREDENTIALS);
    }
    sqlx::query(&format!(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, legacy_cookie)
         VALUES ($1, $2, clock_timestamp(), clock_timestamp() + interval '{SESSION_TERM}', $3)"
    ))
    .bind(token_hash(&token))
    .bind(user.id)
    .bind(!state.config.cookie_secure)
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
    end_sockets(state, &expired);
    let body = with_permissions(state, &user).await?;
    let mut response = (status, Json(json!({"user": body}))).into_response();
    send_session(state, headers, &mut response, &token, SESSION_MAX_AGE_SECONDS)?;
    let device = device.unwrap_or_else(|| {
        let mut id = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut id);
        hex::encode(id)
    });
    let value = device_value(state, &user.username, &device);
    add_cookie(&mut response, &cookie_line(state, device_cookie_name(state), &value, DEVICE_MAX_AGE_SECONDS))?;
    Ok(response)
}

/// Closes the realtime room and game sockets that rode on the sessions with these hashes.
fn end_sockets(state: &AppState, hashes: &[String]) {
    for hash in hashes {
        state.rooms.end_session(hash);
        state.games.end_session(hash);
    }
}

/// Ends every session of `user` but `keep` (a session hash), and the realtime sockets that rode on them; how many.
async fn end_other_sessions(state: &AppState, user: Uuid, keep: &str) -> ApiResult<usize> {
    let ended: Vec<String> =
        sqlx::query_scalar("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING token_hash")
            .bind(user)
            .bind(keep)
            .fetch_all(&state.db)
            .await?;
    end_sockets(state, &ended);
    Ok(ended.len())
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
    session(&state, &headers, user, &hash, None, StatusCode::CREATED).await
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let name = username(&body.username)?;
    if !plausible_password(&body.password) {
        return Err(bad("invalid_password", "비밀번호를 확인해 주세요."));
    }
    // Only wrong passwords count, per address and per account (see `PasswordCheck`); a limit shared by everyone would
    // let one client lock all players out. A device that signed in to the account before has a budget of its own.
    let device = known_device(&state, &headers, &name);
    let (key, max) = match &device {
        Some(id) => (format!("login-failed-device:{id}"), LOGIN_FAILURES_PER_DEVICE),
        None => (format!("login-failed:{name}"), LOGIN_FAILURES_PER_ACCOUNT),
    };
    let check = PasswordCheck::start(&state, &headers, key, max)?;
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, u.password_hash FROM users u WHERE u.username = $1"
    ))
    .bind(&name)
    .fetch_optional(&state.db)
    .await?;
    let hash = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    if !check.verify(&state, hash.clone(), body.password).await? {
        return Err(INVALID_CREDENTIALS);
    }
    let (Some(row), Some(hash)) = (row, hash) else { return Err(INVALID_CREDENTIALS) };
    session(&state, &headers, User::from_row(&row), &hash, device, StatusCode::OK).await
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(presented) = presented(&state, &headers) {
        let hash = token_hash(presented.token);
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(&hash).execute(&state.db).await?;
        end_sockets(&state, &[hash]);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    send_session(&state, &headers, &mut response, "", 0)?;
    Ok(response)
}

/// `POST /api/auth/logout-others`: ends every other session of the signed-in account (other devices and browsers) and
/// closes their realtime sockets; this one stays. Answers `{"ended": <sessions ended>}`.
pub async fn logout_others(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let (user, session) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    let ended = end_other_sessions(&state, user.id, &session).await?;
    Ok(Json(json!({"ended": ended})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

/// `POST /api/auth/password` with `{currentPassword, newPassword}`: the signed-in account's new password, once the
/// current one is checked. Every other session of the account ends with its realtime sockets; this one stays. 204.
/// A wrong current password counts against this session and the address, not the account, so a stolen session cannot
/// shut the owner out of signing in.
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PasswordChange>,
) -> ApiResult<StatusCode> {
    let (user, session) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    if !plausible_password(&body.current_password) {
        return Err(WRONG_PASSWORD);
    }
    new_password(&body.new_password)?;
    let check = PasswordCheck::start(
        &state,
        &headers,
        format!("login-failed-session:{session}"),
        PASSWORD_FAILURES_PER_SESSION,
    )?;
    let current: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(user.id).fetch_one(&state.db).await?;
    if !check.verify(&state, Some(current.clone()), body.current_password).await? {
        return Err(WRONG_PASSWORD);
    }
    let hash = hash_password(&state, body.new_password).await?;
    let mut tx = state.db.begin().await?;
    // Only over the password just checked: of two changes at once, the second finds it gone.
    let changed = sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3")
        .bind(user.id)
        .bind(&hash)
        .bind(&current)
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(PASSWORD_CHANGED);
    }
    let ended: Vec<String> =
        sqlx::query_scalar("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING token_hash")
            .bind(user.id)
            .bind(&session)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    end_sockets(&state, &ended);
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/auth/me`, which the app asks each time it opens: who is signed in. A session whose expiry has come closer
/// than [`SESSION_RENEW_BELOW`] is renewed to a full term here (never past [`SESSION_LIFETIME`] from its sign-in), and
/// its cookie sent again with the new Max-Age, so a device in use stays signed in. A session presented under the
/// cookie's old name is sent again under the new one. Other reads of the session ([`optional_user`]) only read it.
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let nobody = || Json(json!({"user": null})).into_response();
    let Some(presented) = presented(&state, &headers) else { return Ok(nobody()) };
    let hash = token_hash(presented.token);
    // One statement: the renewal sees the row the read finds, and a renewal already made (another tab, a moment ago)
    // leaves the expiry too far off to match again.
    let row = sqlx::query(&format!(
        "WITH renewed AS (
           UPDATE sessions
           SET expires_at = least(clock_timestamp() + interval '{SESSION_TERM}', created_at + interval '{SESSION_LIFETIME}')
           WHERE token_hash = $1 AND expires_at > now() AND (legacy_cookie OR NOT $2)
             AND expires_at < now() + interval '{SESSION_RENEW_BELOW}'
             AND expires_at < created_at + interval '{SESSION_LIFETIME}'
           RETURNING expires_at)
         SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, EXISTS (SELECT 1 FROM renewed) AS renewed,
           floor(extract(epoch FROM coalesce((SELECT expires_at FROM renewed), s.expires_at) - now()))::int8 AS seconds_left
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND (s.legacy_cookie OR NOT $2)"
    ))
    .bind(&hash)
    .bind(presented.legacy)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(nobody()) };
    let user = with_permissions(&state, &User::from_row(&row)).await?;
    let mut response = Json(json!({"user": user})).into_response();
    if presented.legacy {
        // Moved to the new name: the old one no longer carries this session.
        sqlx::query("UPDATE sessions SET legacy_cookie = false WHERE token_hash = $1")
            .bind(&hash)
            .execute(&state.db)
            .await?;
    }
    if row.get::<bool, _>("renewed") || presented.legacy {
        let seconds = row.get::<i64, _>("seconds_left").clamp(0, i64::from(SESSION_MAX_AGE_SECONDS));
        send_session(&state, &headers, &mut response, presented.token, seconds as u32)?;
    }
    Ok(response)
}

pub async fn realtime_ticket(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let (user, hash) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    // A page asks for one when its room connects and again each time the connection drops (checked every second, with
    // waits that double up to 30 seconds), so several tabs or a reconnect loop still fit.
    rate_limit(&state, format!("realtime-ticket:{}", user.id), 90)?;
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
    fn session_cookies_are_read_by_their_exact_name_and_need_a_well_formed_token() {
        let token = "a".repeat(64);
        let mut headers = HeaderMap::new();
        headers
            .insert(header::COOKIE, format!("x=1; {HOST_SESSION_COOKIE}=b; {SESSION_COOKIE}={token}").parse().unwrap());
        assert_eq!(cookie(&headers, SESSION_COOKIE), Some(token.as_str()));
        assert_eq!(cookie(&headers, HOST_SESSION_COOKIE), Some("b"));
        assert_eq!(cookie(&headers, "mogaesup"), None);
        assert!(well_formed(&token));
        assert!(!well_formed("short") && !well_formed(&"g".repeat(64)));
    }
}
