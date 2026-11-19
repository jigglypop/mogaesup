mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn 로그인한_회원은_공용섬을_만들고_누구나_연다() {
    let app = TestApp::new(None).await;
    assert_eq!(
        app.call("POST", "/api/islands", Some(json!({"title": "호수"})), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let cookie = app.register("island_maker", "만든이").await;
    assert_eq!(
        app.call("POST", "/api/islands", Some(json!({"title": " "})), Some(&cookie)).await.body["code"],
        "invalid_title"
    );
    let made = app.call("POST", "/api/islands", Some(json!({"title": " 호수 "})), Some(&cookie)).await;
    assert_eq!(made.status, StatusCode::CREATED, "{:?}", made.body);
    assert_eq!(made.body["title"], "호수");
    assert_eq!(made.body["creator"], "island_maker");
    let slug = made.body["slug"].as_str().unwrap();
    let opened = app.call("GET", &format!("/api/islands/{slug}"), None, None).await;
    assert_eq!(opened.status, StatusCode::OK);
    assert_eq!(opened.body["id"], made.body["id"]);
    let list = app.call("GET", "/api/islands", None, None).await;
    assert_eq!(list.body["islands"][0]["slug"], slug);
    assert_eq!(app.call("GET", "/api/islands/nope", None, None).await.status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}
