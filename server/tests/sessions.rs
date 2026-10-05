mod common;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use common::{ORIGIN, Reply, TestApp};
use futures_util::{SinkExt, StreamExt, future::join_all};
use http_body_util::BodyExt;
use mogaesup_server::{
    AppState,
    auth::{CHECKS_UNDER_WAY, SESSIONS_PER_USER},
    config::Config,
    security::{rate_exceeded, rate_record},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";
const FULL_TERM: &str = "Max-Age=2592000";

async fn login(app: &TestApp, username: &str) -> String {
    let body = json!({"username": username, "password": PASSWORD});
    let reply = app.call("POST", "/api/auth/login", Some(body), None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    reply.cookie.expect("session cookie")
}

async fn me(app: &TestApp, cookie: &str) -> Reply {
    let reply = app.call("GET", "/api/auth/me", None, Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK);
    reply
}

/// The account signed in with `cookie`, if any.
async fn signed_in(app: &TestApp, cookie: &str) -> Value {
    me(app, cookie).await.body["user"]["username"].clone()
}

fn set_cookie(reply: &Reply) -> Option<&str> {
    reply.headers.get(header::SET_COOKIE).map(|value| value.to_str().unwrap())
}

fn hash(cookie: &str) -> String {
    hex::encode(Sha256::digest(cookie.strip_prefix("mogaesup_session=").unwrap().as_bytes()))
}

/// The session behind `cookie` as if it were made or last renewed `hours` earlier.
async fn age(app: &TestApp, cookie: &str, hours: i32) {
    sqlx::query("UPDATE sessions SET expires_at = expires_at - make_interval(hours => $2) WHERE token_hash = $1")
        .bind(hash(cookie))
        .bind(hours)
        .execute(&app.state.db)
        .await
        .unwrap();
}

/// Days until the session behind `cookie` runs out; None when it is gone.
async fn days_left(app: &TestApp, cookie: &str) -> Option<f64> {
    sqlx::query_scalar(
        "SELECT extract(epoch FROM expires_at - now())::float8 / 86400 FROM sessions WHERE token_hash = $1",
    )
    .bind(hash(cookie))
    .fetch_optional(&app.state.db)
    .await
    .unwrap()
}

async fn sessions(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM sessions").fetch_one(&app.state.db).await.unwrap()
}

#[tokio::test]
async fn 며칠_뒤에_다시_쓴_세션은_30일로_늘고_쿠키를_다시_받는다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("slide_a", "슬라이드").await;
    // Just signed in: nothing to renew, nothing written.
    let fresh = me(&app, &cookie).await;
    assert_eq!(fresh.body["user"]["username"], "slide_a");
    assert_eq!(set_cookie(&fresh), None);

    // Ten days later the same device opens the app.
    age(&app, &cookie, 10 * 24).await;
    assert!((19.9..20.1).contains(&days_left(&app, &cookie).await.unwrap()));
    let renewed = me(&app, &cookie).await;
    assert_eq!(renewed.body["user"]["username"], "slide_a");
    let sent = set_cookie(&renewed).expect("the cookie comes again");
    assert!(sent.starts_with(&format!("{cookie};")), "{sent}");
    assert!(sent.contains(FULL_TERM) && sent.contains("HttpOnly") && sent.contains("SameSite=Strict"), "{sent}");
    assert!(days_left(&app, &cookie).await.unwrap() > 29.99);

    // Opened again the same day: the row and the cookie stay as they are.
    let again = me(&app, &cookie).await;
    assert_eq!(set_cookie(&again), None);
    age(&app, &cookie, 12).await;
    assert_eq!(set_cookie(&me(&app, &cookie).await), None);
    assert!((29.4..29.6).contains(&days_left(&app, &cookie).await.unwrap()));
    // A day after the last renewal, it is renewed again.
    age(&app, &cookie, 13).await;
    assert!(set_cookie(&me(&app, &cookie).await).is_some_and(|sent| sent.contains(FULL_TERM)));
    assert!(days_left(&app, &cookie).await.unwrap() > 29.99);
    app.cleanup().await;
}

#[tokio::test]
async fn 만료된_세션은_늘지_않는다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("slide_b", "만료").await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'").execute(&app.state.db).await.unwrap();
    let reply = me(&app, &cookie).await;
    assert_eq!(reply.body["user"], Value::Null);
    assert_eq!(set_cookie(&reply), None);
    assert!(days_left(&app, &cookie).await.unwrap() < 0.0);
    // A cookie that is not a session token is nobody, with nothing written.
    let reply = me(&app, "mogaesup_session=not-a-token").await;
    assert_eq!(reply.body["user"], Value::Null);
    assert_eq!(set_cookie(&reply), None);
    app.cleanup().await;
}

#[tokio::test]
async fn 다른_기기에서_로그인해도_먼저_쓰던_기기는_로그인_상태로_남는다() {
    let app = TestApp::new(None).await;
    let phone = app.register("two_devices", "두 기기").await;
    let laptop = login(&app, "two_devices").await;
    assert_ne!(phone, laptop);
    assert_eq!(signed_in(&app, &phone).await, "two_devices");
    assert_eq!(signed_in(&app, &laptop).await, "two_devices");
    assert_eq!(sessions(&app).await, 2);
    app.cleanup().await;
}

#[tokio::test]
async fn 한_기기에서_로그아웃해도_다른_기기는_로그인_상태로_남는다() {
    let app = TestApp::new(None).await;
    let phone = app.register("logout_one", "로그아웃").await;
    let laptop = login(&app, "logout_one").await;
    let logout = app.call("POST", "/api/auth/logout", None, Some(&laptop)).await;
    assert_eq!(logout.status, StatusCode::NO_CONTENT);
    assert!(set_cookie(&logout).is_some_and(|sent| sent.contains("Max-Age=0")));
    assert_eq!(signed_in(&app, &laptop).await, Value::Null);
    assert_eq!(signed_in(&app, &phone).await, "logout_one");
    assert_eq!(days_left(&app, &laptop).await, None);
    app.cleanup().await;
}

#[tokio::test]
async fn 세션이_상한을_넘으면_가장_오래_쓰지_않은_기기부터_끝난다() {
    let app = TestApp::new(None).await;
    // The first device signed in, then left for 15 days.
    let phone = app.register("many_devices", "여러 기기").await;
    age(&app, &phone, 15 * 24).await;
    // Devices signed in later and last used 10 days ago, the later ones a minute apart: device 0 most recently.
    let user = app.user_id("many_devices").await;
    let others: Vec<String> = (1..SESSIONS_PER_USER).map(|at| format!("mogaesup_session={at:064x}")).collect();
    for (at, cookie) in others.iter().enumerate() {
        sqlx::query(
            "INSERT INTO sessions (token_hash, user_id, expires_at)
             VALUES ($1, $2, now() + interval '20 days' - make_interval(mins => $3))",
        )
        .bind(hash(cookie))
        .bind(user)
        .bind(at as i32)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    assert_eq!(sessions(&app).await, SESSIONS_PER_USER);
    // The oldest sign-in is the one in use today.
    assert!(set_cookie(&me(&app, &phone).await).is_some());

    // Three new devices sign in: the three used least recently make room, the one in use today stays.
    let mut new = Vec::new();
    for _ in 0..3 {
        new.push(login(&app, "many_devices").await);
    }
    assert_eq!(sessions(&app).await, SESSIONS_PER_USER);
    assert_eq!(signed_in(&app, &phone).await, "many_devices");
    for cookie in &new {
        assert_eq!(signed_in(&app, cookie).await, "many_devices");
    }
    let (kept, gone) = others.split_at(others.len() - 3);
    for cookie in kept {
        assert_eq!(signed_in(&app, cookie).await, "many_devices");
    }
    for cookie in gone {
        assert_eq!(signed_in(&app, cookie).await, Value::Null);
        assert_eq!(days_left(&app, cookie).await, None);
    }
    app.cleanup().await;
}

const NEW_PASSWORD: &str = "a brand new passphrase";

async fn change_password(app: &TestApp, cookie: &str, current: &str, new: &str) -> Reply {
    let body = json!({"currentPassword": current, "newPassword": new});
    app.call("POST", "/api/auth/password", Some(body), Some(cookie)).await
}

async fn login_with(app: &TestApp, username: &str, password: &str) -> Reply {
    app.call("POST", "/api/auth/login", Some(json!({"username": username, "password": password})), None).await
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A room socket on `room`'s island for the session behind `cookie`, joined.
async fn joined(app: &TestApp, base: &str, room: &str, cookie: &str) -> Socket {
    let ticket = app.call("POST", "/api/auth/realtime-ticket", None, Some(cookie)).await.body["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut request = format!("{base}/api/rooms/{room}?ticket={ticket}").into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    let join = json!({"type": "Join", "room_id": room, "color": "#fff"});
    socket.send(Message::text(join.to_string())).await.unwrap();
    let welcome = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message
                && serde_json::from_str::<Value>(&text).unwrap()["type"] == "Welcome"
            {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(welcome, Ok(true));
    socket
}

/// The code of the close frame the server sends next; None when nothing comes in time.
async fn closed(socket: &mut Socket) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(message) = socket.next().await {
            if let Ok(Message::Close(frame)) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }
        None
    })
    .await
    .unwrap_or(None)
}

async fn serve(app: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("ws://{address}")
}

#[tokio::test]
async fn 비밀번호를_바꾸면_다른_기기는_모두_끝나고_바꾼_기기만_남는다() {
    let app = TestApp::new(None).await;
    let phone = app.register("change_pw", "비밀번호").await;
    let laptop = login(&app, "change_pw").await;
    let tablet = login(&app, "change_pw").await;
    let base = serve(&app).await;
    let mut kept = joined(&app, &base, "change_pw", &phone).await;
    let mut ended = joined(&app, &base, "change_pw", &laptop).await;

    // A wrong current password changes nothing; it is no sign that the session ended (not 401).
    let wrong = change_password(&app, &phone, "not the password", NEW_PASSWORD).await;
    assert_eq!((wrong.status, wrong.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("wrong_password")));
    // The new one follows the sign-up rules.
    let short = change_password(&app, &phone, PASSWORD, "short").await;
    assert_eq!(
        (short.status, short.body["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_password"))
    );
    assert_eq!(signed_in(&app, &laptop).await, "change_pw");

    let changed = change_password(&app, &phone, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT, "{:?}", changed.body);
    assert_eq!(signed_in(&app, &phone).await, "change_pw");
    for other in [&laptop, &tablet] {
        assert_eq!(signed_in(&app, other).await, Value::Null);
        assert_eq!(days_left(&app, other).await, None);
    }
    assert_eq!(closed(&mut ended).await, Some(4401));
    let ping = json!({"type": "Ping", "ts": 5});
    kept.send(Message::text(ping.to_string())).await.unwrap();
    assert_eq!(closed(&mut kept).await, None, "the socket of the session that changed it stays open");

    assert_eq!(login_with(&app, "change_pw", PASSWORD).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login_with(&app, "change_pw", NEW_PASSWORD).await.status, StatusCode::OK);
    // Without a session, nothing to change.
    let body = json!({"currentPassword": NEW_PASSWORD, "newPassword": PASSWORD});
    let anonymous = app.call("POST", "/api/auth/password", Some(body), None).await;
    assert_eq!((anonymous.status, anonymous.body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("login_required")));
    app.cleanup().await;
}

#[tokio::test]
async fn 지금_비밀번호를_틀려도_계정의_로그인은_잠기지_않는다() {
    let app = TestApp::new(None).await;
    let stolen = app.register("guess_pw", "추측").await;
    // Wrong guesses through a session count against that session (and its address), not the account.
    for _ in 0..10 {
        assert_eq!(change_password(&app, &stolen, "a wrong guess", NEW_PASSWORD).await.status, StatusCode::BAD_REQUEST);
    }
    let spent = change_password(&app, &stolen, PASSWORD, NEW_PASSWORD).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert!(rate_exceeded(&app.state, "login-failed:guess_pw", 1).is_ok());
    let owner = login(&app, "guess_pw").await;
    assert_eq!(change_password(&app, &owner, PASSWORD, NEW_PASSWORD).await.status, StatusCode::NO_CONTENT);
    assert_eq!(signed_in(&app, &stolen).await, Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 다른_기기_모두_로그아웃은_이_기기만_남긴다() {
    let app = TestApp::new(None).await;
    let phone = app.register("others_out", "다른 기기").await;
    let laptop = login(&app, "others_out").await;
    let tablet = login(&app, "others_out").await;
    let stranger = app.register("others_keep", "남").await;
    let base = serve(&app).await;
    let mut ended = joined(&app, &base, "others_out", &tablet).await;
    let reply = app.call("POST", "/api/auth/logout-others", None, Some(&phone)).await;
    assert_eq!((reply.status, reply.body["ended"].as_i64()), (StatusCode::OK, Some(2)));
    assert_eq!(signed_in(&app, &phone).await, "others_out");
    assert_eq!(signed_in(&app, &laptop).await, Value::Null);
    assert_eq!(signed_in(&app, &tablet).await, Value::Null);
    assert_eq!(signed_in(&app, &stranger).await, "others_keep", "other accounts keep their sessions");
    assert_eq!(closed(&mut ended).await, Some(4401));
    let again = app.call("POST", "/api/auth/logout-others", None, Some(&phone)).await;
    assert_eq!(again.body["ended"], 0);
    let anonymous = app.call("POST", "/api/auth/logout-others", None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn 계정_전체를_바꾸는_요청도_다른_사이트에서는_받지_않는다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("cross_site", "출처").await;
    for (path, body) in [
        ("/api/auth/password", json!({"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})),
        ("/api/auth/logout-others", json!({})),
    ] {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::ORIGIN, "https://elsewhere.example")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie)
            .body(Body::from(body.to_string()))
            .unwrap();
        assert_eq!(app.send(request).await.status, StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(login_with(&app, "cross_site", PASSWORD).await.status, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 쓰는_세션도_로그인한_지_90일이_지나면_끝난다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("lifetime", "수명").await;
    // Signed in 89 days ago and renewed ever since (last a while ago): the renewal stops at 90 days from the sign-in.
    sqlx::query(
        "UPDATE sessions SET created_at = now() - interval '89 days', expires_at = now() + interval '12 hours'
         WHERE token_hash = $1",
    )
    .bind(hash(&cookie))
    .execute(&app.state.db)
    .await
    .unwrap();
    let renewed = me(&app, &cookie).await;
    let sent = set_cookie(&renewed).expect("renewed up to the session's end");
    let max_age: u32 = sent.split("Max-Age=").nth(1).unwrap().split(';').next().unwrap().parse().unwrap();
    assert!((86_000..=86_400).contains(&max_age), "{sent}");
    assert!((0.99..1.01).contains(&days_left(&app, &cookie).await.unwrap()));
    // At its end already: no further renewal.
    assert_eq!(set_cookie(&me(&app, &cookie).await), None);
    sqlx::query(
        "UPDATE sessions SET created_at = created_at - interval '1 day', expires_at = expires_at - interval '1 day'",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(signed_in(&app, &cookie).await, Value::Null);
    app.cleanup().await;
}

/// The values of every Set-Cookie header, in order.
fn set_cookies(headers: &axum::http::HeaderMap) -> Vec<String> {
    headers.get_all(header::SET_COOKIE).iter().map(|value| value.to_str().unwrap().to_owned()).collect()
}

/// `name=value` of the Set-Cookie for `name`.
fn pair(cookies: &[String], name: &str) -> Option<String> {
    cookies
        .iter()
        .find(|cookie| cookie.starts_with(&format!("{name}=")))
        .map(|cookie| cookie.split(';').next().unwrap().to_owned())
}

/// The same server with Secure cookies, as production runs it.
fn secure(app: &TestApp) -> Router {
    let config = Config { cookie_secure: true, ..(*app.state.config).clone() };
    mogaesup_server::router(AppState::new(app.state.db.clone(), config))
}

async fn call_on(router: &Router, method: &str, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
    let mut request = Request::builder().method(method).uri(path).header(header::ORIGIN, ORIGIN);
    if method != "GET" {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let body = if method == "GET" { Body::empty() } else { Body::from(body.unwrap_or(json!({})).to_string()) };
    let response = router.clone().oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let cookie = set_cookies(&headers).first().map(|cookie| cookie.split(';').next().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    Reply { status, cookie, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), bytes, headers }
}

#[tokio::test]
async fn 보안_쿠키는_host_접두사로_주고_예전_이름의_세션은_옮겨_준다() {
    let app = TestApp::new(None).await;
    let router = secure(&app);
    let body = json!({"username": "host_cookie", "displayName": "호스트", "password": PASSWORD});
    let registered = call_on(&router, "POST", "/api/auth/register", Some(body), None).await;
    assert_eq!(registered.status, StatusCode::CREATED);
    let sent = set_cookies(&registered.headers);
    let session = &sent[0];
    assert!(session.starts_with("__Host-mogaesup_session="), "{sent:?}");
    for part in ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"] {
        assert!(session.split("; ").any(|attribute| attribute == part), "{part}: {session}");
    }
    assert!(!session.contains("Domain"), "{session}");
    assert!(pair(&sent, "__Host-mogaesup_device").is_some(), "{sent:?}");
    let cookie = pair(&sent, "__Host-mogaesup_session").unwrap();
    let token = cookie.split_once('=').unwrap().1.to_owned();
    let me_on = |cookie: String| {
        let router = router.clone();
        async move { call_on(&router, "GET", "/api/auth/me", None, Some(&cookie)).await }
    };
    assert_eq!(me_on(cookie.clone()).await.body["user"]["username"], "host_cookie");
    // A session issued under the new name is not taken under the old one, as a cookie planted from another
    // subdomain would carry it.
    assert_eq!(me_on(format!("mogaesup_session={token}")).await.body["user"], Value::Null);

    // A session from before the rename, still under the old name: it is moved to the new one, and the old cookie ends.
    let old = login(&app, "host_cookie").await;
    let old_token = old.split_once('=').unwrap().1.to_owned();
    let moved = me_on(old.clone()).await;
    assert_eq!(moved.body["user"]["username"], "host_cookie");
    let sent = set_cookies(&moved.headers);
    assert_eq!(pair(&sent, "__Host-mogaesup_session"), Some(format!("__Host-mogaesup_session={old_token}")));
    let cleared = sent.iter().find(|cookie| cookie.starts_with("mogaesup_session=;")).expect("the old name ends");
    assert!(cleared.contains("Max-Age=0") && cleared.contains("Path=/"), "{cleared}");
    assert_eq!(me_on(old).await.body["user"], Value::Null, "the old name no longer carries it");
    assert_eq!(me_on(format!("__Host-mogaesup_session={old_token}")).await.body["user"]["username"], "host_cookie");

    // Signing out ends both names.
    let both = format!("__Host-mogaesup_session={token}; mogaesup_session={old_token}");
    let out = call_on(&router, "POST", "/api/auth/logout", None, Some(&both)).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    let sent = set_cookies(&out.headers);
    assert!(sent.iter().any(|cookie| cookie.starts_with("__Host-mogaesup_session=;") && cookie.contains("Max-Age=0")));
    assert!(sent.iter().any(|cookie| cookie.starts_with("mogaesup_session=;") && cookie.contains("Max-Age=0")));
    assert_eq!(me_on(cookie).await.body["user"], Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 로컬_http는_예전_이름_그대로_보안_속성_없이_준다() {
    let app = TestApp::new(None).await;
    let body = json!({"username": "plain_cookie", "password": PASSWORD});
    let registered = app.call("POST", "/api/auth/register", Some(body), None).await;
    let sent = set_cookies(&registered.headers);
    assert!(sent[0].starts_with("mogaesup_session=") && !sent[0].contains("Secure"), "{sent:?}");
    assert!(pair(&sent, "mogaesup_device").is_some(), "{sent:?}");
    assert!(sent.iter().all(|cookie| !cookie.starts_with("__Host-")));
    app.cleanup().await;
}

/// The device cookie a sign-in sent, as a request's Cookie.
fn device(reply: &Reply) -> String {
    pair(&set_cookies(&reply.headers), "mogaesup_device").expect("a device cookie")
}

async fn login_from(app: &TestApp, cookie: Option<&str>, username: &str, password: &str) -> StatusCode {
    let body = json!({"username": username, "password": password});
    app.call("POST", "/api/auth/login", Some(body), cookie).await.status
}

#[tokio::test]
async fn 남이_비밀번호를_마구_틀려도_쓰던_기기에서는_로그인한다() {
    let app = TestApp::new(None).await;
    let body = json!({"username": "known_device", "password": PASSWORD});
    let known = device(&app.call("POST", "/api/auth/register", Some(body), None).await);
    app.register("someone_else", "남").await;
    // Others ran the account out of guesses.
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:known_device".into());
    }
    assert_eq!(login_from(&app, None, "known_device", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(login_from(&app, Some(&known), "known_device", PASSWORD).await, StatusCode::OK);
    // The cookie vouches for that account alone, and a forged one for none.
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:someone_else".into());
    }
    assert_eq!(login_from(&app, Some(&known), "someone_else", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    let forged = format!("{}0", &known[..known.len() - 1]);
    let forged = if forged == known { format!("{}1", &known[..known.len() - 1]) } else { forged };
    assert_eq!(login_from(&app, Some(&forged), "known_device", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    // The device has a budget of its own.
    for _ in 0..10 {
        assert_eq!(login_from(&app, Some(&known), "known_device", "a wrong guess").await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(login_from(&app, Some(&known), "known_device", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;
}

#[tokio::test]
async fn 확인을_기다리는_틀린_비밀번호는_틀리기_전까지_계정을_막지_않는다() {
    let app = TestApp::new(None).await;
    app.register("in_flight", "대기").await;
    let held = app.state.hashing.clone().acquire_many_owned(2).await.unwrap();
    let waiting = CHECKS_UNDER_WAY as usize;
    let attempts = join_all((0..=waiting).map(|_| login_with(&app, "in_flight", "a wrong guess")));
    let probe = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        // The checks wait for a hashing slot, and none of them holds the account's budget yet.
        let free = rate_exceeded(&app.state, "login-failed:in_flight", 1).is_ok();
        drop(held);
        free
    };
    let (replies, free) = tokio::join!(attempts, probe);
    assert!(free, "checks under way held the account's budget");
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    let checked = statuses.iter().filter(|status| **status == StatusCode::UNAUTHORIZED).count();
    assert_eq!(checked, waiting, "{statuses:?}");
    let busy = replies.iter().filter(|reply| reply.body["code"] == "busy").count();
    assert_eq!(busy, 1, "one check more of the same account at once is turned away: {statuses:?}");
    // Found wrong, they count.
    assert!(rate_exceeded(&app.state, "login-failed:in_flight", CHECKS_UNDER_WAY).is_err());
    // A name nobody has keeps no window of its own; its guesses still cost the address.
    assert_eq!(login_with(&app, "nobody_here", "a wrong guess").await.status, StatusCode::UNAUTHORIZED);
    assert!(rate_exceeded(&app.state, "login-failed:nobody_here", 1).is_ok());
    assert!(rate_exceeded(&app.state, "login-failed-address:local", CHECKS_UNDER_WAY + 1).is_err());
    app.cleanup().await;
}
