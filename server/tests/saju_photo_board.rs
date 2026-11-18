mod common;

use axum::http::{StatusCode, header};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::TestApp;
use image::{ImageFormat, RgbImage};
use serde_json::json;
use std::io::Cursor;

const PATH: &str = "/api/homes/me/saju/photo-board";
const HOST: &str = "/api/homes/board_host/saju";

fn photo(width: u32, height: u32) -> String {
    let mut data = Cursor::new(Vec::new());
    RgbImage::new(width, height).write_to(&mut data, ImageFormat::Jpeg).unwrap();
    let mut bytes = data.into_inner();
    // A JPEG comment containing text that must never reach the served file.
    bytes.splice(2..2, [0xff, 0xfe, 0x00, 0x09, b'p', b'r', b'i', b'v', b'a', b't', b'e']);
    format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))
}

#[tokio::test]
async fn 전광판은_주인만_편집하고_사진_주소에도_집_공개_범위가_적용된다() {
    let app = TestApp::new(None).await;
    let owner = app.register("board_host", "주인").await;
    let visitor = app.register("board_visitor", "손님").await;
    let owner_id = app.user_id("board_host").await;
    let put = |image: String| Some(json!({"expectedOwnerId": owner_id, "image": image}));
    let upload = put(photo(24, 13));
    assert_eq!(app.call("PUT", PATH, upload.clone(), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("PUT", PATH, upload.clone(), Some(&visitor)).await.body["code"], "owner_changed");
    assert_eq!(app.call("PUT", PATH, upload.clone(), Some(&owner)).await.body["code"], "no_home");
    let birth = json!({"calendar":"solar","year":1991,"month":5,"day":1,"time":null,"gender":"female"});
    let build = Some(json!({"expectedOwnerId":owner_id,"name":"솔","birth":birth}));
    assert_eq!(app.call("PUT", "/api/homes/me/saju", build, Some(&owner)).await.status, StatusCode::OK);
    let stored = app.call("PUT", PATH, upload.clone(), Some(&owner)).await;
    assert_eq!(stored.status, StatusCode::OK, "{:?}", stored.body);
    let decor = format!("{HOST}/decor");
    let url = |value: &serde_json::Value| format!("{HOST}/photo-board/{}", value["version"].as_str().unwrap());
    let first_url = url(&stored.body);
    assert_eq!(app.call("GET", &decor, None, None).await.body["photoBoard"], stored.body);
    let served = app.call("GET", &first_url, None, None).await;
    assert_eq!(served.status, StatusCode::OK);
    assert_eq!(served.headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(served.headers[header::CACHE_CONTROL], "private, no-store");
    assert!(!served.bytes.windows(7).any(|w| w == b"private"));
    let pixels = image::load_from_memory(&served.bytes).unwrap();
    assert_eq!((pixels.width(), pixels.height()), (24, 13));

    assert_eq!(app.call("PUT", PATH, put(photo(1281, 1)), Some(&owner)).await.body["code"], "photo_too_large");
    assert_eq!(
        app.call("PUT", PATH, put("data:image/jpeg;base64,AAAA".into()), Some(&owner)).await.body["code"],
        "invalid_photo"
    );
    assert_eq!(app.call("GET", &first_url, None, None).await.status, StatusCode::OK);
    let swapped = app.call("PUT", PATH, put(photo(9, 21)), Some(&owner)).await;
    assert_eq!(swapped.status, StatusCode::OK);
    let second_url = url(&swapped.body);
    assert_ne!(first_url, second_url);
    assert_eq!(app.call("GET", &first_url, None, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("GET", &decor, None, None).await.body["photoBoard"]["height"], 21);
    let private = Some(json!({"expectedOwnerId":owner_id,"visibility":"private"}));
    assert_eq!(app.call("PATCH", "/api/homes/me", private, Some(&owner)).await.status, StatusCode::OK);
    assert_eq!(app.call("GET", &second_url, None, Some(&visitor)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.call("GET", &second_url, None, Some(&owner)).await.status, StatusCode::OK);

    let drop = Some(json!({"expectedOwnerId":owner_id}));
    assert_eq!(app.call("DELETE", PATH, drop.clone(), Some(&visitor)).await.body["code"], "owner_changed");
    assert_eq!(app.call("DELETE", PATH, drop.clone(), Some(&owner)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.call("GET", &second_url, None, Some(&owner)).await.status, StatusCode::NOT_FOUND);
    assert!(app.call("GET", &decor, None, Some(&owner)).await.body["photoBoard"].is_null());
    assert_eq!(app.call("PUT", PATH, upload, Some(&owner)).await.status, StatusCode::OK);
    assert_eq!(app.call("DELETE", "/api/homes/me/saju", drop, Some(&owner)).await.status, StatusCode::NO_CONTENT);
    assert!(app.call("GET", &decor, None, Some(&owner)).await.body["photoBoard"].is_null());
    app.cleanup().await;
}
