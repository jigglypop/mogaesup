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

/// 궁합 is judged by the two 일간 after 천간합 and 육합, not by the homes' dominant elements, which stay the gift's from
/// and to. Here both homes lean to earth, but 壬 (water) gives rise to 甲 (wood): a flow, not a likeness.
#[tokio::test]
async fn 궁합은_두_집의_기운이_아니라_두_일간으로_본다() {
    let app = TestApp::new(None).await;
    let sender = app.register("day_sender", "손님").await;
    let owner = app.register("day_owner", "주인").await;
    let sender_id = app.user_id("day_sender").await;
    let owner_id = app.user_id("day_owner").await;
    let mine = build(&app, &sender, sender_id, 7).await;
    let theirs = build(&app, &owner, owner_id, 12).await;
    // No 천간합 (壬甲) and no 육합 (辰辰); earth five times in each.
    let gift = |tone: &str| {
        json!({"expectedGiverId": sender_id, "giverBirth": mine, "recipientBirth": theirs,
            "giverPillars": ["戊辰", "戊戌", "壬辰"], "recipientPillars": ["戊辰", "戊戌", "甲辰"],
            "design": {"tone": tone, "from": "earth", "to": "earth"}})
    };
    let path = "/api/homes/day_owner/saju/gifts";
    for refused in ["same", "union", "spark"] {
        let reply = app.call("POST", path, Some(gift(refused)), Some(&sender)).await;
        assert_eq!(reply.body["code"], "invalid_gift", "{refused}");
    }
    assert_eq!(app.call("POST", path, Some(gift("flow")), Some(&sender)).await.status, StatusCode::NO_CONTENT);
    let received = app.call("GET", "/api/homes/day_owner/saju/decor", None, Some(&owner)).await;
    assert_eq!(received.body["gifts"][0]["design"], json!({"tone": "flow", "from": "earth", "to": "earth"}));
    app.cleanup().await;
}

/// A gift names the recipient's birth and is held against the stored one, so a home whose owner has not agreed to share
/// their 사주 must not say whether a guessed birth is theirs: the right birth and a wrong one get the same answer.
#[tokio::test]
async fn 사주를_나누지_않은_집에는_선물이_가지_않고_생일을_맞혔는지도_알려지지_않는다() {
    let app = TestApp::new(None).await;
    let sender = app.register("guess_sender", "손님").await;
    let owner = app.register("guess_owner", "주인").await;
    let sender_id = app.user_id("guess_sender").await;
    let owner_id = app.user_id("guess_owner").await;
    let mine = build(&app, &sender, sender_id, 7).await;
    let theirs = build(&app, &owner, owner_id, 12).await;
    sqlx::query("UPDATE users SET saju_share_consent_at = NULL WHERE id = $1")
        .bind(owner_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let design = json!({"from": "fire", "to": "water", "tone": "union"});
    let gift = json!({"expectedGiverId": sender_id, "giverBirth": mine, "recipientBirth": theirs,
        "giverPillars": ["辛未", "癸巳", "丁丑"], "recipientPillars": ["辛未", "癸巳", "壬午"], "design": design,
        "x": 1.0, "z": 1.0});
    let path = "/api/homes/guess_owner/saju/gifts";
    let right = app.call("POST", path, Some(gift.clone()), Some(&sender)).await;
    let mut guess = gift.clone();
    guess["recipientBirth"]["day"] = json!(11);
    let wrong = app.call("POST", path, Some(guess), Some(&sender)).await;
    assert_eq!((right.status, &right.body["code"]), (StatusCode::CONFLICT, &json!("no_home")), "{:?}", right.body);
    assert_eq!((wrong.status, &wrong.body["code"]), (right.status, &right.body["code"]));
    let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM saju_gifts").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(kept, 0);
    assert_eq!(app.call("GET", "/api/homes/guess_owner/saju/decor", None, None).await.body["items"], json!([]));

    // Once the owner agrees, the same gift arrives.
    let agreed = json!({"expectedOwnerId": owner_id, "sajuShareConsent": true});
    assert_eq!(app.call("PATCH", "/api/homes/me", Some(agreed), Some(&owner)).await.status, StatusCode::OK);
    assert_eq!(app.call("POST", path, Some(gift), Some(&sender)).await.status, StatusCode::NO_CONTENT);
    app.cleanup().await;
}

/// Each pair of births makes a keepsake of its own, so a home's keepsakes can grow without end: its owner reads the
/// newest hundred and the placed ones, and a visitor only the placed ones.
#[tokio::test]
async fn 주인은_최근_선물_백_개와_놓인_선물을_읽는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("many_gifts", "주인").await;
    app.register("many_giver", "손님").await;
    let owner_id = app.user_id("many_gifts").await;
    let giver_id = app.user_id("many_giver").await;
    build(&app, &owner, owner_id, 12).await;
    // 120 keepsakes, the first the oldest.
    sqlx::query(
        "INSERT INTO saju_gifts (id, owner_id, giver_id, pair_key, tone, from_element, to_element, created_at)
         SELECT md5(n::text)::uuid, $1, $2, decode(md5(n::text), 'hex'), 'union', 'fire', 'water',
                now() - make_interval(mins => 200 - n)
         FROM generate_series(1, 120) AS n",
    )
    .bind(owner_id)
    .bind(giver_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let oldest: uuid::Uuid = sqlx::query_scalar("SELECT md5('1')::uuid").fetch_one(&app.state.db).await.unwrap();
    let decor = "/api/homes/many_gifts/saju/decor";
    let read = app.call("GET", decor, None, Some(&owner)).await;
    let gifts = read.body["gifts"].as_array().unwrap();
    assert_eq!(gifts.len(), 100);
    assert!(gifts.iter().all(|gift| gift["id"] != json!(oldest)));

    let items = json!([{"id": "old", "kind": "gift", "ref": oldest, "x": 0, "z": 0, "turn": 0}]);
    let place = json!({"expectedOwnerId": owner_id, "items": items});
    let saved = app.call("PUT", "/api/homes/me/saju/decor", Some(place), Some(&owner)).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    let gifts = saved.body["gifts"].as_array().unwrap();
    assert_eq!(gifts.len(), 101);
    assert_eq!(gifts.last().unwrap()["id"], json!(oldest));
    let shown = app.call("GET", decor, None, None).await;
    assert_eq!(shown.body["gifts"].as_array().map(Vec::len), Some(1));
    app.cleanup().await;
}
