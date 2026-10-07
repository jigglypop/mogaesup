//! The speech balloon a member talks in: one of the app's designs, kept with the home's profile and shown to anyone
//! who may see the island.

mod common;

use std::{fs, path::Path};

use axum::http::StatusCode;
use common::TestApp;
use mogaesup_server::homes::BALLOONS;
use serde_json::{Value, json};

#[test]
fn 말풍선_목록은_앱의_디자인과_같은_순서다() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let designs: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(repo.join("frontend/src/minihome/balloons/designs.json")).unwrap())
            .unwrap();
    let ids: Vec<&str> = designs.iter().map(|design| design["id"].as_str().unwrap()).collect();
    assert_eq!(ids, BALLOONS);
    // The column's check keeps this shape (migrations/20261008100000_balloons.sql).
    for id in BALLOONS {
        let mut chars = id.chars();
        assert!(chars.next().is_some_and(|c| c.is_ascii_lowercase()), "{id}");
        assert!(id.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{id}");
    }
}

#[tokio::test]
async fn 말풍선은_정해진_것만_고르고_기본은_유리다() {
    let app = TestApp::new(None).await;
    let owner = app.register("balloon_owner", "주인").await;
    let visitor = app.register("balloon_visitor", "손님").await;
    let home = app.call("GET", "/api/homes/me", None, Some(&owner)).await;
    assert_eq!(home.body["profile"]["balloon"], "glass");
    let before = home.body["profile"].clone();

    let picked = app.call("PATCH", "/api/homes/me", Some(json!({"balloon": "cloud"})), Some(&owner)).await;
    assert_eq!(picked.status, StatusCode::OK, "{:?}", picked.body);
    assert_eq!(picked.body["profile"]["balloon"], "cloud");
    for field in ["title", "statusMessage", "mood", "minime", "emoji", "visibility"] {
        assert_eq!(picked.body["profile"][field], before[field], "{field}");
    }

    for refused in [json!("neon"), json!("Cloud"), json!(" cloud"), json!(""), json!(7)] {
        let reply = app.call("PATCH", "/api/homes/me", Some(json!({"balloon": refused})), Some(&owner)).await;
        assert!(reply.status.is_client_error(), "{refused}: {:?}", reply.body);
        if refused.is_string() {
            assert_eq!(reply.body["code"], "invalid_balloon", "{refused}");
        }
    }
    // Other changes leave it as it is.
    let mood = app.call("PATCH", "/api/homes/me", Some(json!({"mood": 1})), Some(&owner)).await;
    assert_eq!(
        (mood.body["profile"]["balloon"].as_str(), mood.body["profile"]["mood"].as_i64()),
        (Some("cloud"), Some(1))
    );

    // The island's page shows it to visitors, and to people signed out.
    let seen = app.call("GET", "/api/homes/balloon_owner", None, Some(&visitor)).await;
    assert_eq!(seen.body["profile"]["balloon"], "cloud");
    let anonymous = app.call("GET", "/api/homes/balloon_owner", None, None).await;
    assert_eq!(anonymous.body["profile"]["balloon"], "cloud");
    // A visitor's own island still starts with the default.
    let theirs = app.call("GET", "/api/homes/balloon_visitor", None, Some(&visitor)).await;
    assert_eq!(theirs.body["profile"]["balloon"], "glass");

    // Every design can be picked.
    for id in BALLOONS {
        let reply = app.call("PATCH", "/api/homes/me", Some(json!({"balloon": id})), Some(&owner)).await;
        assert_eq!(reply.body["profile"]["balloon"], id);
    }
    app.cleanup().await;
}
