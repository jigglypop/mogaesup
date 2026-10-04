mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::{ORIGIN, Reply, TestApp};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use mogaesup_server::{
    security::rate_record,
    share::{HEIGHT, MAX_PICTURE_BYTES, WIDTH},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn encoded(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
    let picture = RgbImage::from_fn(width, height, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 120]));
    let mut out = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(picture).write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn data_url(kind: &str, bytes: &[u8]) -> String {
    format!("data:{kind};base64,{}", STANDARD.encode(bytes))
}

fn jpeg_url(width: u32, height: u32) -> String {
    data_url("image/jpeg", &encoded(width, height, ImageFormat::Jpeg))
}

async fn put_picture(app: &TestApp, cookie: &str, body: Value) -> Reply {
    app.call("PUT", "/api/homes/me/thumbnail", Some(body), Some(cookie)).await
}

async fn share(app: &TestApp, path: &str) -> (StatusCode, String, Reply) {
    let reply = app.call("GET", path, None, None).await;
    (reply.status, String::from_utf8(reply.bytes.clone()).unwrap(), reply)
}

/// The `content` of the page's `<meta>` named `name` (a `property` or a `name`).
fn meta(page: &str, name: &str) -> Option<String> {
    page.lines().find_map(|line| {
        let rest = line
            .strip_prefix(&format!("<meta property=\"{name}\" content=\""))
            .or_else(|| line.strip_prefix(&format!("<meta name=\"{name}\" content=\"")))?;
        Some(rest.strip_suffix("\">")?.to_owned())
    })
}

fn stored_picture(url: &str) -> bool {
    url.strip_prefix("/models/")
        .and_then(|name| name.strip_suffix(".jpg"))
        .is_some_and(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[tokio::test]
async fn 섬_주인은_미리보기_사진을_올리고_되돌린다() {
    let app = TestApp::new(None).await;
    let owner = app.register("thumb_owner", "주인").await;
    let id = app.user_id("thumb_owner").await;
    let saved = put_picture(&app, &owner, json!({"expectedOwnerId": id, "image": jpeg_url(1600, 1200)})).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["isOwner"], true);
    let url = saved.body["profile"]["thumbnailUrl"].as_str().unwrap().to_owned();
    assert!(stored_picture(&url), "{url}");

    // Stored as the preview's own JPEG, whatever size was sent.
    let file = app.call("GET", &url, None, None).await;
    assert_eq!(file.status, StatusCode::OK);
    assert_eq!(file.headers[header::CONTENT_TYPE], "image/jpeg");
    let picture = image::load_from_memory_with_format(&file.bytes, ImageFormat::Jpeg).unwrap();
    assert_eq!((picture.width(), picture.height()), (WIDTH, HEIGHT));

    // A PNG is taken too, and visitors see the island's picture with its profile.
    let png = data_url("image/png", &encoded(300, 200, ImageFormat::Png));
    let saved = put_picture(&app, &owner, json!({"expectedOwnerId": id, "image": png})).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    let url = saved.body["profile"]["thumbnailUrl"].as_str().unwrap().to_owned();
    assert!(stored_picture(&url));
    let seen = app.call("GET", "/api/homes/thumb_owner", None, None).await;
    assert_eq!(seen.body["profile"]["thumbnailUrl"], url.as_str());

    let removed =
        app.call("DELETE", "/api/homes/me/thumbnail", Some(json!({"expectedOwnerId": id})), Some(&owner)).await;
    assert_eq!(removed.status, StatusCode::OK, "{:?}", removed.body);
    assert_eq!(removed.body["profile"]["thumbnailUrl"], Value::Null);
    app.cleanup().await;
}

#[tokio::test]
async fn 미리보기_사진은_주인과_형식과_크기를_확인한다() {
    let app = TestApp::new(None).await;
    let owner = app.register("thumb_check", "주인").await;
    let other = app.register("thumb_other", "남").await;
    let id = app.user_id("thumb_check").await;
    let picture = jpeg_url(64, 64);

    let anonymous = app.call("PUT", "/api/homes/me/thumbnail", Some(json!({"image": picture})), None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    // The page was loaded for another account, or says nothing about it.
    for body in
        [json!({"image": picture}), json!({"expectedOwnerId": app.user_id("thumb_other").await, "image": picture})]
    {
        let refused = put_picture(&app, &owner, body).await;
        assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::CONFLICT, Some("owner_changed")));
    }
    let foreign = put_picture(&app, &other, json!({"expectedOwnerId": id, "image": picture})).await;
    assert_eq!(foreign.status, StatusCode::CONFLICT);

    let refuse = |image: String, status: StatusCode, code: &'static str| {
        let app = &app;
        let owner = owner.clone();
        async move {
            let reply = put_picture(app, &owner, json!({"expectedOwnerId": id, "image": image})).await;
            assert_eq!((reply.status, reply.body["code"].as_str()), (status, Some(code)), "{:?}", reply.body);
        }
    };
    let gif = data_url("image/gif", b"GIF89a\x01\x00\x01\x00\x00\x00\x00;");
    refuse(gif, StatusCode::UNPROCESSABLE_ENTITY, "invalid_picture").await;
    refuse(data_url("image/jpeg", b"plain text, no picture"), StatusCode::UNPROCESSABLE_ENTITY, "invalid_picture")
        .await;
    refuse("data:image/jpeg;base64,***".into(), StatusCode::UNPROCESSABLE_ENTITY, "invalid_picture").await;
    refuse("https://example.com/x.jpg".into(), StatusCode::UNPROCESSABLE_ENTITY, "invalid_picture").await;
    // Read from its header before decoding: a side past 4096 px.
    let tall = data_url("image/png", &encoded(8, 4097, ImageFormat::Png));
    refuse(tall, StatusCode::PAYLOAD_TOO_LARGE, "picture_too_large").await;
    // Past the byte limit before anything is decoded: as base64, and as a body.
    let long = format!("data:image/jpeg;base64,{}", "A".repeat(MAX_PICTURE_BYTES.div_ceil(3) * 4 + 4));
    refuse(long, StatusCode::PAYLOAD_TOO_LARGE, "picture_too_large").await;
    let huge = format!("data:image/jpeg;base64,{}", "A".repeat(2 * MAX_PICTURE_BYTES));
    refuse(huge, StatusCode::PAYLOAD_TOO_LARGE, "picture_too_large").await;

    let home = app.call("GET", "/api/homes/me", None, Some(&owner)).await;
    assert_eq!(home.body["profile"]["thumbnailUrl"], Value::Null);
    let unbound = app.call("DELETE", "/api/homes/me/thumbnail", Some(json!({})), Some(&owner)).await;
    assert_eq!(unbound.status, StatusCode::CONFLICT);
    // A form post from elsewhere never reaches it.
    let form = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/thumbnail")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, &owner)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("image=x"))
        .unwrap();
    assert_eq!(app.send(form).await.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    app.cleanup().await;
}

#[tokio::test]
async fn 미리보기_사진은_회원마다_10분에_20번까지_받는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("thumb_rate", "주인").await;
    let id = app.user_id("thumb_rate").await;
    for _ in 0..20 {
        rate_record(&app.state, format!("thumbnail:{id}"));
    }
    let reply = put_picture(&app, &owner, json!({"expectedOwnerId": id, "image": jpeg_url(64, 64)})).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;
}

#[tokio::test]
async fn 공유_페이지는_섬_제목과_주인과_사진을_미리보기_태그로_알린다() {
    let app = TestApp::new(None).await;
    let owner = app.register("share_owner", "모개 <주인>").await;
    let id = app.user_id("share_owner").await;
    let profile = json!({"title": "<b>모개</b> & \"섬\"", "statusMessage": "오늘도\n'맑음' <script>"});
    assert_eq!(app.call("PATCH", "/api/homes/me", Some(profile), Some(&owner)).await.status, StatusCode::OK);

    let (status, page, reply) = share(&app, "/api/share/@share_owner").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply.headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(reply.headers[header::CACHE_CONTROL], "public, max-age=300");
    assert_eq!(reply.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    let title = "&lt;b&gt;모개&lt;/b&gt; &amp; &quot;섬&quot;";
    assert_eq!(meta(&page, "og:title").as_deref(), Some(title));
    assert_eq!(meta(&page, "twitter:title").as_deref(), Some(title));
    assert!(page.contains(&format!("<title>{title}</title>")));
    let description = "모개 &lt;주인&gt; · 오늘도 &#39;맑음&#39; &lt;script&gt;";
    assert_eq!(meta(&page, "og:description").as_deref(), Some(description));
    assert_eq!(meta(&page, "og:site_name").as_deref(), Some("모개숲"));
    assert_eq!(meta(&page, "og:type").as_deref(), Some("website"));
    assert_eq!(meta(&page, "og:image").as_deref(), Some(format!("{ORIGIN}/share.jpg").as_str()));
    assert_eq!(meta(&page, "og:image:width").as_deref(), Some("1200"));
    assert_eq!(meta(&page, "og:image:height").as_deref(), Some("630"));
    // Its own address: a crawler that reads the tags at og:url (KakaoTalk does) finds these again.
    assert_eq!(meta(&page, "og:url").as_deref(), Some(format!("{ORIGIN}/api/share/@share_owner").as_str()));
    assert!(page.contains("<a href=\"/@share_owner\">"));
    assert!(!page.contains("<b>") && !page.contains("<script> ") && !page.contains("<주인>"));
    // The one script, the island's link, runs by its hash; nothing else may.
    let scripts: Vec<&str> =
        page.split("<script>").skip(1).map(|rest| rest.split("</script>").next().unwrap()).collect();
    assert_eq!(scripts.len(), 1);
    let hash = STANDARD.encode(Sha256::digest(scripts[0].as_bytes()));
    let policy = reply.headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(policy.starts_with("default-src 'none'"), "{policy}");
    assert!(policy.contains(&format!("script-src 'sha256-{hash}';")), "{policy}");
    assert!(!page.contains("http-equiv"));

    // With a picture of its own: its absolute address. The username's capitals do not matter.
    let saved = put_picture(&app, &owner, json!({"expectedOwnerId": id, "image": jpeg_url(1200, 630)})).await;
    let url = saved.body["profile"]["thumbnailUrl"].as_str().unwrap().to_owned();
    let (_, page, _) = share(&app, "/api/share/@Share_Owner").await;
    assert_eq!(meta(&page, "og:image").as_deref(), Some(format!("{ORIGIN}{url}").as_str()));
    assert_eq!(meta(&page, "twitter:image").as_deref(), Some(format!("{ORIGIN}{url}").as_str()));
    // A crawler may ask with HEAD first.
    let head = Request::builder().method("HEAD").uri("/api/share/@share_owner").body(Body::empty()).unwrap();
    assert_eq!(app.send(head).await.status, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 공개하지_않은_섬의_공유_페이지는_사이트_이름과_그림만_알린다() {
    let app = TestApp::new(None).await;
    let owner = app.register("share_secret", "비밀주인").await;
    let id = app.user_id("share_secret").await;
    let profile = json!({"title": "비밀 섬", "statusMessage": "비밀 상태"});
    app.call("PATCH", "/api/homes/me", Some(profile), Some(&owner)).await;
    put_picture(&app, &owner, json!({"expectedOwnerId": id, "image": jpeg_url(800, 600)})).await;
    for visibility in ["private", "ilchon"] {
        app.call("PATCH", "/api/homes/me", Some(json!({"visibility": visibility})), Some(&owner)).await;
        // The same page for everyone, the owner too: a cache may keep it.
        for cookie in [None, Some(owner.as_str())] {
            let reply = app.call("GET", "/api/share/@share_secret", None, cookie).await;
            let page = String::from_utf8(reply.bytes).unwrap();
            assert_eq!(reply.status, StatusCode::OK);
            assert_eq!(meta(&page, "og:title").as_deref(), Some("모개숲"), "{visibility}");
            assert_eq!(meta(&page, "og:image").as_deref(), Some(format!("{ORIGIN}/share.jpg").as_str()));
            assert_eq!(meta(&page, "og:description"), None);
            for secret in ["비밀 섬", "비밀 상태", "비밀주인", "/models/"] {
                assert!(!page.contains(secret), "{visibility} leaks {secret}");
            }
            assert!(page.contains("<a href=\"/@share_secret\">"));
        }
    }
    app.cleanup().await;
}

#[tokio::test]
async fn 없는_섬과_잘못된_주소는_404와_사이트_미리보기로_답한다() {
    let app = TestApp::new(None).await;
    let (status, page, _) = share(&app, "/api/share/@nobody_here").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(meta(&page, "og:title").as_deref(), Some("모개숲"));
    assert!(page.contains("<a href=\"/@nobody_here\">"));
    for path in ["/api/share/nobody_here", "/api/share/@%3Cscript%3Ealert(1)%3C%2Fscript%3E", "/api/share/@a"] {
        let (status, page, _) = share(&app, path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert!(page.contains("<a href=\"/\">"), "{path}");
        assert!(!page.contains("alert"), "{path}");
    }
    app.cleanup().await;
}
