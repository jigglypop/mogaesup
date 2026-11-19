mod common;

use axum::http::StatusCode;
use common::TestApp;
use serde_json::{Value, json};
use uuid::Uuid;

async fn build(app: &TestApp, cookie: &str, id: Uuid, day: u8) -> Value {
    let birth = json!({"calendar": "solar", "year": 1991, "month": 5, "day": day, "leapMonth": false,
        "time": null, "gender": "female"});
    let save = json!({"expectedOwnerId": id, "name": "집", "birth": birth});
    assert_eq!(app.call("PUT", "/api/homes/me/saju", Some(save), Some(cookie)).await.status, StatusCode::OK);
    birth
}

#[tokio::test]
async fn 궁합_선물은_두_사주에_한번_도착하고_받은_주인만_놓는다() {
    let app = TestApp::new(None).await;
    let sender = app.register("pair_sender", "손님").await;
    let owner = app.register("pair_owner", "주인").await;
    let sender_id = app.user_id("pair_sender").await;
    let owner_id = app.user_id("pair_owner").await;
    let mine = build(&app, &sender, sender_id, 7).await;
    let theirs = build(&app, &owner, owner_id, 12).await;
    let design = json!({"from": "fire", "to": "water", "tone": "union"});
    let gift = json!({"expectedGiverId": sender_id, "giverBirth": mine, "recipientBirth": theirs,
        "giverPillars": ["辛未", "癸巳", "丁丑"], "recipientPillars": ["辛未", "癸巳", "壬午"], "design": design});
    let path = "/api/homes/pair_owner/saju/gifts";
    let decor = "/api/homes/pair_owner/saju/decor";

    assert_eq!(app.call("POST", path, Some(gift.clone()), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("POST", path, Some(gift.clone()), Some(&owner)).await.body["code"], "owner_changed");
    let mut stale = gift.clone();
    stale["recipientBirth"]["day"] = json!(11);
    assert_eq!(app.call("POST", path, Some(stale), Some(&sender)).await.body["code"], "stale_birth");
    let mut forged = gift.clone();
    forged["design"]["tone"] = json!("flow");
    assert_eq!(app.call("POST", path, Some(forged), Some(&sender)).await.body["code"], "invalid_gift");
    let (first, retry) = tokio::join!(
        app.call("POST", path, Some(gift.clone()), Some(&sender)),
        app.call("POST", path, Some(gift.clone()), Some(&sender)),
    );
    assert_eq!((first.status, retry.status), (StatusCode::NO_CONTENT, StatusCode::NO_CONTENT));
    let received = app.call("GET", decor, None, Some(&owner)).await;
    let received = received.body["gifts"].as_array().unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0]["design"], design);
    assert_eq!(received[0]["giver"]["username"], "pair_sender");
    assert!(app.call("GET", decor, None, Some(&sender)).await.body["gifts"].is_null());
    let mut spot = gift.clone();
    spot["x"] = json!(3.0);
    spot["z"] = json!(-2.0);
    assert_eq!(app.call("POST", path, Some(spot), Some(&sender)).await.status, StatusCode::NO_CONTENT);
    let left = app.call("GET", decor, None, None).await.body;
    assert_eq!(left["items"][0]["kind"], "gift");
    assert_eq!(left["items"][0]["ref"], received[0]["id"]);
    assert_eq!(left["items"][0]["x"], 3.0);
    assert!(left["gifts"].as_array().unwrap().len() == 1);
    let mut far = gift.clone();
    far["x"] = json!(80.0);
    far["z"] = json!(0.0);
    assert_eq!(app.call("POST", path, Some(far), Some(&sender)).await.body["code"], "invalid_gift");
    let items = json!([{"kind": "gift", "ref": received[0]["id"], "id": "placed", "x": 2.2, "z": -4, "turn": 0}]);
    let place = "/api/homes/me/saju/decor";
    let stolen = json!({"expectedOwnerId": sender_id, "items": items});
    assert_eq!(app.call("PUT", place, Some(stolen), Some(&sender)).await.body["code"], "invalid_decor");
    let saved = json!({"expectedOwnerId": owner_id, "items": items});
    assert_eq!(app.call("PUT", place, Some(saved), Some(&owner)).await.status, StatusCode::OK);
    let displayed = app.call("GET", decor, None, None).await;
    assert_eq!(displayed.body["items"], items);
    assert_eq!(displayed.body["gifts"][0]["id"], received[0]["id"]);

    let private = json!({"expectedOwnerId": owner_id, "visibility": "private"});
    assert_eq!(app.call("PATCH", "/api/homes/me", Some(private), Some(&owner)).await.status, StatusCode::OK);
    assert_eq!(app.call("POST", path, Some(gift), Some(&sender)).await.status, StatusCode::FORBIDDEN);
    app.cleanup().await;
}
