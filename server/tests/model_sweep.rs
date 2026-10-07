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

#[tokio::test]
async fn 섬이_쓰는_파일은_저장할_때_읽어_둔_목록으로_지키고_예전_판의_섬은_글로_찾는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("refs_owner", "Owner").await;
    let models = &app.state.config.models;
    let placed = models.put("glb", b"placed on the island".to_vec()).await.unwrap();
    let cover = models.put("png", b"named outside the domains".to_vec()).await.unwrap();
    let orphan = models.put("glb", b"placed no more".to_vec()).await.unwrap();
    let world = json!({"worldId": "main", "baseRevision": 0, "data": {"version": 1, "savedAt": 1, "meta": {"note": cover},
        "domains": {"building": {"objects": [{"modelUrl": placed}]}}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(&owner)).await.status, StatusCode::OK);
    let (refs, revision): (Vec<String>, i64) =
        sqlx::query_as("SELECT model_refs, model_refs_revision FROM home_worlds")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    let mut expected = vec![placed.clone(), cover.clone()];
    expected.sort();
    assert_eq!((refs, revision), (expected, 1));

    let two_days = Duration::from_secs(2 * 24 * 60 * 60);
    for url in [&placed, &cover, &orphan] {
        age(&app, url, two_days);
    }
    // The list read at the save stands for the world's revision: a model only its text names (as a save by an earlier
    // release could have left it, with no list) is not taken for it.
    sqlx::query("UPDATE home_worlds SET data = jsonb_set(data, '{meta,extra}', to_jsonb($1::text))")
        .bind(&orphan)
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 1);
    assert!(!exists(&app, &orphan));
    assert!(exists(&app, &placed) && exists(&app, &cover));

    // A world saved by a release that kept no list, or whose list is of another revision, is searched as text.
    let older = models.put("glb", b"named by an older save".to_vec()).await.unwrap();
    age(&app, &older, two_days);
    sqlx::query(
        "UPDATE home_worlds SET data = jsonb_set(data, '{meta,extra}', to_jsonb($1::text)), revision = revision + 1",
    )
    .bind(&older)
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 0);
    assert!(exists(&app, &older) && exists(&app, &placed) && exists(&app, &cover));
    app.cleanup().await;
}

#[tokio::test]
async fn 펫_품종의_모델과_그림은_치우지_않는다() {
    let app = TestApp::new(None).await;
    let models = &app.state.config.models;
    let model = models.put("glb", b"a studio dog copied in".to_vec()).await.unwrap();
    let picture = models.put("webp", b"its picture".to_vec()).await.unwrap();
    let orphan = models.put("glb", b"a dog copied in again".to_vec()).await.unwrap();
    sqlx::query(
        "INSERT INTO pet_breeds (id, label, model_url, thumbnail_url, source, status)
         VALUES ('swept-dog', 'x', $1, $2, 'factory', 'draft')",
    )
    .bind(&model)
    .bind(&picture)
    .execute(&app.state.db)
    .await
    .unwrap();
    let two_days = Duration::from_secs(2 * 24 * 60 * 60);
    for url in [&model, &picture, &orphan] {
        age(&app, url, two_days);
    }
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 1);
    assert!(!exists(&app, &orphan));
    assert!(exists(&app, &model) && exists(&app, &picture), "a breed's files stay, published or not");
    app.cleanup().await;
}
