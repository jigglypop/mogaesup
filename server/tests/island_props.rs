mod common;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use axum::http::StatusCode;
use common::TestApp;
use mogaesup_server::{MIGRATOR, homes::safe_asset_url};
use serde_json::{Value, json};

/// Rows frontend/scripts/props-catalog.mjs wrote into a migration, one `('prop-…` per prop.
fn seeded(sql: &str) -> usize {
    sql.matches("('prop-").count()
}

#[tokio::test]
async fn 생성한_섬_기물은_공개된_기본_가구이고_앱이_모델과_그림을_낸다() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let public = repo.join("frontend/public");
    let manifest: Value =
        serde_json::from_str(&fs::read_to_string(repo.join("scripts/props/manifest.json")).unwrap()).unwrap();
    let names: HashMap<&str, &str> = manifest["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["id"].as_str().unwrap(), item["name"].as_str().unwrap()))
        .collect();
    let first = MIGRATOR.iter().find(|migration| migration.description == "island props").unwrap();
    assert_eq!(seeded(&first.sql), 69);
    let expected: usize = MIGRATOR.iter().map(|migration| seeded(&migration.sql)).sum();

    let app = TestApp::new(None).await;
    let listed = app.call("GET", "/api/catalog/items?kind=furniture", None, None).await;
    let props: Vec<&Value> =
        listed.body["items"].as_array().unwrap().iter().filter(|item| item["source"] == "builtin").collect();
    assert_eq!(props.len(), expected);
    let mut last_order = 0;
    for item in &props {
        let id = item["id"].as_str().unwrap();
        let stem = id.strip_prefix("prop-").unwrap_or_else(|| panic!("{id}: not a generated prop"));
        assert_eq!(item["label"].as_str(), names.get(stem).copied(), "{id}: label is the manifest name");
        assert_eq!((item["kind"].as_str(), item["status"].as_str()), (Some("furniture"), Some("published")), "{id}");
        assert_eq!(item["clips"], json!([]), "{id}");
        let model = item["modelUrl"].as_str().unwrap();
        let picture = item["thumbnailUrl"].as_str().unwrap();
        assert_eq!(model, format!("/gltf/decor/{stem}.glb"));
        assert_eq!(picture, format!("/gltf/decor/thumbs/{stem}.webp"));
        // Islands may keep the URL, and the app ships both files.
        assert!(safe_asset_url(model), "{id}");
        let glb = fs::read(public.join(model.trim_start_matches('/'))).unwrap_or_else(|_| panic!("{id}: no {model}"));
        assert_eq!(&glb[..4], b"glTF", "{id}");
        let webp =
            fs::read(public.join(picture.trim_start_matches('/'))).unwrap_or_else(|_| panic!("{id}: no {picture}"));
        assert_eq!((&webp[..4], &webp[8..12]), (&b"RIFF"[..], &b"WEBP"[..]), "{id}");
        // After the furniture copied in from the studio (100), shelf by shelf.
        let order = item["sortOrder"].as_i64().unwrap();
        assert!(order >= 2000 && order >= last_order, "{id}: {order}");
        last_order = order;
    }
    assert_eq!(props[0]["id"], "prop-door-basic");
    // One shelf, so no two may share a name.
    let labels: HashSet<&str> = props.iter().map(|item| item["label"].as_str().unwrap()).collect();
    assert_eq!(labels.len(), props.len(), "duplicate prop names");

    // Admins retire, rename and publish them like any item, and running the rows again keeps what they changed.
    let admin = app.register("operator_p", "운영자").await;
    app.make_admin("operator_p").await;
    let retired = app
        .call(
            "POST",
            "/api/catalog/admin/bulk-status",
            Some(json!({"ids": ["prop-door-basic", "prop-nature-lily"], "status": "retired"})),
            Some(&admin),
        )
        .await;
    assert_eq!(retired.status, StatusCode::OK, "{:?}", retired.body);
    assert!(retired.body["items"].as_array().unwrap().iter().all(|item| item["status"] == "retired"));
    let renamed = app
        .call(
            "PATCH",
            "/api/catalog/admin/items/prop-nature-lily",
            Some(json!({"label": "연잎 꽃", "status": "published"})),
            Some(&admin),
        )
        .await;
    assert_eq!((renamed.body["label"].as_str(), renamed.body["source"].as_str()), (Some("연잎 꽃"), Some("builtin")));
    sqlx::raw_sql(&first.sql).execute(&app.state.db).await.unwrap();
    let listed = app.call("GET", "/api/catalog/items?kind=furniture", None, None).await;
    let shown: HashMap<&str, &str> = listed.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["id"].as_str().unwrap(), item["label"].as_str().unwrap()))
        .collect();
    assert_eq!(shown.len(), expected - 1);
    assert!(!shown.contains_key("prop-door-basic"));
    assert_eq!(shown.get("prop-nature-lily"), Some(&"연잎 꽃"));
    app.cleanup().await;
}
