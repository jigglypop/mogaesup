use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    extract::{Extension, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row, postgres::PgRow};
use std::time::Duration;
use tokio::sync::OwnedSemaphorePermit;
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, UnicodeEmoji, UnicodeGeneralCategory};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult, LOGIN_REQUIRED, bad, conflict, forbidden, internal},
    rebac::{self, Actor, Checker, PERMISSIONS, Permission, ROLE_COLUMN, Subject, Tuple},
    security::{
        Running, client_address, constant_time_eq, hmac_sha256, plain_text, rate_exceeded, rate_limit, rate_record,
        rate_record_in, rate_reserve, rate_running,
    },
};

/// The session cookie's name over plain http (local runs), and the name it had everywhere before it took the `__Host-`
/// prefix.
const SESSION_COOKIE: &str = "mogaesup_session";
/// Its name where cookies are Secure. A `__Host-` cookie is the site's own (Secure, Path=/, no Domain): another
/// subdomain cannot set one for it.
const HOST_SESSION_COOKIE: &str = "__Host-mogaesup_session";
/// A device that signed in to an account before (see [`signed_device`]), by the same two names.
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
/// How long a session started over still works ([`start_over`]): requests already on their way with its cookie, and the
/// browser's other tabs, pass while the answer brings the new cookie.
const REPLACED_GRACE: &str = "90 seconds";
/// How long after starting over the realtime sockets of the replaced session close: its answer, with the new cookie, is
/// in by then, and the page connects again under it (under the old one, until its grace ends, when the answer was lost).
const SOCKETS_GRACE: Duration = Duration::from_secs(3);
/// Wrong passwords from one address, for one account, from one device known to the account, and from all of its known
/// devices together, in the rate window (ten minutes). Of the account's budget, sign-ins from devices it does not know
/// spend at most `LOGIN_FAILURES_PER_ACCOUNT_ADDRESS` from one address, so a few addresses cannot shut its owner out of a
/// new device.
const LOGIN_FAILURES_PER_ADDRESS: u32 = 30;
const LOGIN_FAILURES_PER_ACCOUNT: u32 = 50;
const LOGIN_FAILURES_PER_ACCOUNT_ADDRESS: u32 = 10;
const LOGIN_FAILURES_PER_DEVICE: u32 = 10;
const LOGIN_FAILURES_PER_KNOWN_DEVICES: u32 = 30;
/// Devices one account keeps known (see `signed_device`). Signing in from another forgets the one used least recently.
pub const DEVICES_PER_USER: i64 = 10;
/// Wrong current passwords one sign-in may send (changing the password, signing out the other devices), in the rate
/// window: all the sessions it started over count together, so signing the other devices out does not hand it new
/// guesses.
const PASSWORD_FAILURES_PER_SIGN_IN: u32 = 10;
/// Signing the other devices out and changing the password, done per account in the rate window. Only one done counts:
/// someone holding a session but not the password cannot keep the owner from doing either.
pub const LOGOUT_OTHERS_PER_USER: u32 = 10;
pub const PASSWORD_CHANGES_PER_USER: u32 = 5;
/// Password checks for one account (or one known device, or one sign-in) waiting or running at once: a burst for one
/// account cannot fill the hashing queue everyone signs in through.
pub const CHECKS_UNDER_WAY: u32 = 16;
/// Password checks for names nobody has waiting or running at once, from one address and in all. Their throwaway hash
/// takes a hashing slot like any check; usernames are public (every island is at `/@name`), so turning a crowd of
/// them away as busy tells nobody anything, and a flood of made-up names cannot fill the queue members sign in through.
pub const UNKNOWN_CHECKS_PER_ADDRESS: u32 = 1;
pub const UNKNOWN_CHECKS_SITE: u32 = 2;
/// How long a password check waits for a hashing slot: a burst of sign-ins is turned away instead of queueing forever.
/// A password change waits twice (the current one checked, the new one hashed), within [`AUTH_DEADLINE`].
const HASH_WAIT: Duration = Duration::from_secs(10);
/// How long a sign-in route may take in all: under the API's own deadline (`REQUEST_DEADLINE`), so it answers busy
/// before that cuts it off.
const AUTH_DEADLINE: Duration = Duration::from_secs(24);
/// A sign-up that made its account stops signing it in this long before its [`Deadline`], to say the account is made
/// instead of being cut off as busy. The app waits about as long as the deadline, so the answer leaves in time to reach
/// it.
const SIGNED_UP_MARGIN: Duration = Duration::from_secs(2);
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
/// Names that read as the site's own staff, as letters and digits in lower case. New accounts take none as a username,
/// nor as a display name in any width, case or spacing (see [`reads_as_staff`]); existing accounts keep theirs.
/// Usernames are ASCII, so the Korean ones guard display names.
const RESERVED_NAMES: [&str; 10] =
    ["admin", "administrator", "mogaesup", "root", "system", "support", "staff", "운영자", "관리자", "모개숲"];
const USERNAME_TAKEN: ApiError = conflict("username_taken", "이미 사용 중인 아이디입니다.");
pub(crate) const STAFF_NAME: ApiError = bad("reserved_name", "운영진처럼 보이는 이름은 쓸 수 없어요.");
const HIDDEN_IN_NAME: ApiError = bad("invalid_name", "이름에 쓸 수 없는 문자가 들어 있어요.");
/// Sign-up made the account but could not sign it in.
const SIGNED_UP: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "signed_up",
    "가입은 끝났어요. 같은 아이디와 비밀번호로 로그인해 주세요.",
);
/// Hangul fillers: letters that draw nothing.
const HANGUL_FILLERS: [char; 4] = ['\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}'];

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

/// The session a request is signed in with.
struct Session {
    /// The token's hash, as `sessions` keeps it.
    hash: String,
    /// When the sign-in it belongs to was: a session started over keeps its sign-in's (see [`start_over`]).
    signed_in_at: DateTime<Utc>,
    /// It was started over and lives out its grace ([`REPLACED_GRACE`]): it works, but starts nothing over again.
    replaced: bool,
}

impl Session {
    /// The wrong-password budget of a password change: the sign-in's, which every session it started over shares.
    fn password_budget(&self, user: &User) -> String {
        format!("login-failed-sign-in:{}:{}", user.id, self.signed_in_at.timestamp_micros())
    }
}

/// The signed-in account and its session.
async fn signed_in(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<(User, Session)>> {
    let Some(presented) = presented(state, headers) else { return Ok(None) };
    let hash = token_hash(presented.token);
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, s.created_at, s.replaced_at IS NOT NULL AS replaced
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND (s.legacy_cookie OR NOT $2)
           AND s.created_at > now() - interval '{SESSION_LIFETIME}'"
    ))
    .bind(&hash)
    .bind(presented.legacy)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|row| {
        let session = Session { hash, signed_in_at: row.get("created_at"), replaced: row.get("replaced") };
        (User::from_row(&row), session)
    }))
}

pub async fn optional_user(state: &AppState, headers: &HeaderMap) -> ApiResult<Option<User>> {
    Ok(signed_in(state, headers).await?.map(|(user, _)| user))
}

pub async fn current_user(state: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    optional_user(state, headers).await?.ok_or(LOGIN_REQUIRED)
}

pub(crate) async fn active_session(state: &AppState, hash: &str, user: Uuid) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND expires_at > now()
         AND created_at > now() - interval '{SESSION_LIFETIME}')"
    ))
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

/// Whether a display name reads as one of [`RESERVED_NAMES`]: the same letters and digits once their width and form
/// are made one (NFKC) and their case too, whatever spaces, marks, symbols or invisible joiners come between them.
pub(crate) fn reads_as_staff(name: &str) -> bool {
    let letters: String = name.nfkc().flat_map(char::to_lowercase).filter(|c| c.is_alphanumeric()).collect();
    RESERVED_NAMES.contains(&letters.as_str())
}

/// The name a new account shows others, as it is kept: what was typed, trimmed (the username when nothing was).
/// Refused when it is too long, does not read as it was written ([`plain_text`]), reads as the site's staff
/// ([`reads_as_staff`]), or holds a character that draws nothing outside an emoji ([`hides_something`]).
pub(crate) fn display_name(raw: Option<&str>, fallback: &str) -> ApiResult<String> {
    let name = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or(fallback).to_owned();
    if name.chars().count() > 20 {
        return Err(bad("invalid_name", "이름은 20자 이하로 입력해 주세요."));
    }
    if !plain_text(&name, false) {
        return Err(HIDDEN_IN_NAME);
    }
    if reads_as_staff(&name) {
        return Err(STAFF_NAME);
    }
    if hides_something(&name) {
        return Err(HIDDEN_IN_NAME);
    }
    Ok(name)
}

/// A character that draws nothing, or changes how others are drawn or read: format characters (direction overrides and
/// marks, joiners, word joiners, tags), variation selectors, Hangul fillers, the combining grapheme joiner, Khmer's
/// inherent vowels and the blank braille pattern.
fn invisible(c: char) -> bool {
    c.general_category() == GeneralCategory::Format
        || HANGUL_FILLERS.contains(&c)
        || matches!(
            c,
            '\u{fe00}'..='\u{fe0f}'
                | '\u{e0100}'..='\u{e01ef}'
                | '\u{180b}'..='\u{180d}'
                | '\u{180f}'
                | '\u{34f}'
                | '\u{17b4}'
                | '\u{17b5}'
                | '\u{2800}'
        )
}

/// Whether `name` holds an [`invisible`] character outside an emoji sequence. Emoji keep the ones they are made of (the
/// variation selector of ❤️, the joiners of 👩‍💻, a flag's tags), each right after an emoji or another of its parts;
/// anywhere else one could hide, reorder or fake what the name shows (자영운 after a right-to-left override reads as
/// 운영자).
fn hides_something(name: &str) -> bool {
    let mut previous: Option<char> = None;
    for c in name.chars() {
        let in_emoji = emoji_part(c) && previous.is_some_and(|p| p.is_emoji_char() || emoji_part(p));
        if invisible(c) && !in_emoji {
            return true;
        }
        previous = Some(c);
    }
    false
}

/// The [`invisible`] characters emoji are made of: the zero-width joiner, the text and emoji variation selectors, and
/// a flag's tags.
fn emoji_part(c: char) -> bool {
    matches!(c, '\u{200d}' | '\u{fe0e}' | '\u{fe0f}' | '\u{e0020}'..='\u{e007f}')
}

/// `name` as it is compared with the usernames the server reserved (`auth_reserved_usernames`): in NFKC (full-width
/// letters and decomposed Hangul read as their plain forms), lowercase, without spaces or the invisible characters
/// emoji may keep.
fn name_key(name: &str) -> String {
    name.nfkc().filter(|c| !c.is_whitespace() && !invisible(*c)).flat_map(char::to_lowercase).collect()
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

/// When a sign-in route is cut off (see [`deadline`]).
#[derive(Clone, Copy)]
pub struct Deadline(tokio::time::Instant);

/// The sign-in routes answer within [`AUTH_DEADLINE`], whatever they wait for. A route that has to answer on its own
/// before then reads when that is from its [`Deadline`].
pub async fn deadline(mut request: Request, next: Next) -> Response {
    let by = tokio::time::Instant::now() + AUTH_DEADLINE;
    request.extensions_mut().insert(Deadline(by));
    tokio::time::timeout_at(by, next.run(request)).await.unwrap_or_else(|_| BUSY.into_response())
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

/// Checks against `hash`, or spends the same work on a throwaway hash so unknown usernames take as long. The hashing
/// slot is held on the blocking thread until the hash is checked, even when the request is given up meanwhile.
async fn verify_password(state: &AppState, hash: Option<String>, password: String) -> ApiResult<bool> {
    let slot = hashing_slot(state).await?;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        matches(hash, &password)
    })
    .await
    .map_err(internal)
}

/// Whether `password` matches `hash`; None never matches, after the same work. For a blocking thread holding a hashing
/// slot.
fn matches(hash: Option<String>, password: &str) -> bool {
    match hash {
        Some(hash) => PasswordHash::new(&hash)
            .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()),
        None => {
            let salt = SaltString::generate(&mut rand::rngs::OsRng);
            let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
            false
        }
    }
}

/// The wrong-password budget of the request's address.
fn address_key(headers: &HeaderMap) -> String {
    format!("login-failed-address:{}", client_address(headers))
}

/// The budgets one password check runs under: wrong passwords from the request's address, and for each of `keys` (the
/// account and the part of it the address may spend; or a device known to it and all of its known devices together; or
/// a sign-in confirming its password), in the rate window.
///
/// Only a password found wrong counts. A check still waiting or running holds nothing against anyone, so a burst of
/// them cannot shut the owner out before a single one was found wrong; at most [`CHECKS_UNDER_WAY`] of one key wait or
/// run at once, and the rest are turned away as busy. Each budget is looked at again once a hashing slot is held, and
/// checks run `HASHING_SLOTS` at a time, so a burst of wrong passwords passes a budget by that many at most. Many
/// people share one address (a school, a mobile carrier), so their checks under way never use up its budget either.
struct PasswordCheck {
    address: String,
    keys: Vec<(String, u32)>,
    under_way: Vec<Running>,
}

impl PasswordCheck {
    /// A check of an account's password, under `keys`.
    fn start(state: &AppState, headers: &HeaderMap, keys: Vec<(String, u32)>) -> ApiResult<Self> {
        let places = keys.iter().map(|(key, _)| (key.clone(), CHECKS_UNDER_WAY)).collect();
        Self::begin(state, headers, keys, places)
    }

    /// A check for a name nobody has: it keeps no budget of its own (made-up names cannot crowd the rate table), and
    /// takes one of the few places such checks have, from its address and in all ([`UNKNOWN_CHECKS_SITE`]).
    fn start_unknown(state: &AppState, headers: &HeaderMap) -> ApiResult<Self> {
        let places = vec![
            (format!("login-unknown:{}", client_address(headers)), UNKNOWN_CHECKS_PER_ADDRESS),
            ("login-unknown".to_owned(), UNKNOWN_CHECKS_SITE),
        ];
        Self::begin(state, headers, Vec::new(), places)
    }

    /// Refused when a budget is spent, or busy when one of `places` (a key and how many may wait or run under it at
    /// once) is full.
    fn begin(
        state: &AppState,
        headers: &HeaderMap,
        keys: Vec<(String, u32)>,
        places: Vec<(String, u32)>,
    ) -> ApiResult<Self> {
        let address = address_key(headers);
        rate_exceeded(state, &address, LOGIN_FAILURES_PER_ADDRESS)?;
        for (key, max) in &keys {
            rate_exceeded(state, key, *max)?;
        }
        let mut under_way = Vec::with_capacity(places.len());
        for (key, max) in &places {
            under_way.push(rate_running(state, key, *max)?.ok_or(BUSY)?);
        }
        Ok(Self { address, keys, under_way })
    }

    /// Whether `password` matches `hash` (None for a name nobody has, which is never right). A wrong one counts
    /// against the address, and against the keys when there is an account behind them: made-up names keep no window
    /// of their own, so they cannot crowd the rate table.
    ///
    /// Once a hashing slot is held, the rest runs to its end on a blocking thread whether or not the request is still
    /// waiting for it: the hash is checked, a wrong password counts, and only then does the slot go back, so the next
    /// check waiting for it sees the budget spent and a request given up never frees a slot argon2 still uses.
    async fn verify(self, state: &AppState, hash: Option<String>, password: String) -> ApiResult<bool> {
        let slot = hashing_slot(state).await?;
        rate_exceeded(state, &self.address, LOGIN_FAILURES_PER_ADDRESS)?;
        for (key, max) in &self.keys {
            rate_exceeded(state, key, *max)?;
        }
        let Self { address, keys, under_way } = self;
        let table = state.attempts.clone();
        tokio::task::spawn_blocking(move || {
            let someone = hash.is_some();
            let right = matches(hash, &password);
            if !right {
                rate_record_in(&table, address);
                if someone {
                    for (key, _) in keys {
                        rate_record_in(&table, key);
                    }
                }
            }
            drop(slot);
            drop(under_way);
            right
        })
        .await
        .map_err(internal)
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

/// The id in the request's device cookie when it is signed for account `name`. The device is known to the account
/// while `login_devices` holds it: it was signed in from, recently enough to be among the account's
/// [`DEVICES_PER_USER`], and not since the password changed (a cookie given before devices were recorded counts until
/// then, see [`login`]). A known device's wrong passwords count against that device (and the account's known devices
/// together), not the account, so others guessing at the account cannot shut its owner out of the devices they use.
fn signed_device(state: &AppState, headers: &HeaderMap, name: &str) -> Option<String> {
    let value = cookie(headers, device_cookie_name(state))?;
    let (id, _) = value.split_once('.')?;
    let well_formed = id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit());
    (well_formed && constant_time_eq(device_value(state, name, id).as_bytes(), value.as_bytes())).then(|| id.to_owned())
}

/// 32 random bytes in hex: a session token.
fn new_token() -> String {
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    hex::encode(random)
}

/// 16 random bytes in hex: a device's id.
fn new_device() -> String {
    let mut id = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut id);
    hex::encode(id)
}

/// Puts the device cookie for `device` and account `name` on `response`.
fn send_device(state: &AppState, response: &mut Response, name: &str, device: &str) -> ApiResult<()> {
    let value = device_value(state, name, device);
    add_cookie(response, &cookie_line(state, device_cookie_name(state), &value, DEVICE_MAX_AGE_SECONDS))
}

/// Opens a session for `user` under `token`, for a full term: one made by the sign-in at `signed_in` (now unless
/// given), never past [`SESSION_LIFETIME`] from it. The seconds it has.
async fn open_session(
    connection: &mut PgConnection,
    state: &AppState,
    user: Uuid,
    token: &str,
    signed_in: Option<DateTime<Utc>>,
) -> Result<u32, sqlx::Error> {
    let seconds: i64 = sqlx::query_scalar(&format!(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, legacy_cookie)
         SELECT $1, $2, at, least(clock_timestamp() + interval '{SESSION_TERM}', at + interval '{SESSION_LIFETIME}'), $3
         FROM (SELECT coalesce($4, clock_timestamp()) AS at) signed_in
         RETURNING floor(extract(epoch FROM expires_at - now()))::int8"
    ))
    .bind(token_hash(token))
    .bind(user)
    .bind(!state.config.cookie_secure)
    .bind(signed_in)
    .fetch_one(connection)
    .await?;
    Ok(seconds.clamp(0, i64::from(SESSION_MAX_AGE_SECONDS)) as u32)
}

/// Marks `device` as one `user` signed in from, and forgets the account's devices past [`DEVICES_PER_USER`], the ones
/// used least recently first.
async fn remember_device(connection: &mut PgConnection, user: Uuid, device: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO login_devices (user_id, device_id, seen_at) VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (user_id, device_id) DO UPDATE SET seen_at = excluded.seen_at",
    )
    .bind(user)
    .bind(device)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "DELETE FROM login_devices WHERE user_id = $1 AND device_id IN
         (SELECT device_id FROM login_devices WHERE user_id = $1 ORDER BY seen_at DESC, device_id DESC OFFSET $2)",
    )
    .bind(user)
    .bind(DEVICES_PER_USER)
    .execute(connection)
    .await?;
    Ok(())
}

/// A new session for `user`, whose password was just checked against `verified`; `device` is the id the device's
/// cookie carries for the account, which becomes known to it. A password changed since the check admits nobody.
async fn session(
    state: &AppState,
    headers: &HeaderMap,
    user: User,
    verified: &str,
    device: Option<String>,
    status: StatusCode,
) -> ApiResult<Response> {
    // Read before the session is made, so the commit is the last thing waited for: a failure or the deadline cannot leave
    // a session whose cookie no browser got, which would also have ended another device's session to make room.
    let body = json!({"user": with_permissions(state, &user).await?});
    let token = new_token();
    let device = device.unwrap_or_else(new_device);
    let mut tx = state.db.begin().await?;
    // Serialize admission and pruning for an account, including concurrent successful logins and password changes.
    let current: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if current.as_deref() != Some(verified) {
        return Err(INVALID_CREDENTIALS);
    }
    open_session(&mut tx, state, user.id, &token, None).await?;
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
    remember_device(&mut tx, user.id, &device).await?;
    tx.commit().await?;
    end_sockets(state, &expired);
    let mut response = (status, Json(body)).into_response();
    send_session(state, headers, &mut response, &token, SESSION_MAX_AGE_SECONDS)?;
    send_device(state, &mut response, &user.username, &device)?;
    Ok(response)
}

/// Closes the realtime room and game sockets that rode on the sessions with these hashes.
fn end_sockets(state: &AppState, hashes: &[String]) {
    for hash in hashes {
        state.rooms.end_session(hash);
        state.games.end_session(hash);
    }
}

/// A session started over ([`start_over`]): the hashes of the account's other sessions, which it ended, how many of
/// them were other devices' (not this browser's own, replaced a moment ago), and how long the new one lasts.
struct StartedOver {
    ended: Vec<String>,
    others: usize,
    seconds: u32,
}

/// Starts `user` over from the session `current` (a hash): every other session of the account ends, and `token` opens
/// in this one's place, so a copy of this browser's cookie taken earlier stops working too. `current` itself is kept
/// for [`REPLACED_GRACE`], replaced: requests already sent with its cookie, and this browser's other tabs, pass until
/// the answer brings the new one, but it starts nothing over again; its sign-in time moves back to make its lifetime
/// end with the grace, so not even a release from before `replaced_at` renews it. The new session belongs to the same
/// sign-in and ends when the old one would have at the latest ([`SESSION_LIFETIME`]), so starting over cannot keep a
/// session going. With `device` (a password change), every device of the account but that one is forgotten; signing
/// the other devices out leaves the devices as they are. Refused (LOGIN_REQUIRED) when `current` had already ended or
/// been replaced, so a session signed out meanwhile is not opened again. The caller holds the account's row.
async fn start_over(
    connection: &mut PgConnection,
    state: &AppState,
    user: Uuid,
    current: &str,
    token: &str,
    device: Option<&str>,
) -> ApiResult<StartedOver> {
    let signed_in: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT created_at FROM sessions
         WHERE token_hash = $1 AND user_id = $2 AND expires_at > now() AND replaced_at IS NULL",
    )
    .bind(current)
    .bind(user)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(signed_in) = signed_in else { return Err(LOGIN_REQUIRED) };
    let ended: Vec<(String, bool)> = sqlx::query_as(
        "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2
         RETURNING token_hash, replaced_at IS NULL AS other",
    )
    .bind(user)
    .bind(current)
    .fetch_all(&mut *connection)
    .await?;
    let others = ended.iter().filter(|(_, other)| *other).count();
    let ended = ended.into_iter().map(|(hash, _)| hash).collect();
    sqlx::query(&format!(
        "UPDATE sessions SET replaced_at = clock_timestamp(),
           expires_at = least(expires_at, clock_timestamp() + interval '{REPLACED_GRACE}'),
           created_at = least(expires_at, clock_timestamp() + interval '{REPLACED_GRACE}') - interval '{SESSION_LIFETIME}'
         WHERE token_hash = $1"
    ))
    .bind(current)
    .execute(&mut *connection)
    .await?;
    let seconds = open_session(connection, state, user, token, Some(signed_in)).await?;
    if let Some(device) = device {
        sqlx::query("DELETE FROM login_devices WHERE user_id = $1 AND device_id <> $2")
            .bind(user)
            .bind(device)
            .execute(&mut *connection)
            .await?;
        sqlx::query("UPDATE users SET devices_reset_at = clock_timestamp() WHERE id = $1")
            .bind(user)
            .execute(&mut *connection)
            .await?;
        remember_device(connection, user, device).await?;
    }
    Ok(StartedOver { ended, others, seconds })
}

/// Once a session was started over: the sockets of the other sessions it ended close now, those of the replaced one
/// (`current`) a moment later ([`SOCKETS_GRACE`]), once its answer is in.
fn close_started_over(state: &AppState, ended: &[String], current: String) {
    end_sockets(state, ended);
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(SOCKETS_GRACE).await;
        end_sockets(&state, &[current]);
    });
}

/// The answer that carries a session started over ([`start_over`]): its new cookie, and the device's when one was
/// kept.
fn started_over(
    state: &AppState,
    headers: &HeaderMap,
    mut response: Response,
    user: &User,
    token: &str,
    seconds: u32,
    device: Option<&str>,
) -> ApiResult<Response> {
    send_session(state, headers, &mut response, token, seconds)?;
    if let Some(device) = device {
        send_device(state, &mut response, &user.username, device)?;
    }
    Ok(response)
}

pub async fn register(
    State(state): State<AppState>,
    Extension(Deadline(by)): Extension<Deadline>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> ApiResult<Response> {
    let name = username(&body.username)?;
    new_password(&body.password)?;
    if RESERVED_NAMES.iter().any(|reserved| reserved.eq_ignore_ascii_case(&name)) {
        return Err(USERNAME_TAKEN);
    }
    let display = display_name(body.display_name.as_deref(), &name)?;
    // Attempts are limited per address; the site-wide cap counts only created accounts, so rejected requests cannot
    // close sign-up for everyone.
    rate_limit(&state, format!("register-address:{}", client_address(&headers)), 20)?;
    rate_limit(&state, format!("register:{name}"), 5)?;
    // Nor may a display name pass for an account the server reserved (its operator's).
    let reserved_account: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM auth_reserved_usernames WHERE username = $1)")
            .bind(name_key(&display))
            .fetch_one(&state.db)
            .await?;
    if reserved_account && name_key(&display) != name {
        return Err(STAFF_NAME);
    }
    let created = rate_reserve(&state, &[("register-created".into(), 600)])?;
    let hash = hash_password(&state, body.password).await?;
    let user = User { id: Uuid::new_v4(), username: name, display_name: display, role: "user".into() };
    if !create_account(&state.db, &user, &hash, false).await? {
        return Err(USERNAME_TAKEN);
    }
    created.keep();
    // The account is made by now, and signing up again would only find its name taken: a sign-in that fails, or runs out
    // of time (`SIGNED_UP_MARGIN`), says the account is there.
    let signing_in = session(&state, &headers, user, &hash, None, StatusCode::CREATED);
    match tokio::time::timeout_at(by - SIGNED_UP_MARGIN, signing_in).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(_)) | Err(_) => Err(SIGNED_UP),
    }
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
    // An address out of guesses is turned away before the database is asked anything.
    rate_exceeded(&state, &address_key(&headers), LOGIN_FAILURES_PER_ADDRESS)?;
    let signed = signed_device(&state, &headers, &name);
    // A device is known while `login_devices` holds it. Devices were not recorded before that table came, so a cookie
    // signed for the account that the table never held is known too until the account first changes its password
    // (which forgets its devices) or holds its full count of them (past which the oldest are forgotten): every cookie
    // given since is recorded as it is given, so only one from before can be signed and not recorded then. Signing in
    // with it records it.
    let row = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, u.password_hash,
           $2::text IS NOT NULL AND (
             EXISTS (SELECT 1 FROM login_devices d WHERE d.user_id = u.id AND d.device_id = $2)
             OR (u.devices_reset_at IS NULL AND (SELECT count(*) FROM login_devices d WHERE d.user_id = u.id) < $3)
           ) AS known_device
         FROM users u WHERE u.username = $1"
    ))
    .bind(&name)
    .bind(signed.as_deref())
    .bind(DEVICES_PER_USER)
    .fetch_optional(&state.db)
    .await?;
    // Only wrong passwords count, per address and per account (see `PasswordCheck`); a limit shared by everyone would
    // let one client lock all players out. A device the account knows has a budget of its own, and its known devices
    // one together: cookies kept from several devices do not multiply the guesses. Other devices share the account's,
    // of which one address spends a part at most.
    let known = row.as_ref().is_some_and(|row| row.get::<bool, _>("known_device"));
    let keys = match signed.as_deref().filter(|_| known) {
        Some(id) => vec![
            (format!("login-failed-device:{id}"), LOGIN_FAILURES_PER_DEVICE),
            (format!("login-failed-devices:{name}"), LOGIN_FAILURES_PER_KNOWN_DEVICES),
        ],
        None => vec![
            (format!("login-failed:{name}"), LOGIN_FAILURES_PER_ACCOUNT),
            (format!("login-failed:{name}:{}", client_address(&headers)), LOGIN_FAILURES_PER_ACCOUNT_ADDRESS),
        ],
    };
    let check = if row.is_some() {
        PasswordCheck::start(&state, &headers, keys)?
    } else {
        PasswordCheck::start_unknown(&state, &headers)?
    };
    let hash = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    if !check.verify(&state, hash.clone(), body.password).await? {
        return Err(INVALID_CREDENTIALS);
    }
    let (Some(row), Some(hash)) = (row, hash) else { return Err(INVALID_CREDENTIALS) };
    session(&state, &headers, User::from_row(&row), &hash, signed, StatusCode::OK).await
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordConfirm {
    current_password: String,
}

/// `POST /api/auth/logout-others` with `{currentPassword}`: ends every other session of the signed-in account (other
/// devices and browsers) and closes their realtime sockets. It asks for the password as changing it does: a stolen
/// session alone cannot end the owner's sessions (again and again, each new one), so the owner can always sign in and
/// end the stolen one. The devices the account knows stay known: someone holding a session cannot shut the owner's
/// devices out of their own budget this way. This browser stays signed in under a new session cookie (see
/// [`start_over`]). At most [`LOGOUT_OTHERS_PER_USER`] done per account in the rate window. Answers
/// `{"ended": <other sessions ended>}`.
pub async fn logout_others(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PasswordConfirm>,
) -> ApiResult<Response> {
    let (user, session) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    if session.replaced {
        return Err(LOGIN_REQUIRED);
    }
    if !plausible_password(&body.current_password) {
        return Err(WRONG_PASSWORD);
    }
    let done = format!("logout-others:{}", user.id);
    rate_exceeded(&state, &done, LOGOUT_OTHERS_PER_USER)?;
    confirm_password(&state, &headers, &user, &session, body.current_password).await?;
    let token = new_token();
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE").bind(user.id).execute(&mut *tx).await?;
    let started = start_over(&mut tx, &state, user.id, &session.hash, &token, None).await?;
    tx.commit().await?;
    rate_record(&state, done);
    let response = Json(json!({"ended": started.others})).into_response();
    close_started_over(&state, &started.ended, session.hash);
    started_over(&state, &headers, response, &user, &token, started.seconds, None)
}

/// The account's password hash, once `password` is found to be it. A wrong one counts against the sign-in of
/// `session` (every session it started over together) and the address, not the account, so a stolen session cannot
/// shut the owner out of signing in.
async fn confirm_password(
    state: &AppState,
    headers: &HeaderMap,
    user: &User,
    session: &Session,
    password: String,
) -> ApiResult<String> {
    let budget = vec![(session.password_budget(user), PASSWORD_FAILURES_PER_SIGN_IN)];
    let check = PasswordCheck::start(state, headers, budget)?;
    let current: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(user.id).fetch_one(&state.db).await?;
    if !check.verify(state, Some(current.clone()), password).await? {
        return Err(WRONG_PASSWORD);
    }
    Ok(current)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

/// `POST /api/auth/password` with `{currentPassword, newPassword}`: the signed-in account's new password, once the
/// current one is checked. Every other session of the account ends with its realtime sockets, and every device but
/// this one is forgotten; this browser stays signed in under a new session cookie (see [`start_over`]), so a copy of
/// the old one is worth nothing either once its grace is over. 204. A wrong current password counts against this
/// sign-in (every session it started over together) and the address, not the account, so a stolen session cannot shut
/// the owner out of signing in. At most [`PASSWORD_CHANGES_PER_USER`] changes per account in the rate window.
pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PasswordChange>,
) -> ApiResult<Response> {
    let (user, session) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    if session.replaced {
        return Err(LOGIN_REQUIRED);
    }
    if !plausible_password(&body.current_password) {
        return Err(WRONG_PASSWORD);
    }
    new_password(&body.new_password)?;
    let changes = format!("password-changed:{}", user.id);
    rate_exceeded(&state, &changes, PASSWORD_CHANGES_PER_USER)?;
    let current = confirm_password(&state, &headers, &user, &session, body.current_password).await?;
    let hash = hash_password(&state, body.new_password).await?;
    let device = signed_device(&state, &headers, &user.username).unwrap_or_else(new_device);
    let token = new_token();
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
    let started = start_over(&mut tx, &state, user.id, &session.hash, &token, Some(&device)).await?;
    tx.commit().await?;
    rate_record(&state, changes);
    close_started_over(&state, &started.ended, session.hash);
    let response = StatusCode::NO_CONTENT.into_response();
    started_over(&state, &headers, response, &user, &token, started.seconds, Some(&device))
}

/// `GET /api/auth/me`, which the app asks each time it opens: who is signed in. A session whose expiry has come closer
/// than [`SESSION_RENEW_BELOW`] is renewed to a full term here (never past [`SESSION_LIFETIME`] from its sign-in), and
/// its cookie sent again with the new Max-Age, so a device in use stays signed in. A session presented under the
/// cookie's old name is sent again under the new one. A session started over answers through its grace, and is neither
/// renewed nor sent again: its successor's cookie is on its way. Other reads of the session ([`optional_user`]) only
/// read it.
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
           WHERE token_hash = $1 AND expires_at > now() AND (legacy_cookie OR NOT $2) AND replaced_at IS NULL
             AND expires_at < now() + interval '{SESSION_RENEW_BELOW}'
             AND expires_at < created_at + interval '{SESSION_LIFETIME}'
           RETURNING expires_at)
         SELECT u.id, u.username, u.display_name, {ROLE_COLUMN}, EXISTS (SELECT 1 FROM renewed) AS renewed,
           s.replaced_at IS NOT NULL AS replaced,
           floor(extract(epoch FROM coalesce((SELECT expires_at FROM renewed), s.expires_at) - now()))::int8 AS seconds_left
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND (s.legacy_cookie OR NOT $2)
           AND s.created_at > now() - interval '{SESSION_LIFETIME}'"
    ))
    .bind(&hash)
    .bind(presented.legacy)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(nobody()) };
    let user = with_permissions(&state, &User::from_row(&row)).await?;
    let mut response = Json(json!({"user": user})).into_response();
    if row.get::<bool, _>("replaced") {
        return Ok(response);
    }
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
    let (user, session) = signed_in(&state, &headers).await?.ok_or(LOGIN_REQUIRED)?;
    // A page asks for one when its room connects and another for its game socket once the room is in, and both again
    // each time a connection drops (checked every second, with waits that double up to 30 seconds), so several tabs or
    // a reconnect loop still fit.
    rate_limit(&state, format!("realtime-ticket:{}", user.id), 180)?;
    let (ticket, expires_at) = crate::rooms::issue_ticket(&state.config.ticket_secret, &user, &session.hash);
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
    fn display_names_hide_nothing_and_cannot_pass_for_staff() {
        let refused = |name: &str| display_name(Some(name), "fallback").unwrap_err().message;
        // 운영자 drawn backwards behind a right-to-left override, and with a Hangul filler, a zero-width space, a word
        // joiner or a left-to-right mark in it.
        for hidden in [
            "\u{202e}자영운",
            "운영자\u{3164}",
            "\u{115f}운영자",
            "운\u{200b}영자",
            "운영\u{2060}자",
            "\u{200e}운영자",
            "운영자\u{ffa0}",
        ] {
            assert_eq!(refused(hidden), HIDDEN_IN_NAME.message, "{hidden:?}");
        }
        // Full-width letters, Hangul written in its decomposed form and a stray variation selector read as what they
        // show.
        let decomposed: String = "운영자".nfd().collect();
        assert_ne!(decomposed, "운영자");
        for staff in [
            "ＡＤＭＩＮ",
            "Ａｄｍｉｎ",
            decomposed.as_str(),
            "관 리 자",
            "Mo Gae Sup",
            "ｍｏｇａｅｓｕｐ",
            "운영자\u{fe0f}",
            "모개숲",
        ] {
            assert_eq!(refused(staff), STAFF_NAME.message, "{staff:?}");
        }
        // Emoji keep the selectors and joiners they are made of, and names that only hold a reserved one are free.
        for kept in ["고양이❤️", "👩\u{200d}💻개발", "🏳️\u{200d}🌈", "운영자님", "ㅋㅋ왕", "admin_fan"]
        {
            assert_eq!(display_name(Some(kept), "fallback").unwrap(), kept, "{kept:?}");
        }
        assert_eq!(display_name(Some("  "), "fallback").unwrap(), "fallback");
        assert_eq!(refused("a\u{7}b"), HIDDEN_IN_NAME.message);
    }

    #[test]
    fn display_names_that_read_as_staff_or_hide_themselves_are_refused() {
        let refused = |name: &str| display_name(Some(name), "fallback").err().map(|error| error.code);
        // In any width, case or spacing, with marks, symbols or joiners between the letters, or spelled in jamo.
        let jamo = "\u{110b}\u{116e}\u{11ab}\u{110b}\u{1167}\u{11bc}\u{110c}\u{1161}";
        let spaced = [" 운 영 자 ", "관리\u{3000}자", "운\u{200d}영자", "[운영자]", "관리자✅", jamo];
        let cased = ["ADMIN", "Ａｄｍｉｎ", "𝐚𝐝𝐦𝐢𝐧", "Staff", "support!", "Mogaesup", "ROOT", "System"];
        for name in ["운영자", "관리자", "Administrator"].into_iter().chain(spaced).chain(cased) {
            assert_eq!(refused(name), Some("reserved_name"), "{name:?}");
        }
        // Nor a name that hides itself, or reads turned around.
        for name in ["\u{200b}", "\u{202e}abc", "모개\u{2066}", "a\u{feff}b", "줄\n바꿈", "\u{7}"] {
            assert_eq!(refused(name), Some("invalid_name"), "{name:?}");
        }
        assert_eq!(refused(&"가".repeat(21)), Some("invalid_name"));
        // Other names are kept as written, emoji too; a blank one is the username.
        for name in ["운영", "관리인", "모개", "rooted", "모개 👩\u{200d}🏫", &"가".repeat(20)] {
            assert_eq!(display_name(Some(name), "fallback").unwrap(), name, "{name:?}");
        }
        assert_eq!(display_name(Some("  "), "mogae").unwrap(), "mogae");
        assert_eq!(display_name(None, "mogae").unwrap(), "mogae");
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
