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
    auth::{CHECKS_UNDER_WAY, DEVICES_PER_USER, LOGOUT_OTHERS_PER_USER, PASSWORD_CHANGES_PER_USER, SESSIONS_PER_USER},
    config::Config,
    security::{hmac_sha256, rate_exceeded, rate_record},
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

async fn logout_others(app: &TestApp, cookie: &str, current: &str) -> Reply {
    app.call("POST", "/api/auth/logout-others", Some(json!({"currentPassword": current})), Some(cookie)).await
}

async fn login_with(app: &TestApp, username: &str, password: &str) -> Reply {
    app.call("POST", "/api/auth/login", Some(json!({"username": username, "password": password})), None).await
}

/// A sign-in from `address`, as CloudFront forwards it.
async fn login_at(app: &TestApp, address: &str, username: &str, password: &str) -> Reply {
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", address);
    let body = json!({"username": username, "password": password}).to_string();
    app.send(request.body(Body::from(body)).unwrap()).await
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
    closed_within(socket, Duration::from_secs(2)).await
}

/// Like [`closed`], waiting `wait` for it.
async fn closed_within(socket: &mut Socket, wait: Duration) -> Option<u16> {
    tokio::time::timeout(wait, async {
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
    // This browser goes on under a new session: a copy of its old cookie is worth nothing once its grace is over.
    let renewed = changed.cookie.clone().expect("a new session cookie");
    assert_ne!(renewed, phone);
    assert!(set_cookies(&changed.headers).iter().any(|cookie| cookie.starts_with("mogaesup_device=")));
    assert_eq!(signed_in(&app, &renewed).await, "change_pw");
    assert_eq!(days_left(&app, &renewed).await.map(f64::round), Some(30.0));
    for other in [&laptop, &tablet] {
        assert_eq!(signed_in(&app, other).await, Value::Null);
        assert_eq!(days_left(&app, other).await, None);
    }
    assert_eq!(closed(&mut ended).await, Some(4401));
    // Requests this browser had already sent with the old cookie, and its other tabs, still pass a moment, but that
    // cookie starts nothing over again and is not renewed.
    assert_eq!(signed_in(&app, &phone).await, "change_pw");
    assert!(days_left(&app, &phone).await.is_some_and(|days| days * 86_400.0 <= 90.5), "a grace of 90 seconds");
    let again = change_password(&app, &phone, NEW_PASSWORD, "yet another passphrase").await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("login_required")));
    assert_eq!(set_cookie(&me(&app, &phone).await), None);
    assert!(days_left(&app, &phone).await.is_some_and(|days| days * 86_400.0 <= 90.5));
    // The old session's socket closes a moment after the answer; the page joins again under the new one.
    assert_eq!(closed_within(&mut kept, Duration::from_secs(8)).await, Some(4401));
    let mut rejoined = joined(&app, &base, "change_pw", &renewed).await;
    let ping = json!({"type": "Ping", "ts": 5});
    rejoined.send(Message::text(ping.to_string())).await.unwrap();
    assert_eq!(closed(&mut rejoined).await, None);

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
    // Wrong guesses through a session count against its sign-in (and its address), not the account.
    for _ in 0..9 {
        assert_eq!(change_password(&app, &stolen, "a wrong guess", NEW_PASSWORD).await.status, StatusCode::BAD_REQUEST);
    }
    // Starting the session over (signing the other devices out, which asks for the password too) keeps the sign-in:
    // it hands no new guesses.
    let rotated = logout_others(&app, &stolen, PASSWORD).await;
    let stolen = rotated.cookie.expect("a new session cookie");
    assert_eq!(change_password(&app, &stolen, "a wrong guess", NEW_PASSWORD).await.status, StatusCode::BAD_REQUEST);
    let spent = change_password(&app, &stolen, PASSWORD, NEW_PASSWORD).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    let rotate = logout_others(&app, &stolen, PASSWORD).await;
    assert_eq!((rotate.status, rotate.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert!(rate_exceeded(&app.state, "login-failed:guess_pw", 1).is_ok());
    // The owner signs in afresh, with guesses of their own, and the password change ends the other sign-in.
    let owner = login(&app, "guess_pw").await;
    assert_eq!(change_password(&app, &owner, PASSWORD, NEW_PASSWORD).await.status, StatusCode::NO_CONTENT);
    assert_eq!(signed_in(&app, &stolen).await, Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 다른_기기_로그아웃과_비밀번호_변경은_계정마다_횟수가_정해져_있다() {
    let app = TestApp::new(None).await;
    let mut cookie = app.register("rotations", "횟수").await;
    // A wrong password signs nothing out and takes none of them.
    let wrong = logout_others(&app, &cookie, "a wrong guess").await;
    assert_eq!((wrong.status, wrong.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("wrong_password")));
    for _ in 0..LOGOUT_OTHERS_PER_USER {
        let reply = logout_others(&app, &cookie, PASSWORD).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        cookie = reply.cookie.expect("a new session cookie");
    }
    let refused = logout_others(&app, &cookie, PASSWORD).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    // Signing the other devices out cannot keep the owner from changing the password, and only changes made count.
    let passwords = [PASSWORD, NEW_PASSWORD];
    for at in 0..PASSWORD_CHANGES_PER_USER as usize {
        let (current, new) = (passwords[at % 2], passwords[(at + 1) % 2]);
        assert_eq!(change_password(&app, &cookie, "a wrong guess", new).await.status, StatusCode::BAD_REQUEST);
        let changed = change_password(&app, &cookie, current, new).await;
        assert_eq!(changed.status, StatusCode::NO_CONTENT, "{:?}", changed.body);
        cookie = changed.cookie.expect("a new session cookie");
    }
    let current = passwords[PASSWORD_CHANGES_PER_USER as usize % 2];
    let refused = change_password(&app, &cookie, current, "one change too many").await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    app.cleanup().await;
}

#[tokio::test]
async fn 기기_쿠키는_비밀번호를_바꾸면_끝나고_계정당_개수와_틀린_횟수가_정해져_있다() {
    let app = TestApp::new(None).await;
    let registered =
        app.call("POST", "/api/auth/register", Some(json!({"username": "devices", "password": PASSWORD})), None).await;
    let first = device(&registered);
    // Ten more devices sign in; the first, used least recently, is forgotten.
    let mut later = Vec::new();
    for _ in 0..DEVICES_PER_USER {
        later.push(device(&login_with(&app, "devices", PASSWORD).await));
    }
    let known: i64 = sqlx::query_scalar("SELECT count(*) FROM login_devices").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(known, DEVICES_PER_USER);
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:devices".into());
    }
    assert_eq!(login_from(&app, Some(&first), "devices", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(login_from(&app, Some(&later[0]), "devices", PASSWORD).await, StatusCode::OK);

    // Wrong guesses from the account's known devices count together, wherever they come from: cookies kept from many
    // devices do not multiply them.
    let guess = |cookie: &str, address: &str| {
        let request = Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .header("x-forwarded-for", address)
            .body(Body::from(json!({"username": "devices", "password": "a wrong guess"}).to_string()))
            .unwrap();
        let app = &app;
        async move { app.send(request).await.status }
    };
    for (at, cookie) in later[..3].iter().enumerate() {
        for _ in 0..10 {
            assert_eq!(guess(cookie, &format!("203.0.113.{at}")).await, StatusCode::UNAUTHORIZED);
        }
    }
    assert_eq!(guess(&later[3], "198.51.100.9").await, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;

    // A password change forgets every device but the one that changed it: a device cookie kept by someone who knew the
    // old password no longer has a budget of its own.
    let app = TestApp::new(None).await;
    let registered =
        app.call("POST", "/api/auth/register", Some(json!({"username": "changed", "password": PASSWORD})), None).await;
    let (session, own) = (registered.cookie.clone().unwrap(), device(&registered));
    let kept = device(&login_with(&app, "changed", PASSWORD).await);
    let changed = app
        .call(
            "POST",
            "/api/auth/password",
            Some(json!({"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})),
            Some(&format!("{session}; {own}")),
        )
        .await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT);
    assert_eq!(device(&changed), own, "this device stays the one it was");
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:changed".into());
    }
    assert_eq!(login_from(&app, Some(&kept), "changed", NEW_PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(login_from(&app, Some(&own), "changed", NEW_PASSWORD).await, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 운영진처럼_보이는_표시_이름은_새_계정이_쓰지_못한다() {
    let app = TestApp::new(None).await;
    // In any spacing, with a variation selector, in full-width letters, or as decomposed Hangul: a name that reads as
    // staff (reserved_name).
    for name in [
        "운영자",
        "운 영 자",
        "ADMIN",
        " Mo Gae Sup ",
        "모개숲",
        "운영자\u{fe0f}",
        "ＡＤＭＩＮ",
        "\u{110b}\u{116e}\u{11ab}\u{110b}\u{1167}\u{11bc}\u{110c}\u{1161}",
    ] {
        let body = json!({"username": "staffish", "displayName": name, "password": PASSWORD});
        let reply = app.call("POST", "/api/auth/register", Some(body), None).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("reserved_name")),
            "{name}"
        );
    }
    // Behind a zero-width space, a right-to-left override or a Hangul filler: a name that hides something
    // (invalid_name).
    for name in ["관\u{200b}리자", "\u{202e}자영운", "운영자\u{3164}"] {
        let body = json!({"username": "staffish", "displayName": name, "password": PASSWORD});
        let reply = app.call("POST", "/api/auth/register", Some(body), None).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_name")),
            "{name}"
        );
    }
    // Nor the name of an account the server reserved, its operator's.
    sqlx::query("INSERT INTO auth_reserved_usernames (username) VALUES ('the_operator')")
        .execute(&app.state.db)
        .await
        .unwrap();
    let body = json!({"username": "lookalike", "displayName": "The_Operator", "password": PASSWORD});
    assert_eq!(app.call("POST", "/api/auth/register", Some(body), None).await.body["code"], "reserved_name");
    let body = json!({"username": "staffish", "displayName": "운영자님", "password": PASSWORD});
    assert_eq!(app.call("POST", "/api/auth/register", Some(body), None).await.status, StatusCode::CREATED);
    // Emoji keep the selectors and joiners they are made of, and the name is kept as it was typed.
    let body = json!({"username": "hearts", "displayName": "고양이❤️👩\u{200d}💻", "password": PASSWORD});
    let hearts = app.call("POST", "/api/auth/register", Some(body), None).await;
    assert_eq!(hearts.status, StatusCode::CREATED, "{:?}", hearts.body);
    assert_eq!(hearts.body["user"]["displayName"], "고양이❤️👩\u{200d}💻");
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
    // Without the password (as the app sent it before it asked for one), or with a wrong one, nothing ends; a wrong one
    // is no sign that the session ended (not 401).
    let missing = app.call("POST", "/api/auth/logout-others", None, Some(&phone)).await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY, "{:?}", missing.body);
    let wrong = logout_others(&app, &phone, "not the password").await;
    assert_eq!((wrong.status, wrong.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("wrong_password")));
    assert_eq!(signed_in(&app, &laptop).await, "others_out");
    let reply = logout_others(&app, &phone, PASSWORD).await;
    assert_eq!((reply.status, reply.body["ended"].as_i64()), (StatusCode::OK, Some(2)));
    // This browser stays signed in, under a new session: the old cookie, wherever a copy of it went, is done once the
    // requests already on their way with it had their moment.
    let renewed = reply.cookie.clone().expect("a new session cookie");
    assert_eq!(signed_in(&app, &renewed).await, "others_out");
    assert_eq!(signed_in(&app, &laptop).await, Value::Null);
    assert_eq!(signed_in(&app, &tablet).await, Value::Null);
    assert_eq!(signed_in(&app, &stranger).await, "others_keep", "other accounts keep their sessions");
    assert_eq!(closed(&mut ended).await, Some(4401));
    assert_eq!(signed_in(&app, &phone).await, "others_out");
    assert!(days_left(&app, &phone).await.is_some_and(|days| days * 86_400.0 <= 90.5), "a grace of 90 seconds");
    // A session replaced, or already ended, starts nothing over.
    let gone = logout_others(&app, &phone, PASSWORD).await;
    assert_eq!((gone.status, gone.cookie), (StatusCode::UNAUTHORIZED, None));
    // Starting over again ends the replaced one as well, which was no other device.
    let again = logout_others(&app, &renewed, PASSWORD).await;
    assert_eq!(again.body["ended"], 0);
    assert_eq!(signed_in(&app, &phone).await, Value::Null);
    let anonymous = app.call("POST", "/api/auth/logout-others", Some(json!({"currentPassword": PASSWORD})), None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn 훔친_세션만으로는_주인의_세션을_끝내지_못하고_주인은_다시_로그인해_그_세션을_끝낸다() {
    let app = TestApp::new(None).await;
    let stolen = app.register("stolen_out", "주인").await;
    let laptop = login(&app, "stolen_out").await;
    // The stolen session does not know the password: its guesses end nothing and count against it alone.
    for _ in 0..10 {
        assert_eq!(logout_others(&app, &stolen, "a wrong guess").await.status, StatusCode::BAD_REQUEST);
    }
    let spent = logout_others(&app, &stolen, PASSWORD).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert_eq!(signed_in(&app, &laptop).await, "stolen_out");
    assert!(rate_exceeded(&app.state, "login-failed:stolen_out", 1).is_ok());
    // The owner, on the laptop, ends it.
    let reply = logout_others(&app, &laptop, PASSWORD).await;
    assert_eq!((reply.status, reply.body["ended"].as_i64()), (StatusCode::OK, Some(1)));
    assert_eq!(signed_in(&app, &stolen).await, Value::Null);
    assert_eq!(signed_in(&app, &laptop).await, "stolen_out");
    app.cleanup().await;
}

#[tokio::test]
async fn 계정_전체를_바꾸는_요청도_다른_사이트에서는_받지_않는다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("cross_site", "출처").await;
    for (path, body) in [
        ("/api/auth/password", json!({"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})),
        ("/api/auth/logout-others", json!({"currentPassword": PASSWORD})),
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

    // Starting over (signing the other devices out) makes a new session of the same sign-in, so it cannot keep a
    // session going past its lifetime either.
    let cookie = login(&app, "lifetime").await;
    sqlx::query("UPDATE sessions SET created_at = now() - interval '89 days' WHERE token_hash = $1")
        .bind(hash(&cookie))
        .execute(&app.state.db)
        .await
        .unwrap();
    let reply = logout_others(&app, &cookie, PASSWORD).await;
    let renewed = reply.cookie.clone().expect("a new session cookie");
    assert!((0.99..1.01).contains(&days_left(&app, &renewed).await.unwrap()));
    let sent = set_cookie(&reply).unwrap();
    let max_age: u32 = sent.split("Max-Age=").nth(1).unwrap().split(';').next().unwrap().parse().unwrap();
    assert!((86_000..=86_400).contains(&max_age), "{sent}");
    app.cleanup().await;
}

#[tokio::test]
async fn 예전_서버가_더_늘린_세션도_로그인한_지_90일이_지나면_받지_않는다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("lifetime_past", "수명").await;
    let base = serve(&app).await;
    let ticket = app.call("POST", "/api/auth/realtime-ticket", None, Some(&cookie)).await.body["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    // Renewed past its end by a server from before the lifetime (a rollback): signed in 91 days ago, 20 days left.
    sqlx::query(
        "UPDATE sessions SET created_at = now() - interval '91 days', expires_at = now() + interval '20 days'
         WHERE token_hash = $1",
    )
    .bind(hash(&cookie))
    .execute(&app.state.db)
    .await
    .unwrap();
    let reply = me(&app, &cookie).await;
    assert_eq!(reply.body["user"], Value::Null);
    assert_eq!(set_cookie(&reply), None);
    let refused = app.call("POST", "/api/auth/realtime-ticket", None, Some(&cookie)).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("login_required")));
    // Nor does a ticket issued before open a socket on it.
    let mut request = format!("{base}/api/rooms/lifetime_past?ticket={ticket}").into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    assert!(connect_async(request).await.is_err());
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
    // Each from an address of its own, so no address's share of the account's budget turns any away.
    let addresses: Vec<String> = (1..=waiting + 1).map(|at| format!("198.51.100.{at}")).collect();
    let attempts = join_all(addresses.iter().map(|address| login_at(&app, address, "in_flight", "a wrong guess")));
    let probe = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        // The checks wait for a hashing slot, and none of them holds the account's budget yet.
        let free = rate_exceeded(&app.state, "login-failed:in_flight", 1).is_ok();
        drop(held);
        free
    };
    let (replies, free) = tokio::join!(attempts, probe);
    assert!(free, "checks under way held the account's budget");
    // A check that waits longer than the hashing wait is turned away as busy, so how many finish depends on the load of
    // the machine. What must hold: every reply is either a check found wrong or busy, and the one more than the
    // checks under way is turned away.
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    let checked = statuses.iter().filter(|status| **status == StatusCode::UNAUTHORIZED).count();
    let busy = replies.iter().filter(|reply| reply.body["code"] == "busy").count();
    assert!(checked > 0 && checked + busy == waiting + 1, "{statuses:?}");
    assert!(busy >= 1, "one check more of the same account at once is turned away: {statuses:?}");
    // Found wrong, exactly these count.
    assert!(rate_exceeded(&app.state, "login-failed:in_flight", checked as u32).is_err());
    assert!(rate_exceeded(&app.state, "login-failed:in_flight", checked as u32 + 1).is_ok());
    // A name nobody has keeps no window of its own; its guesses still cost the address.
    assert_eq!(login_with(&app, "nobody_here", "a wrong guess").await.status, StatusCode::UNAUTHORIZED);
    assert!(rate_exceeded(&app.state, "login-failed:nobody_here", 1).is_ok());
    assert!(rate_exceeded(&app.state, "login-failed-address:local", 1).is_err());
    app.cleanup().await;
}

#[tokio::test]
async fn 주소_몇_개로는_계정_한도를_다_쓰지_못해_새_기기에서도_로그인한다() {
    let app = TestApp::new(None).await;
    app.register("budget_owner", "한도").await;
    // Fifty wrong passwords from two addresses, as many as the account's budget.
    let mut checked = 0;
    for address in ["198.51.100.1", "198.51.100.2"] {
        for _ in 0..25 {
            if login_at(&app, address, "budget_owner", "a wrong guess").await.status == StatusCode::UNAUTHORIZED {
                checked += 1;
            }
        }
    }
    // The owner still signs in with the right password from a browser never used before, elsewhere.
    assert_eq!(login_at(&app, "203.0.113.2", "budget_owner", PASSWORD).await.status, StatusCode::OK);
    // Each address spent ten of the account's fifty and waits out the window, even with the right password.
    assert_eq!(checked, 20);
    let spent = login_at(&app, "198.51.100.1", "budget_owner", PASSWORD).await;
    assert_eq!(spent.status, StatusCode::TOO_MANY_REQUESTS);
    // More addresses spend the rest: browsers the account does not know wait (known ones do not, see above).
    for _ in 0..30 {
        rate_record(&app.state, "login-failed:budget_owner".into());
    }
    assert_eq!(login_at(&app, "203.0.113.3", "budget_owner", PASSWORD).await.status, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;
}

/// From here on permissions cannot be read, as when the database fails in the middle of a sign-in: `auth_tuples`
/// becomes a view whose `subject_relation` raises. The account's role, which the sign-in reads first, never asks for it.
async fn break_permissions(app: &TestApp) {
    for statement in [
        "ALTER TABLE auth_tuples RENAME TO auth_tuples_kept",
        "CREATE FUNCTION unreadable() RETURNS text STABLE LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unreadable'; END $$",
        "CREATE VIEW auth_tuples AS SELECT object_type, object_id, relation, subject_type, subject_id,
         unreadable() AS subject_relation FROM auth_tuples_kept",
    ] {
        sqlx::query(statement).execute(&app.state.db).await.unwrap();
    }
}

async fn mend_permissions(app: &TestApp) {
    for statement in ["DROP VIEW auth_tuples", "ALTER TABLE auth_tuples_kept RENAME TO auth_tuples"] {
        sqlx::query(statement).execute(&app.state.db).await.unwrap();
    }
}

/// Until the transaction it returns ends, permissions cannot be read, as when the database is slow in the middle of a
/// sign-in: it holds `auth_tuples` locked. Making an account never reads it.
async fn hold_permissions(app: &TestApp) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut held = app.state.db.begin().await.unwrap();
    sqlx::query("LOCK TABLE auth_tuples IN ACCESS EXCLUSIVE MODE").execute(&mut *held).await.unwrap();
    held
}

#[tokio::test]
async fn 권한을_읽지_못한_로그인과_가입은_세션을_남기지_않고_다른_기기를_밀어내지_않는다() {
    let app = TestApp::new(None).await;
    let phone = app.register("perm_owner", "권한").await;
    app.register("perm_other", "다른 계정").await;
    app.grant("perm_other", "system:mogaesup", "moderator").await;
    // The account is at its cap, and its phone is the device used least recently.
    age(&app, &phone, 24).await;
    let user = app.user_id("perm_owner").await;
    for at in 1..SESSIONS_PER_USER {
        sqlx::query(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')",
        )
        .bind(hash(&format!("mogaesup_session={at:064x}")))
        .bind(user)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    let before = sessions(&app).await;

    break_permissions(&app).await;
    let body = json!({"username": "perm_owner", "password": PASSWORD});
    let refused = app.call("POST", "/api/auth/login", Some(body), None).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("database")));
    assert_eq!(refused.cookie, None);
    // A sign-up whose sign-in fails says the account is there.
    let body = json!({"username": "perm_late", "password": PASSWORD});
    let late = app.call("POST", "/api/auth/register", Some(body), None).await;
    assert_eq!((late.status, late.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("signed_up")));
    assert_eq!(late.cookie, None);
    // Neither made a session, nor ended the phone's to make room for one.
    assert_eq!(sessions(&app).await, before);
    assert!(days_left(&app, &phone).await.is_some());

    mend_permissions(&app).await;
    assert_eq!(signed_in(&app, &phone).await, "perm_owner");
    login(&app, "perm_late").await;
    app.cleanup().await;
}

#[tokio::test]
async fn 가입_뒤_로그인이_마감까지_끝나지_않아도_가입은_끝났다고_답한다() {
    let app = TestApp::new(None).await;
    let held = hold_permissions(&app).await;
    // The account is made, and its sign-in waits for permissions past the route's deadline. The sign-up answers before
    // it is cut off as busy, which would send the member to sign up again and find the name taken.
    let body = json!({"username": "slow_late", "password": PASSWORD});
    let late = app.call("POST", "/api/auth/register", Some(body.clone()), None).await;
    assert_eq!((late.status, late.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("signed_up")));
    assert_eq!(late.cookie, None);
    assert_eq!(sessions(&app).await, 0);

    held.rollback().await.unwrap();
    let again = app.call("POST", "/api/auth/register", Some(body), None).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::CONFLICT, Some("username_taken")));
    login(&app, "slow_late").await;
    app.cleanup().await;
}

#[tokio::test]
async fn 실시간_티켓은_계정당_10분에_180장까지_나온다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("tickets", "티켓").await;
    // A room and its game socket take one each at every reconnect: two tabs whose connection drops every 25 seconds
    // ask for about a hundred in ten minutes.
    for _ in 0..180 {
        let reply = app.call("POST", "/api/auth/realtime-ticket", None, Some(&cookie)).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let refused = app.call("POST", "/api/auth/realtime-ticket", None, Some(&cookie)).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    app.cleanup().await;
}

#[tokio::test]
async fn 다른_기기_로그아웃은_알려진_기기를_잊지_않는다() {
    let app = TestApp::new(None).await;
    let body = json!({"username": "kept_devices", "password": PASSWORD});
    let registered = app.call("POST", "/api/auth/register", Some(body), None).await;
    let (session, own) = (registered.cookie.clone().unwrap(), device(&registered));
    let other = device(&login_with(&app, "kept_devices", PASSWORD).await);
    // Whoever holds this session signs the other devices out: the owner's devices keep the budget of their own, so
    // guesses at the account cannot shut the owner out of the devices they use.
    let out = logout_others(&app, &format!("{session}; {own}"), PASSWORD).await;
    assert_eq!((out.status, out.body["ended"].as_i64()), (StatusCode::OK, Some(1)));
    assert_eq!(pair(&set_cookies(&out.headers), "mogaesup_device"), None, "the devices are left as they are");
    let known: i64 = sqlx::query_scalar("SELECT count(*) FROM login_devices").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(known, 2);
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:kept_devices".into());
    }
    assert_eq!(login_from(&app, None, "kept_devices", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(login_from(&app, Some(&other), "kept_devices", PASSWORD).await, StatusCode::OK);
    app.cleanup().await;
}

/// A device cookie for `id` signed for account `name`, as one given before devices were recorded would be.
fn signed_before(name: &str, id: &str) -> String {
    let signature = hmac_sha256(common::TICKET_SECRET, format!("login-device\0{name}\0{id}").as_bytes());
    format!("mogaesup_device={id}.{}", hex::encode(signature))
}

#[tokio::test]
async fn 기기를_적기_전에_받은_기기_쿠키는_비밀번호를_바꾸기_전까지_알려진_기기다() {
    let app = TestApp::new(None).await;
    app.register("older_device", "예전 기기").await;
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:older_device".into());
    }
    // Signed for the account, never recorded: given before devices were. It still has a budget of its own, and signing
    // in with it records it.
    let before = signed_before("older_device", &"a".repeat(32));
    let credentials = json!({"username": "older_device", "password": PASSWORD});
    let signed = app.call("POST", "/api/auth/login", Some(credentials), Some(&before)).await;
    assert_eq!(signed.status, StatusCode::OK);
    let recorded: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM login_devices WHERE device_id = $1)")
        .bind("a".repeat(32))
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(recorded);
    // A forged one, or one signed for another account, is not.
    let forged = format!("{}0", &before[..before.len() - 1]);
    let forged = if forged == before { format!("{}1", &before[..before.len() - 1]) } else { forged };
    assert_eq!(login_from(&app, Some(&forged), "older_device", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    let elsewhere = signed_before("someone_else", &"c".repeat(32));
    assert_eq!(login_from(&app, Some(&elsewhere), "older_device", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);

    // A password change forgets every device but its own, and with them every cookie the table does not hold.
    let session = signed.cookie.unwrap();
    let body = json!({"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD});
    let changed = app.call("POST", "/api/auth/password", Some(body), Some(&format!("{session}; {before}"))).await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT);
    let another = signed_before("older_device", &"b".repeat(32));
    assert_eq!(login_from(&app, Some(&another), "older_device", NEW_PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(login_from(&app, Some(&before), "older_device", NEW_PASSWORD).await, StatusCode::OK);
    app.cleanup().await;

    // An account holding its full count of devices forgot the oldest: an unrecorded cookie may be one of those.
    let app = TestApp::new(None).await;
    app.register("full_devices", "기기 가득").await;
    let user = app.user_id("full_devices").await;
    sqlx::query("DELETE FROM login_devices").execute(&app.state.db).await.unwrap();
    sqlx::query(
        "INSERT INTO login_devices (user_id, device_id) SELECT $1, 'device-' || n FROM generate_series(1, $2) n",
    )
    .bind(user)
    .bind(DEVICES_PER_USER as i32)
    .execute(&app.state.db)
    .await
    .unwrap();
    for _ in 0..50 {
        rate_record(&app.state, "login-failed:full_devices".into());
    }
    let older = signed_before("full_devices", &"d".repeat(32));
    assert_eq!(login_from(&app, Some(&older), "full_devices", PASSWORD).await, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;
}

fn login_request(username: &str, password: &str, address: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", address)
        .body(Body::from(json!({"username": username, "password": password}).to_string()))
        .unwrap()
}

/// Waits until `check` holds, for at most `wait`; whether it did.
async fn until(wait: Duration, check: impl Fn() -> bool) -> bool {
    let started = std::time::Instant::now();
    while !check() {
        if started.elapsed() > wait {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    true
}

#[tokio::test]
async fn 확인하던_중에_끊긴_요청의_틀린_비밀번호도_센다() {
    let app = TestApp::new(None).await;
    app.register("cut_short", "끊김").await;
    let wrong = || login_request("cut_short", "a wrong guess", "203.0.113.20");
    // Given up while it waits for a hashing slot, a check ran nothing and costs nothing.
    let held = app.state.hashing.clone().acquire_many_owned(2).await.unwrap();
    let waiting = tokio::spawn(app.router.clone().oneshot(wrong()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    drop(held);
    assert_eq!(app.state.hashing.available_permits(), 2);
    assert!(rate_exceeded(&app.state, "login-failed:cut_short", 1).is_ok());
    // Given up once argon2 runs, it runs to its end, the wrong password counts, and only then is its slot let go.
    let running = tokio::spawn(app.router.clone().oneshot(wrong()));
    let hashing = app.state.hashing.clone();
    assert!(until(Duration::from_secs(10), || hashing.available_permits() < 2).await, "the check started");
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert!(until(Duration::from_secs(60), || hashing.available_permits() == 2).await, "the check ended");
    assert!(rate_exceeded(&app.state, "login-failed:cut_short", 1).is_err());
    assert!(rate_exceeded(&app.state, "login-failed-address:203.0.113.20", 1).is_err());
    app.cleanup().await;
}

#[tokio::test]
async fn 없는_아이디의_확인은_주소마다_하나_모두_둘까지만_기다리고_회원의_로그인은_막지_않는다() {
    let app = TestApp::new(None).await;
    app.register("real_member", "회원").await;
    let held = app.state.hashing.clone().acquire_many_owned(2).await.unwrap();
    let wait_in_line = |name: &str, password: &str, address: &str| {
        tokio::spawn(app.router.clone().oneshot(login_request(name, password, address)))
    };
    let first = wait_in_line("ghost_a", "a wrong guess", "203.0.113.1");
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Another made-up name from the same address is turned away at once instead of joining the queue.
    let started = std::time::Instant::now();
    let same = app.send(login_request("ghost_b", "a wrong guess", "203.0.113.1")).await;
    assert_eq!((same.status, same.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("busy")));
    let second = wait_in_line("ghost_c", "a wrong guess", "203.0.113.2");
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Two of them wait at most, whatever the address.
    let third = app.send(login_request("ghost_d", "a wrong guess", "203.0.113.3")).await;
    assert_eq!((third.status, third.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("busy")));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    // A member's own sign-in still waits its turn for a hashing slot.
    let member = wait_in_line("real_member", PASSWORD, "203.0.113.3");
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(held);
    for ghost in [first, second] {
        assert_eq!(ghost.await.unwrap().unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(member.await.unwrap().unwrap().status(), StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 실제_라우터는_보통의_api에_기한을_둔다() {
    // The real router, with a deadline short enough to see: a sign-in stuck behind the hashing slots is answered when
    // it runs out, and lets go of its place.
    let app = TestApp::tuned(None, |state| state.request_deadline = Duration::from_millis(300)).await;
    let member = app.quick_member("deadline").await;
    let held = app.state.hashing.clone().acquire_many_owned(2).await.unwrap();
    let started = std::time::Instant::now();
    let stuck = app.send(login_request("deadline", PASSWORD, "203.0.113.30")).await;
    assert_eq!((stuck.status, stuck.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("timeout")));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    drop(held);
    // Within it, everything else answers as usual. The health answer names the commit the binary was built from.
    let health = app.call("GET", "/api/health", None, None).await;
    assert_eq!(health.status, StatusCode::OK);
    assert!(health.body.as_object().is_some_and(|body| body.contains_key("commit")), "{:?}", health.body);
    assert_eq!(health.body["commit"], json!(mogaesup_server::COMMIT));
    assert_eq!(signed_in(&app, &member).await, "deadline");
    let refused = login_with(&app, "deadline", PASSWORD).await;
    assert_eq!(
        (refused.status, refused.body["code"].as_str()),
        (StatusCode::UNAUTHORIZED, Some("invalid_credentials"))
    );
    app.cleanup().await;
}
