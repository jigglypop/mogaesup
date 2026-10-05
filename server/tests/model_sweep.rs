//! The model store keeps what the database refers to and lets go of the rest once it is old.

mod common;

use axum::http::StatusCode;
use common::TestApp;
use mogaesup_server::models::SWEEP_AGE;
use serde_json::json;
use std::time::{Duration, SystemTime};

/// The stored file behind `url`, made `age` old.
fn age(app: &TestApp, url: &str, age: Duration) {
    let path = app.model_dir.join(url.strip_prefix("/models/").unwrap());
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

fn exists(app: &TestApp, url: &str) -> bool {
    app.model_dir.join(url.strip_prefix("/models/").unwrap()).exists()
}

#[tokio::test]
async fn 아무도_쓰지_않는_오래된_파일만_치운다() {
    let app = TestApp::new(None).await;
    let owner = app.register("sweep_owner", "Owner").await;
    let owner_id = app.user_id("sweep_owner").await;
    let models = &app.state.config.models;
    let put = |bytes: &'static [u8], extension: &'static str| models.put(extension, bytes.to_vec());
    let look = put(b"look model", "glb").await.unwrap();
    let picture = put(b"island picture", "jpg").await.unwrap();
    let placed = put(b"placed model", "glb").await.unwrap();
    let item = put(b"catalog model", "glb").await.unwrap();
    let version = put(b"older catalog model", "glb").await.unwrap();
    let orphan = put(b"a look baked over", "glb").await.unwrap();
    let young = put(b"a bake not recorded yet", "glb").await.unwrap();

    sqlx::query("INSERT INTO user_looks (user_id, request, status, model_url) VALUES ($1, '{}', 'ready', $2)")
        .bind(owner_id)
        .bind(&look)
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE homes SET thumbnail_url = $2 WHERE owner_id = $1")
        .bind(owner_id)
        .bind(&picture)
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, source, status) VALUES ('swept', 'furniture', 'x', 'x', $1, 'factory', 'published')",
    )
    .bind(&item)
    .execute(&app.state.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO catalog_versions (item_id, model_url) VALUES ('swept', $1)")
        .bind(&version)
        .execute(&app.state.db)
        .await
        .unwrap();
    let world = json!({"worldId": "main", "baseRevision": 0, "data": {"version": 1, "savedAt": 1,
        "domains": {"building": {"objects": [{"modelUrl": placed}]}}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(&owner)).await.status, StatusCode::OK);

    let two_days = Duration::from_secs(2 * 24 * 60 * 60);
    for url in [&look, &picture, &placed, &item, &version, &orphan] {
        age(&app, url, two_days);
    }
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 1);
    assert!(!exists(&app, &orphan), "an old file nothing refers to goes");
    for url in [&look, &picture, &placed, &item, &version, &young] {
        assert!(exists(&app, url), "{url} stays");
    }
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 0);

    // A file stored again long after it was first stored starts its age over, so a sweep never takes it from the row
    // about to refer to it.
    age(&app, &young, two_days);
    assert_eq!(put(b"a bake not recorded yet", "glb").await.unwrap(), young);
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 0);
    assert!(exists(&app, &young));
    app.cleanup().await;
}
