mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn 사주는_동의한_뒤에만_남에게_보인다() {
    let app = TestApp::new(None).await;
    let host = app.register("share_host", "주인").await;
    let id = app.user_id("share_host").await;
    sqlx::query("UPDATE users SET saju_share_consent_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let birth = json!({"calendar": "solar", "year": 1991, "month": 3, "day": 2, "leapMonth": false, "time": null, "gender": "male"});
    let built = app
        .call(
            "PUT",
            "/api/homes/me/saju",
            Some(json!({"expectedOwnerId": id, "name": "가온", "birth": birth})),
            Some(&host),
        )
        .await;
    assert_eq!(built.status, StatusCode::OK, "{:?}", built.body);

    let closed = app
        .call("PATCH", "/api/homes/me", Some(json!({"expectedOwnerId": id, "visibility": "public"})), Some(&host))
        .await;
    assert_eq!(closed.status, StatusCode::CONFLICT, "{:?}", closed.body);
    assert_eq!(closed.body["code"], "consent_required");

    let hidden = app.call("GET", "/api/homes/share_host/saju", None, None).await;
    assert_eq!(hidden.status, StatusCode::OK, "{:?}", hidden.body);
    assert!(hidden.body["saju"].is_null());
    let owner = app.call("GET", "/api/homes/share_host/saju", None, Some(&host)).await;
    assert_eq!(owner.body["saju"]["name"], "가온");
    assert_eq!(app.call("GET", "/api/homes/share_host/saju/reading", None, None).await.body["status"], "none");

    let agreed = app
        .call(
            "PATCH",
            "/api/homes/me",
            Some(json!({"expectedOwnerId": id, "visibility": "public", "sajuShareConsent": true, "displayName": "가온이"})),
            Some(&host),
        )
        .await;
    assert_eq!(agreed.status, StatusCode::OK, "{:?}", agreed.body);
    assert_eq!(agreed.body["profile"]["sajuShareConsent"], true);
    assert_eq!(agreed.body["profile"]["ownerName"], "가온이");
    let shown = app.call("GET", "/api/homes/share_host/saju", None, None).await;
    assert_eq!(shown.body["saju"]["name"], "가온");
    app.cleanup().await;
}
