mod common;

use axum::http::{StatusCode, header};
use common::{Reply, TestApp};
use mogaesup_server::auth::SESSIONS_PER_USER;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
