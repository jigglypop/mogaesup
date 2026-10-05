mod common;
#[path = "fixtures/character.rs"]
mod test_glb;

use axum::{
    Json, Router,
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{ORIGIN, TestApp, TestDb};
use mogaesup_server::{
    MIGRATOR,
    config::{Factory, FactoryAccess, FactoryToken},
    glb,
    security::rate_record,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

#[tokio::test]
async fn 가입_로그인_로그아웃이_세션_쿠키로_이어진다() {
    let app = TestApp::new(None).await;
    let cookie = app.register("Mogae_1", "모개").await;
    let me = app.call("GET", "/api/auth/me", None, Some(&cookie)).await;
    assert_eq!(me.body["user"]["username"], "mogae_1");
    assert_eq!(me.body["user"]["role"], "user");

    let taken = app
        .call("POST", "/api/auth/register", Some(json!({"username": "mogae_1", "password": "another password"})), None)
        .await;
    assert_eq!(taken.status, StatusCode::CONFLICT);
    let short =
        app.call("POST", "/api/auth/register", Some(json!({"username": "shorty", "password": "short"})), None).await;
    assert_eq!(short.status, StatusCode::UNPROCESSABLE_ENTITY);

    let wrong = app
        .call("POST", "/api/auth/login", Some(json!({"username": "mogae_1", "password": "wrong password!"})), None)
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let login = app
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "mogae_1", "password": "correct horse battery"})),
            None,
        )
        .await;
    assert_eq!(login.status, StatusCode::OK);
    let second = login.cookie.unwrap();

    let logout = app.call("POST", "/api/auth/logout", None, Some(&second)).await;
    assert_eq!(logout.status, StatusCode::NO_CONTENT);
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&second)).await.body["user"], Value::Null);
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&cookie)).await.body["user"]["username"], "mogae_1");
    app.cleanup().await;
}

#[tokio::test]
async fn 쓰기_요청은_같은_출처의_json만_받는다() {
    let app = TestApp::new(None).await;
    let body = || Body::from(json!({"username": "x_user", "password": "whatever-long"}).to_string());
    let no_origin =
        Request::builder().method("POST").uri("/api/auth/login").header(header::CONTENT_TYPE, "application/json");
    assert_eq!(app.send(no_origin.body(body()).unwrap()).await.status, StatusCode::FORBIDDEN);
    let foreign = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::CONTENT_TYPE, "application/json");
    assert_eq!(app.send(foreign.body(body()).unwrap()).await.status, StatusCode::FORBIDDEN);
    let form = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    assert_eq!(app.send(form.body(body()).unwrap()).await.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let health = app.call("GET", "/api/health", None, None).await;
    assert_eq!(health.body["database"], "postgresql");
    assert_eq!(health.headers[header::CACHE_CONTROL], "no-store");
    app.cleanup().await;
}

#[tokio::test]
async fn 가입하면_섬이_생기고_프로필을_바꾼다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_a", "주인").await;
    let home = app.call("GET", "/api/homes/me", None, Some(&owner)).await;
    assert_eq!(home.body["profile"]["title"], "주인의 섬");
    assert_eq!(home.body["isOwner"], true);
    assert_eq!(home.body["visits"], json!({"today": 0, "total": 0}));

    let patched = app
        .call(
            "PATCH",
            "/api/homes/me",
            Some(json!({"statusMessage": "오늘도 느긋하게", "mood": 2, "minime": "man", "emoji": "👩‍🏫"})),
            Some(&owner),
        )
        .await;
    assert_eq!(patched.body["profile"]["minime"], "man");
    assert_eq!(patched.body["profile"]["mood"], 2);
    let invalid = app.call("PATCH", "/api/homes/me", Some(json!({"mood": 9})), Some(&owner)).await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);

    let listed = app.call("GET", "/api/homes", None, None).await;
    assert_eq!(listed.body["homes"][0]["username"], "owner_a");
    app.cleanup().await;
}

#[tokio::test]
async fn 방문은_하루_한_번_세고_주인_방문은_세지_않는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_b", "주인").await;
    let guest = app.register("guest_b", "손님").await;
    let visit = |cookie: Option<String>, body: Value| {
        let app = &app;
        async move { app.call("POST", "/api/homes/owner_b/visits", Some(body), cookie.as_deref()).await.body }
    };
    assert_eq!(visit(Some(guest.clone()), json!({})).await, json!({"today": 1, "total": 1}));
    assert_eq!(visit(Some(guest.clone()), json!({})).await, json!({"today": 1, "total": 1}));
    assert_eq!(visit(Some(owner.clone()), json!({})).await, json!({"today": 1, "total": 1}));
    let anonymous = uuid::Uuid::new_v4();
    assert_eq!(visit(None, json!({"visitorId": anonymous})).await, json!({"today": 2, "total": 2}));
    assert_eq!(visit(None, json!({"visitorId": anonymous})).await, json!({"today": 2, "total": 2}));
    app.cleanup().await;
}

#[tokio::test]
async fn 섬_저장은_리비전을_지키고_위험한_url을_거절한다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_c", "주인").await;
    let save = |base: i64, data: Value| {
        let app = &app;
        let owner = owner.clone();
        async move {
            app.call(
                "PUT",
                "/api/homes/me/world",
                Some(json!({"worldId": "minihome-v6", "baseRevision": base, "data": data})),
                Some(&owner),
            )
            .await
        }
    };
    let world = |tiles: i64| json!({"version": 1, "savedAt": 1, "domains": {"building": {"tiles": tiles, "snake_case": {"kebab-key": 1}, "objects": [{"config": {"modelUrl": "gltf/props/bed.glb"}}]}}});
    assert_eq!(
        app.call("GET", "/api/homes/owner_c/world?worldId=minihome-v6", None, None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(save(0, world(1)).await.body["revision"], 1);
    assert_eq!(save(0, world(1)).await.status, StatusCode::CONFLICT);
    assert_eq!(save(1, world(2)).await.body["revision"], 2);
    assert_eq!(save(1, world(3)).await.status, StatusCode::CONFLICT);
    let loaded = app.call("GET", "/api/homes/owner_c/world?worldId=minihome-v6", None, None).await;
    assert_eq!(loaded.body["data"]["domains"]["building"]["snake_case"]["kebab-key"], 1);

    let evil = json!({"version": 1, "savedAt": 1, "domains": {"building": {"objects": [{"config": {"modelUrl": "https://evil.example/x.glb"}}]}}});
    assert_eq!(save(2, evil).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let huge = json!({"version": 1, "savedAt": 1, "domains": {"blob": "x".repeat(2 * 1024 * 1024 + 10)}});
    assert!(matches!(save(2, huge).await.status, StatusCode::PAYLOAD_TOO_LARGE));
    app.cleanup().await;
}

/// A GET of `path` as a browser sends it again: with the tag it holds, signed in or not.
async fn load_again(app: &TestApp, path: &str, tag: Option<&str>, cookie: Option<&str>) -> common::Reply {
    let mut request = Request::builder().method("GET").uri(path).header(header::ORIGIN, ORIGIN);
    if let Some(tag) = tag {
        request = request.header(header::IF_NONE_MATCH, tag);
    }
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    app.send(request.body(Body::empty()).unwrap()).await
}

fn tag_of(reply: &common::Reply) -> String {
    reply.headers[header::ETAG].to_str().unwrap().to_owned()
}

#[tokio::test]
async fn 섬은_태그로_다시_묻고_그대로면_내용_없이_304로_답한다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_w", "주인").await;
    let save = |base: i64, tiles: i64| {
        let (app, owner) = (&app, owner.clone());
        async move {
            let data = json!({"version": 1, "savedAt": 1, "domains": {"building": {"tiles": tiles}}});
            let body = json!({"worldId": "minihome-v6", "baseRevision": base, "data": data});
            app.call("PUT", "/api/homes/me/world", Some(body), Some(&owner)).await
        }
    };
    let path = "/api/homes/owner_w/world?worldId=minihome-v6";
    let tiles = |reply: &common::Reply| reply.body["data"]["domains"]["building"]["tiles"].as_i64();

    // A save answers with what the page needs for the next one, not with the island it sent.
    let saved = save(0, 1).await;
    assert_eq!(saved.status, StatusCode::OK);
    assert_eq!(saved.body.get("data"), None);
    assert_eq!((saved.body["worldId"].as_str(), saved.body["revision"].as_i64()), (Some("minihome-v6"), Some(1)));

    let first = load_again(&app, path, None, None).await;
    assert_eq!((first.status, tiles(&first)), (StatusCode::OK, Some(1)));
    assert_eq!(first.body["updatedAt"], saved.body["updatedAt"]);
    assert_eq!(first.headers[header::CACHE_CONTROL], "private, no-cache");
    let tag = tag_of(&first);
    assert!(tag.starts_with("\"r1.") && tag.ends_with('"'), "{tag}");

    // The browser still holds the stored island: 304 without a body, to visitors and the owner alike, whether or not a
    // cache on the way weakened the tag.
    for (sent, cookie) in [
        (tag.clone(), None),
        (tag.clone(), Some(owner.as_str())),
        (format!("W/{tag}"), None),
        (format!("\"other\", {tag}"), None),
    ] {
        let again = load_again(&app, path, Some(&sent), cookie).await;
        assert_eq!(again.status, StatusCode::NOT_MODIFIED, "{sent}");
        assert!(again.bytes.is_empty());
        assert_eq!(tag_of(&again), tag);
        assert_eq!(again.headers[header::CACHE_CONTROL], "private, no-cache");
    }
    // A tag of another shape is no tag.
    for sent in ["*", "\"r1\"", "r1.5", "\"rx.y\""] {
        assert_eq!(load_again(&app, path, Some(sent), None).await.status, StatusCode::OK, "{sent}");
    }

    // A newer save is answered in full, with a new tag.
    assert_eq!(save(1, 2).await.body["revision"], 2);
    let changed = load_again(&app, path, Some(&tag), None).await;
    assert_eq!((changed.status, tiles(&changed)), (StatusCode::OK, Some(2)));
    let second = tag_of(&changed);
    assert!(second.starts_with("\"r2."), "{second}");

    // A world pushed out and saved again starts over at revision 1; its tag is new all the same.
    sqlx::query("DELETE FROM home_worlds WHERE world_id = 'minihome-v6'").execute(&app.state.db).await.unwrap();
    assert_eq!(load_again(&app, path, Some(&second), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(save(0, 3).await.body["revision"], 1);
    let remade = load_again(&app, path, Some(&tag), None).await;
    assert_eq!((remade.status, tiles(&remade)), (StatusCode::OK, Some(3)));
    let third = tag_of(&remade);
    assert!(third.starts_with("\"r1.") && third != tag, "{third} {tag}");

    // Who may see the island is asked before the tag is.
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&owner)).await;
    assert_eq!(load_again(&app, path, Some(&third), None).await.status, StatusCode::FORBIDDEN);
    assert_eq!(load_again(&app, path, Some(&third), Some(&owner)).await.status, StatusCode::NOT_MODIFIED);

    // Anonymous loads are counted per address; the owner's are not.
    for _ in 0..600 {
        rate_record(&app.state, "world-read:local".into());
    }
    let limited = load_again(&app, path, Some(&third), None).await;
    assert_eq!((limited.status, limited.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert_eq!(load_again(&app, path, Some(&third), Some(&owner)).await.status, StatusCode::NOT_MODIFIED);
    app.cleanup().await;
}

#[tokio::test]
async fn 방명록은_로그인해서_쓰고_비밀글은_주인과_글쓴이만_읽는다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_d", "호스트").await;
    let friend = app.register("friend_d", "친구").await;
    let stranger = app.register("stranger_d", "낯선이").await;
    let path = "/api/homes/host_d/guestbook";
    assert_eq!(app.call("POST", path, Some(json!({"body": "안녕"})), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        app.call("POST", path, Some(json!({"body": "  꽃밭 예뻐요  "})), Some(&friend)).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        app.call("POST", path, Some(json!({"body": "몰래", "secret": true})), Some(&stranger)).await.status,
        StatusCode::CREATED
    );
    let read = |cookie: Option<String>| {
        let app = &app;
        async move { app.call("GET", path, None, cookie.as_deref()).await.body }
    };
    let as_friend = read(Some(friend.clone())).await;
    assert_eq!(as_friend["total"], 2);
    let secret = |page: &Value| {
        page["entries"].as_array().unwrap().iter().find(|e| e["secret"] == true).unwrap()["body"].clone()
    };
    assert_eq!(secret(&as_friend), "");
    assert_eq!(secret(&read(Some(stranger.clone())).await), "몰래");
    assert_eq!(secret(&read(Some(host.clone())).await), "몰래");
    let friends_entry = as_friend["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["author"]["username"] == "friend_d")
        .unwrap()
        .clone();
    assert_eq!(friends_entry["body"], "꽃밭 예뻐요");
    let id = friends_entry["id"].as_str().unwrap();
    assert_eq!(
        app.call("DELETE", &format!("/api/guestbook/{id}"), None, Some(&stranger)).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.call("DELETE", &format!("/api/guestbook/{id}"), None, Some(&host)).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(read(None).await["total"], 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 일촌을_맺으면_일촌_공개_홈을_볼_수_있다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_e", "호스트").await;
    let friend = app.register("friend_e", "친구").await;
    let request = app
        .call(
            "POST",
            "/api/ilchon/host_e/request",
            Some(json!({"name": "섬주인", "theirName": "꽃밭지기", "message": "일촌해요"})),
            Some(&friend),
        )
        .await;
    assert_eq!(request.status, StatusCode::CREATED);
    assert_eq!(app.call("GET", "/api/ilchon/host_e", None, Some(&friend)).await.body["relation"], "requested");
    assert_eq!(app.call("GET", "/api/ilchon/friend_e", None, Some(&host)).await.body["relation"], "received");
    let back = app
        .call("POST", "/api/ilchon/friend_e/request", Some(json!({"name": "a", "theirName": "b"})), Some(&host))
        .await;
    assert_eq!(back.body["code"], "request_received");

    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "ilchon"})), Some(&host)).await;
    assert_eq!(app.call("GET", "/api/homes/host_e", None, Some(&friend)).await.status, StatusCode::FORBIDDEN);
    let received = app.call("GET", "/api/ilchon-requests", None, Some(&host)).await;
    let id = received.body["received"][0]["id"].as_str().unwrap().to_owned();
    let accepted = app
        .call("POST", &format!("/api/ilchon-requests/{id}/accept"), Some(json!({"name": "베프"})), Some(&host))
        .await;
    assert_eq!(accepted.body["relation"], "ilchon");
    assert_eq!(accepted.body["ilchon"]["name"], "베프");
    assert_eq!(accepted.body["ilchon"]["theirName"], "섬주인");
    assert_eq!(app.call("GET", "/api/homes/host_e", None, Some(&friend)).await.status, StatusCode::OK);
    assert_eq!(app.call("GET", "/api/homes/host_e", None, None).await.status, StatusCode::FORBIDDEN);
    let list = app.call("GET", "/api/homes/friend_e/ilchons", None, None).await;
    assert_eq!(list.body["ilchons"][0]["user"]["username"], "host_e");
    assert_eq!(list.body["ilchons"][0]["name"], "섬주인");

    assert_eq!(app.call("DELETE", "/api/ilchon/host_e", None, Some(&friend)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.call("GET", "/api/homes/host_e", None, Some(&friend)).await.status, StatusCode::FORBIDDEN);
    app.cleanup().await;
}

/// Rigged, with the clips the character server's Meshy delivery names; `name` makes each copy's bytes its own.
fn character_glb(name: &str) -> Vec<u8> {
    let (mut json, bin) = test_glb::document(&["idle", "walk", "run", "sit"]);
    json["asset"]["generator"] = name.into();
    glb::join(&json, &bin)
}

/// Animated but without a skin: nothing a 미니미 can be.
fn statue_glb() -> Vec<u8> {
    glb::join(&json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]}), &[])
}

/// A rigged 1.7 m figure: one triangle under a centimetre-scale root, with an 1100 px colour map the import shrinks.
fn textured_glb() -> Vec<u8> {
    let mut picture = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(1100, 1100).write_to(&mut picture, image::ImageFormat::Png).unwrap();
    let picture = picture.into_inner();
    let (mut json, mut bin) = test_glb::document(&["Armature|Idle", "Walking"]);
    let image_view = json["bufferViews"].as_array().unwrap().len();
    json["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": picture.len()}));
    bin.extend(picture);
    json["buffers"][0]["byteLength"] = bin.len().into();
    json["meshes"][0]["primitives"][0]["material"] = 0.into();
    json["materials"] = json!([{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}]);
    json["textures"] = json!([{"source": 0}]);
    json["images"] = json!([{"bufferView": image_view, "mimeType": "image/png"}]);
    glb::join(&json, &bin)
}

/// What the fake character server serves for a job and chosen face.
fn served_model(job: &str, face: Option<&str>) -> Vec<u8> {
    match job {
        "statue" => statue_glb(),
        "textured" => textured_glb(),
        _ => character_glb(&format!("{job}/{}", face.unwrap_or("plain"))),
    }
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbaImage::new(width, height).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// A sealed job of `character`, whose plain assembly records the SHA-256 of what the fake serves for it.
fn factory_job(id: &str, character: &str, created: &str) -> Value {
    json!({"id": id, "character_id": character, "character_name": format!("{id} 캐릭터"), "created_at": created,
        "production_mode": "character_parts", "assembly_version": "v3", "assembly_origin": "generated_parts_fitted_to_meshy_body",
        "character_flow": {"stage": "complete"},
        "assembly_artifacts": [{"name": "model.glb", "sha256": sha256(&served_model(id, None))}]})
}

/// One request the fake character server received.
#[derive(Clone, Debug, PartialEq)]
struct Call {
    uri: String,
    authorization: Option<String>,
    api_key: Option<String>,
    gateway_key: Option<String>,
    cookie: Option<String>,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Call>>>);

/// The fake character server's records, which a test changes to remake a character or choose another face.
#[derive(Default)]
struct StudioState {
    jobs: Vec<Value>,
    /// The chosen face per job; jobs without one answer 404 for their expressions.
    faces: HashMap<String, String>,
    /// Jobs whose model downloads take this long, so their imports stay running while a test looks.
    slow: HashMap<String, Duration>,
}

#[derive(Clone, Default)]
struct Studio(Arc<Mutex<StudioState>>);

impl Studio {
    /// Three sealed characters and one still assembling: `job_1` has a chosen face, `statue` has no rig and
    /// `tampered` serves bytes its record does not match.
    fn standard() -> Self {
        let mut tampered = factory_job("tampered", "c_tampered", "2026-09-01T00:00:00Z");
        tampered["assembly_artifacts"][0]["sha256"] = json!("0".repeat(64));
        let studio = Self::with(vec![
            factory_job("job_1", "c_job_1", "2026-09-03T00:00:00Z"),
            factory_job("statue", "c_statue", "2026-09-02T00:00:00Z"),
            tampered,
            json!({"id": "wip", "production_mode": "character_parts", "assembly_version": null, "character_flow": {"stage": "assemble"}}),
        ]);
        studio.face("job_1", "smile");
        studio
    }

    fn with(jobs: Vec<Value>) -> Self {
        Self(Arc::new(Mutex::new(StudioState { jobs, ..Default::default() })))
    }

    fn face(&self, job: &str, face: &str) {
        self.0.lock().unwrap().faces.insert(job.into(), face.into());
    }

    fn add(&self, job: Value) {
        self.0.lock().unwrap().jobs.push(job);
    }

    fn stage(&self, job: &str, stage: &str) {
        let mut state = self.0.lock().unwrap();
        let job = state.jobs.iter_mut().find(|candidate| candidate["id"] == job).unwrap();
        job["character_flow"]["stage"] = json!(stage);
    }

    fn slow(&self, job: &str, delay: Duration) {
        self.0.lock().unwrap().slow.insert(job.into(), delay);
    }
}

/// A character server stand-in serving `studio`'s records. Files redirect to a "presigned" URL on the same host.
async fn fake_factory(seen: Seen, studio: Studio) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = base.clone();
    let app = Router::new().fallback(move |request: Request| {
        let (seen, studio, base) = (seen.clone(), studio.clone(), base.clone());
        async move {
            let headers = request.headers();
            let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            seen.0.lock().unwrap().push(Call {
                uri: request.uri().to_string(),
                authorization: get("authorization"),
                api_key: get("x-api-key"),
                gateway_key: get("x-gateway-key"),
                cookie: get("cookie"),
            });
            let redirect = |file: String| {
                (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, format!("{base}/signed/{file}"))]).into_response()
            };
            let path = request.uri().path().trim_start_matches('/').to_owned();
            let segments: Vec<&str> = path.split('/').collect();
            let (jobs, faces, slow) = {
                let state = studio.0.lock().unwrap();
                (state.jobs.clone(), state.faces.clone(), state.slow.clone())
            };
            match segments.as_slice() {
                ["api", "avatar-factory", "jobs"] => Json(json!({"jobs": jobs})).into_response(),
                ["api", "studio", "catalog"] => {
                    Json(json!({"items": {}, "parts": {"job_1:body": {"name": "공장 영웅"}}, "characters": {}}))
                        .into_response()
                }
                ["api", "avatar-factory", "jobs", id] => match jobs.iter().find(|job| job["id"] == *id) {
                    Some(job) => Json(job.clone()).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                },
                ["api", "studio", "bodies", job, _, "expressions"] => match faces.get(*job) {
                    Some(face) => Json(json!({"selected": face, "items": [{"id": face,
                        "artifacts": [{"name": "model.glb", "sha256": sha256(&served_model(job, Some(face.as_str())))}]}]}))
                    .into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                },
                ["api", "studio", "bodies", job, _, "expressions", face, "model.glb"] => redirect(format!("{job}/{face}.glb")),
                ["api", "avatar-factory", "jobs", job, "native-parts", _, "model.glb"] => redirect(format!("{job}/plain.glb")),
                ["api", "avatar-factory", "jobs", "textured", "native-parts", _, "front.png"] => {
                    StatusCode::NOT_FOUND.into_response()
                }
                ["api", "avatar-factory", "jobs", _, "native-parts", _, "front.png"] => redirect("front.png".into()),
                ["signed", "front.png"] => png(800, 800).into_response(),
                ["signed", job, file] => {
                    if let Some(delay) = slow.get(*job) {
                        tokio::time::sleep(*delay).await;
                    }
                    let face = file.strip_suffix(".glb").filter(|face| *face != "plain");
                    served_model(job, face).into_response()
                }
                ["api", ..] if path.contains("/expressions") => StatusCode::NOT_FOUND.into_response(),
                _ => Json(json!({"ok": true})).into_response(),
            }
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// Settings for the fake character server at `url`: read-only, with an operator token, an API key and a gateway key.
fn factory(url: String) -> Factory {
    let token =
        FactoryToken { key: vec![3; 32], issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 1 };
    Factory {
        url,
        api_key: Some("factory-key".into()),
        token: Some(token),
        access: FactoryAccess::Read,
        paid_monthly: 0,
        gateway_key: Some("gate".into()),
        instance: None,
    }
}

async fn factory_app(seen: &Seen, studio: Studio) -> TestApp {
    TestApp::new(Some(factory(fake_factory(seen.clone(), studio).await))).await
}

const IMPORT: &str = "/api/catalog/admin/import";
const LISTING: &str = "/api/catalog/admin/factory-characters";

fn import_body(job: &str, id: &str, label: &str) -> Value {
    json!({"id": id, "kind": "minime", "label": label, "emoji": "🦸", "factoryJobId": job})
}

/// Polls an import until it is done or failed.
async fn finished(app: &TestApp, admin: &str, id: &str) -> Value {
    for _ in 0..1200 {
        let reply = app.call("GET", &format!("/api/catalog/admin/imports/{id}"), None, Some(admin)).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        if matches!(reply.body["status"].as_str(), Some("done" | "failed")) {
            return reply.body;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("import {id} did not finish");
}

/// Queues an import, checks it was accepted, and waits for its end.
async fn import(app: &TestApp, admin: &str, body: Value) -> Value {
    let queued = app.call("POST", IMPORT, Some(body), Some(admin)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    // The import runs on a task of its own, which may already be done (or have failed) when the reply reads it back.
    assert!(
        matches!(queued.body["status"].as_str(), Some("queued" | "running" | "done" | "failed")),
        "{:?}",
        queued.body
    );
    finished(app, admin, queued.body["id"].as_str().unwrap()).await
}

async fn admin_item(app: &TestApp, admin: &str, id: &str) -> Value {
    let items = app.call("GET", "/api/catalog/admin/items", None, Some(admin)).await;
    items.body["items"].as_array().unwrap().iter().find(|item| item["id"] == id).cloned().unwrap_or(Value::Null)
}

fn check<'a>(report: &'a Value, code: &str) -> &'a Value {
    report["checks"].as_array().unwrap().iter().find(|check| check["code"] == code).unwrap_or(&Value::Null)
}

#[tokio::test]
async fn 관리자는_캐릭터_서버의_완성_캐릭터를_골라_저장소로_가져오고_공개한다() {
    let seen = Seen::default();
    let app = factory_app(&seen, Studio::standard()).await;
    let member = app.register("member_f", "회원").await;
    let admin = app.register("operator_f", "운영자").await;
    app.make_admin("operator_f").await;
    assert_eq!(
        app.call("GET", "/api/catalog/items?kind=minime", None, None).await.body["items"].as_array().unwrap().len(),
        1
    );

    assert_eq!(app.call("GET", LISTING, None, Some(&member)).await.status, StatusCode::FORBIDDEN);
    let characters = app.call("GET", LISTING, None, Some(&admin)).await;
    let ids: Vec<&str> =
        characters.body["characters"].as_array().unwrap().iter().map(|c| c["jobId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["job_1", "statue", "tampered"]);
    let first = &characters.body["characters"][0];
    assert_eq!((first["name"].as_str(), first["version"].as_str()), (Some("공장 영웅"), Some("v3")));
    assert_eq!(first["thumbnailUrl"], "/api/factory/avatar-factory/jobs/job_1/native-parts/v3/front.png");
    assert_eq!((first["face"].as_str(), first["faceKnown"].as_bool()), (Some("smile"), Some(true)));
    assert_eq!(first["sourceRef"], "job_1/v3/smile");
    assert_eq!(first["modelUrl"], "/api/factory/studio/bodies/job_1/v3/expressions/smile/model.glb");
    assert_eq!(first["imported"], Value::Null);
    assert_eq!(characters.body["characters"][1]["face"], Value::Null);
    let calls = seen.0.lock().unwrap().clone();
    assert_eq!(calls[0].api_key.as_deref(), Some("factory-key"));
    assert_eq!(calls[0].gateway_key.as_deref(), Some("gate"));
    let bearer = calls[0].authorization.as_deref().unwrap().trim_start_matches("Bearer ");
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(bearer.split('.').nth(1).unwrap()).unwrap()).unwrap();
    assert_eq!((claims["userId"].as_i64(), claims["roles"][0].as_str()), (Some(1), Some("ADMIN")));

    let refused = app.call("POST", IMPORT, Some(import_body("job_1", "hero", "공장 영웅")), Some(&member)).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    let done = import(&app, &admin, import_body("job_1", "factory-hero", "공장 영웅")).await;
    assert_eq!(
        (done["status"].as_str(), done["step"].as_str(), done["progress"].as_i64()),
        (Some("done"), Some("done"), Some(100))
    );
    assert_eq!((done["itemId"].as_str(), done["replaces"].as_bool()), (Some("factory-hero"), Some(false)));
    assert_eq!((done["characterId"].as_str(), done["requestedBy"].as_str()), (Some("c_job_1"), Some("operator_f")));
    let report = &done["report"];
    assert_eq!(report["outcome"], "created");
    for code in ["checksum", "glb", "skin", "clips", "thumbnail"] {
        assert_eq!(check(report, code)["level"], "ok", "{code}: {report}");
    }
    assert!(check(report, "unused_clips")["message"].as_str().unwrap().contains("sit"));
    assert_eq!(report["model"]["animations"], json!(["idle", "walk", "run", "sit"]));
    assert_eq!(report["source"]["face"], "smile");

    let item = admin_item(&app, &admin, "factory-hero").await;
    assert_eq!(item["status"], "draft");
    assert_eq!(item["sourceRef"], "job_1/v3/smile");
    assert_eq!(item["characterId"], "c_job_1");
    assert_eq!((item["versionCount"].as_i64(), item["versionId"].as_i64()), (Some(1), done["versionId"].as_i64()));
    assert_eq!(item["clips"], json!(["idle", "run", "walk"]));
    let model_url = item["modelUrl"].as_str().unwrap().to_owned();
    let face_model = served_model("job_1", Some("smile"));
    assert_eq!(model_url, format!("/models/{}.glb", sha256(&face_model)));
    let signed: Vec<Call> =
        seen.0.lock().unwrap().iter().filter(|call| call.uri.starts_with("/signed/")).cloned().collect();
    assert_eq!(
        signed.iter().map(|call| call.uri.as_str()).collect::<Vec<_>>(),
        ["/signed/job_1/smile.glb", "/signed/front.png"]
    );
    assert!(signed.iter().all(|call| {
        call.authorization.is_none() && call.api_key.is_none() && call.gateway_key.is_none() && call.cookie.is_none()
    }));

    let model = app.call("GET", &model_url, None, None).await;
    assert_eq!(model.bytes, face_model);
    assert!(model.headers[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
    let picture = app.call("GET", item["thumbnailUrl"].as_str().unwrap(), None, None).await;
    let picture = image::load_from_memory(&picture.bytes).unwrap();
    assert_eq!((picture.width(), picture.height()), (256, 256));

    let characters = app.call("GET", LISTING, None, Some(&admin)).await;
    let imported = &characters.body["characters"][0]["imported"];
    assert_eq!((imported["id"].as_str(), imported["status"].as_str()), (Some("factory-hero"), Some("draft")));
    assert_eq!((imported["current"].as_bool(), imported["freshness"].as_str()), (Some(true), Some("current")));
    let hidden = app.call("GET", "/api/catalog/items", None, None).await;
    assert!(!hidden.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "factory-hero"));
    app.call("PATCH", "/api/catalog/admin/items/factory-hero", Some(json!({"status": "published"})), Some(&admin))
        .await;
    let shown = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    assert!(shown.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "factory-hero"));

    // Problems the character server's answers reveal end the import as failed, with what was found.
    let failed = |job: &'static str| {
        let (app, admin) = (&app, admin.clone());
        async move { import(app, &admin, import_body(job, "other", "다른 캐릭터")).await }
    };
    let statue = failed("statue").await;
    assert_eq!((statue["status"].as_str(), statue["errorCode"].as_str()), (Some("failed"), Some("not_playable")));
    assert_eq!(statue["step"], "verify");
    assert_eq!(check(&statue["report"], "skin")["level"], "error");
    assert_eq!(check(&statue["report"], "clips")["level"], "error");
    assert_eq!(failed("tampered").await["errorCode"], "factory_checksum");
    let wip = failed("wip").await;
    assert_eq!((wip["errorCode"].as_str(), wip["step"].as_str()), (Some("factory_not_sealed"), Some("source")));
    assert_eq!(failed("nobody").await["errorCode"], "factory_job_not_found");
    // What needs no character server is refused before anything is queued.
    let reply = app.call("POST", IMPORT, Some(import_body("../etc", "other", "다른 캐릭터")), Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app.call("POST", IMPORT, Some(import_body("job_1", "Bad Id", "다른 캐릭터")), Some(&admin)).await;
    assert_eq!(reply.body["code"], "invalid_id");
    let reply = app.call("POST", IMPORT, Some(import_body("job_1", "man", "청년")), Some(&admin)).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::CONFLICT, Some("builtin_item")));
    assert_eq!(admin_item(&app, &admin, "other").await, Value::Null);

    let recent = app.call("GET", "/api/catalog/admin/imports?limit=10", None, Some(&admin)).await;
    let statuses: Vec<(&str, &str)> = recent.body["imports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|import| (import["factoryJobId"].as_str().unwrap(), import["status"].as_str().unwrap()))
        .collect();
    assert_eq!(
        statuses,
        [("nobody", "failed"), ("wip", "failed"), ("tampered", "failed"), ("statue", "failed"), ("job_1", "done")]
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 다시_가져와도_공개_상태와_이름을_지키고_버전을_되돌릴_수_있다() {
    let seen = Seen::default();
    let studio = Studio::standard();
    studio.slow("job_1", Duration::from_millis(400));
    let app = factory_app(&seen, studio.clone()).await;
    let admin = app.register("operator_v", "운영자").await;
    app.make_admin("operator_v").await;

    let queued = app.call("POST", IMPORT, Some(import_body("job_1", "hero", "영웅")), Some(&admin)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED);
    // One import per item at a time.
    let again = app.call("POST", IMPORT, Some(import_body("job_1", "hero", "영웅")), Some(&admin)).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::CONFLICT, Some("import_running")));
    let first = finished(&app, &admin, queued.body["id"].as_str().unwrap()).await;
    assert_eq!(first["status"], "done", "{first}");
    let first_url = admin_item(&app, &admin, "hero").await["modelUrl"].as_str().unwrap().to_owned();
    let changes = json!({"status": "published", "label": "우리 영웅", "emoji": "🐶", "sortOrder": 5});
    let patched = app.call("PATCH", "/api/catalog/admin/items/hero", Some(changes), Some(&admin)).await;
    assert_eq!((patched.body["label"].as_str(), patched.body["usage"].as_i64()), (Some("우리 영웅"), Some(0)));

    // The very same copy again changes nothing and adds no version.
    let same = import(&app, &admin, import_body("job_1", "hero", "딴 이름")).await;
    assert_eq!((same["replaces"].as_bool(), same["report"]["outcome"].as_str()), (Some(true), Some("unchanged")));
    assert_eq!(same["versionId"], first["versionId"]);

    // Another face is a new version of the same item, and the listing says so until it is copied.
    studio.face("job_1", "wink");
    let listing = app.call("GET", LISTING, None, Some(&admin)).await;
    let imported = &listing.body["characters"][0]["imported"];
    assert_eq!((imported["id"].as_str(), imported["freshness"].as_str()), (Some("hero"), Some("newFace")));
    assert_eq!(imported["current"], false);
    let updated = import(&app, &admin, import_body("job_1", "hero", "딴 이름")).await;
    assert_eq!(updated["report"]["outcome"], "updated", "{updated}");
    let item = admin_item(&app, &admin, "hero").await;
    assert_eq!(
        (item["status"].as_str(), item["label"].as_str(), item["emoji"].as_str(), item["sortOrder"].as_i64()),
        (Some("published"), Some("우리 영웅"), Some("🐶"), Some(5))
    );
    assert_eq!(item["sourceRef"], "job_1/v3/wink");
    assert_eq!(item["versionCount"], 2);
    let second_url = item["modelUrl"].as_str().unwrap().to_owned();
    assert_ne!(first_url, second_url);
    let public = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    assert!(public.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "hero"));
    let listing = app.call("GET", LISTING, None, Some(&admin)).await;
    assert_eq!(listing.body["characters"][0]["imported"]["freshness"], "current");

    // A remade job of the same character is an update of the same item.
    studio.add(factory_job("job_1b", "c_job_1", "2026-09-10T00:00:00Z"));
    let listing = app.call("GET", LISTING, None, Some(&admin)).await;
    let remade = &listing.body["characters"][0];
    assert_eq!(remade["jobId"], "job_1b");
    assert_eq!(
        (remade["imported"]["id"].as_str(), remade["imported"]["freshness"].as_str()),
        (Some("hero"), Some("newJob"))
    );

    let versions = app.call("GET", "/api/catalog/admin/items/hero/versions", None, Some(&admin)).await;
    let versions = versions.body["versions"].as_array().unwrap().clone();
    assert_eq!(versions.len(), 2);
    assert_eq!((versions[0]["current"].as_bool(), versions[1]["current"].as_bool()), (Some(true), Some(false)));
    assert_eq!(versions[1]["sourceRef"], "job_1/v3/smile");
    assert_eq!(versions[1]["createdBy"], "operator_v");
    assert_eq!(versions[0]["report"]["outcome"], "updated");

    let path = "/api/catalog/admin/items/hero/rollback";
    let rolled = app.call("POST", path, Some(json!({"versionId": versions[1]["id"]})), Some(&admin)).await;
    assert_eq!(rolled.status, StatusCode::OK, "{:?}", rolled.body);
    assert_eq!(
        (rolled.body["modelUrl"].as_str(), rolled.body["status"].as_str()),
        (Some(first_url.as_str()), Some("published"))
    );
    assert_eq!(
        (rolled.body["label"].as_str(), rolled.body["sourceRef"].as_str()),
        (Some("우리 영웅"), Some("job_1/v3/smile"))
    );
    assert_eq!(rolled.body["versionId"], versions[1]["id"]);
    // Both files stay in the store: nothing a version points at is deleted.
    for url in [&first_url, &second_url] {
        assert_eq!(app.call("GET", url, None, None).await.status, StatusCode::OK);
    }
    let missing = app.call("POST", path, Some(json!({"versionId": 999_999})), Some(&admin)).await;
    assert_eq!(missing.body["code"], "version_not_found");
    let foreign = app
        .call(
            "POST",
            "/api/catalog/admin/items/man/rollback",
            Some(json!({"versionId": versions[0]["id"]})),
            Some(&admin),
        )
        .await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn 가져오기_보고서는_모든_검사와_크기를_담고_단계_변화를_알린다() {
    let seen = Seen::default();
    let studio = Studio::with(vec![factory_job("textured", "c_tex", "2026-09-05T00:00:00Z")]);
    studio.stage("textured", "expressions");
    let app = factory_app(&seen, studio.clone()).await;
    let admin = app.register("operator_r", "운영자").await;
    app.make_admin("operator_r").await;

    let done = import(&app, &admin, import_body("textured", "tex", "텍스처")).await;
    assert_eq!(done["status"], "done", "{done}");
    let report = &done["report"];
    assert_eq!((report["model"]["triangles"].as_i64(), report["model"]["vertices"].as_i64()), (Some(1), Some(3)));
    let height = report["model"]["size"][1].as_f64().unwrap();
    assert!((height - 1.7).abs() < 1e-3, "{height}");
    assert_eq!(check(report, "height")["message"], "높이 1.70 m");
    assert_eq!(report["model"]["clips"], json!(["idle", "walk"]));
    assert_eq!(report["model"]["textures"][0]["width"], 1100);
    assert_eq!(report["webTextures"][0]["width"], 1024);
    assert_eq!(report["file"]["slimmed"], true);
    assert!(report["file"]["webBytes"].as_u64().is_some_and(|bytes| bytes > 0));
    assert_eq!(report["file"]["sha256"], sha256(&textured_glb()));
    assert_eq!(check(report, "slim")["level"], "ok");
    assert_eq!(check(report, "texture_size"), &Value::Null);
    // No front render: a warning, and the item simply has no picture.
    assert_eq!(check(report, "thumbnail")["level"], "warning");
    assert_eq!(report["thumbnail"]["ok"], false);
    assert!(!report["checks"].as_array().unwrap().iter().any(|check| check["level"] == "error"));
    let item = admin_item(&app, &admin, "tex").await;
    assert_eq!(item["thumbnailUrl"], Value::Null);
    let versions = app.call("GET", "/api/catalog/admin/items/tex/versions", None, Some(&admin)).await;
    assert_eq!(versions.body["versions"][0]["stage"], "expressions");
    assert_eq!(versions.body["versions"][0]["report"]["model"]["triangles"], 1);

    let listing = app.call("GET", LISTING, None, Some(&admin)).await;
    assert_eq!(listing.body["characters"][0]["imported"]["freshness"], "current");
    assert_eq!(listing.body["characters"][0]["faceKnown"], true);
    // Its face finished baking: the studio moved on, so the copy is no longer the latest.
    studio.stage("textured", "complete");
    let listing = app.call("GET", LISTING, None, Some(&admin)).await;
    assert_eq!(listing.body["characters"][0]["imported"]["freshness"], "newStage");
    app.cleanup().await;
}

#[tokio::test]
async fn 멈춘_것으로_처리된_가져오기는_끝까지_가도_항목을_쓰지_않는다() {
    let seen = Seen::default();
    let studio = Studio::standard();
    // Long enough that the sweep below lands while the model is still downloading, even on a slow runner.
    studio.slow("job_1", Duration::from_millis(3000));
    let app = factory_app(&seen, studio).await;
    let admin = app.register("operator_z", "운영자").await;
    app.make_admin("operator_z").await;
    let queued = app.call("POST", IMPORT, Some(import_body("job_1", "late", "늦은 영웅")), Some(&admin)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    let id: uuid::Uuid = queued.body["id"].as_str().unwrap().parse().unwrap();
    // Status, step, error code, and whether the task recorded a report.
    let row = || async {
        sqlx::query_as::<_, (String, String, Option<String>, bool)>(
            "SELECT status, step, error_code, report IS NOT NULL FROM catalog_imports WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
    };
    for _ in 0..200 {
        if row().await.1 == "download" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // While it downloads, the periodic sweep gives up on it as on one silent for half an hour. A progress tick landing
    // between the two statements makes it fresh again, so that is tried again.
    let mut swept = 0;
    for _ in 0..5 {
        sqlx::query("UPDATE catalog_imports SET updated_at = now() - interval '31 minutes' WHERE id = $1")
            .bind(id)
            .execute(&app.state.db)
            .await
            .unwrap();
        swept = mogaesup_server::imports::interrupt_stale(&app.state.db).await.unwrap();
        if swept == 1 {
            break;
        }
    }
    assert_eq!(swept, 1);
    // Its task still gets to the end and records how it ended, report and all; the item was never written.
    let mut ended = row().await;
    for _ in 0..800 {
        if ended.3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
        ended = row().await;
    }
    assert!(ended.3, "{ended:?}");
    assert_eq!((ended.0.as_str(), ended.2.as_deref()), ("failed", Some("interrupted")), "{ended:?}");
    assert_eq!(admin_item(&app, &admin, "late").await, Value::Null);
    let versions: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog_versions WHERE item_id = 'late'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(versions, 0);
    app.cleanup().await;
}

#[tokio::test]
async fn 서버가_다시_뜨면_멈춘_가져오기를_실패로_적는다() {
    let app = TestApp::new(None).await;
    let admin = app.register("operator_i", "운영자").await;
    app.make_admin("operator_i").await;
    for (item, status) in [("a1", "running"), ("a2", "queued"), ("a3", "done")] {
        sqlx::query(
            "INSERT INTO catalog_imports (id, item_id, kind, label, emoji, factory_job_id, status)
             VALUES ($1, $2, 'minime', '이름', '🙂', 'job', $3)",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(item)
        .bind(status)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    assert_eq!(mogaesup_server::imports::interrupt_unfinished(&app.state.db).await.unwrap(), 2);
    let recent = app.call("GET", "/api/catalog/admin/imports", None, Some(&admin)).await;
    let mut found: Vec<(String, String, Option<String>)> = recent.body["imports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|import| {
            let text = |key: &str| import[key].as_str().map(str::to_owned);
            (text("itemId").unwrap(), text("status").unwrap(), text("errorCode"))
        })
        .collect();
    found.sort();
    assert_eq!(
        found,
        [
            ("a1".into(), "failed".into(), Some("interrupted".into())),
            ("a2".into(), "failed".into(), Some("interrupted".into())),
            ("a3".into(), "done".into(), None),
        ]
    );
    // Without a character server there is nothing to queue.
    let reply = app.call("POST", IMPORT, Some(import_body("job_1", "hero", "영웅")), Some(&admin)).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("factory_unavailable")));
    let missing = app.call("GET", "/api/catalog/admin/imports/not-a-uuid", None, Some(&admin)).await;
    assert_eq!(missing.body["code"], "import_not_found");
    app.cleanup().await;
}

#[tokio::test]
async fn 버전을_두기_전에_가져온_항목은_지금_모델이_첫_버전이_된다() {
    use sqlx::{Row, migrate::Migrate};
    let test_db = TestDb::create().await;
    let db = &test_db.pool;
    // Found by name, so the check survives a renumbering of the file.
    let pipeline = MIGRATOR.iter().find(|m| m.description == "catalog pipeline").unwrap().version;
    let mut conn = db.acquire().await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in MIGRATOR.iter().filter(|m| m.version < pipeline) {
        conn.apply(migration).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, thumbnail_url, clips, source, source_ref, status)
         VALUES ('legacy', 'minime', '옛 캐릭터', '🙂', '/models/old.glb', '/models/old.png', '{idle,walk}', 'factory',
         'job_0/v1/smile', 'published')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    drop(conn);
    MIGRATOR.run(db).await.unwrap();
    let row = sqlx::query(
        "SELECT v.model_url, v.thumbnail_url, v.source_ref, v.clips, i.status FROM catalog_items i
         JOIN catalog_versions v ON v.id = i.version_id WHERE i.id = 'legacy'",
    )
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("model_url"), "/models/old.glb");
    assert_eq!(row.get::<Option<String>, _>("thumbnail_url").as_deref(), Some("/models/old.png"));
    assert_eq!(row.get::<Option<String>, _>("source_ref").as_deref(), Some("job_0/v1/smile"));
    assert_eq!(row.get::<Vec<String>, _>("clips"), ["idle", "walk"]);
    assert_eq!(row.get::<String, _>("status"), "published");
    let versions: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog_versions").fetch_one(db).await.unwrap();
    assert_eq!(versions, 1, "built-in items get no versions");
    test_db.remove().await;
}

#[tokio::test]
async fn 미니미는_공개된_카탈로그나_기본_미니미만_고른다() {
    let app = TestApp::new(None).await;
    let member = app.register("member_m", "회원").await;
    let admin = app.register("operator_m", "운영자").await;
    app.make_admin("operator_m").await;
    sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, source, status) VALUES
         ('fresh', 'minime', '새 친구', '🙂', '/models/fresh.glb', 'factory', 'draft'),
         ('lamp', 'furniture', '등', '💡', '/models/lamp.glb', 'factory', 'published')",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let pick = |id: &'static str| {
        let (app, member) = (&app, member.clone());
        async move { app.call("PATCH", "/api/homes/me", Some(json!({"minime": id})), Some(&member)).await }
    };
    for refused in ["nobody", "fresh", "lamp"] {
        let reply = pick(refused).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_minime")),
            "{refused}"
        );
    }
    app.call("PATCH", "/api/catalog/admin/items/fresh", Some(json!({"status": "published"})), Some(&admin)).await;
    assert_eq!(pick("fresh").await.body["profile"]["minime"], "fresh");
    assert_eq!(admin_item(&app, &admin, "fresh").await["usage"], 1);

    // Retiring takes a 미니미 off the picker; a built-in stays pickable because the app ships it.
    let path = "/api/catalog/admin/bulk-status";
    let bulk = app.call("POST", path, Some(json!({"ids": ["fresh", "man"], "status": "retired"})), Some(&admin)).await;
    let statuses: Vec<(&str, &str)> = bulk.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["id"].as_str().unwrap(), item["status"].as_str().unwrap()))
        .collect();
    assert_eq!(statuses, [("fresh", "retired"), ("man", "retired")]);
    let public = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    assert!(!public.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "fresh" || item["id"] == "man"));
    assert_eq!(pick("fresh").await.body["code"], "invalid_minime");
    assert_eq!(pick("man").await.body["profile"]["minime"], "man");
    let bad = app.call("POST", path, Some(json!({"ids": [], "status": "retired"})), Some(&admin)).await;
    assert_eq!(bad.body["code"], "invalid_ids");
    let bad = app.call("POST", path, Some(json!({"ids": ["fresh"], "status": "gone"})), Some(&admin)).await;
    assert_eq!(bad.body["code"], "invalid_status");
    assert_eq!(
        app.call("POST", path, Some(json!({"ids": ["fresh"], "status": "draft"})), Some(&member)).await.status,
        StatusCode::FORBIDDEN
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 캐릭터_서버_프록시는_관리자만_운영자_토큰으로_통과한다() {
    let seen = Seen::default();
    let app = factory_app(&seen, Studio::standard()).await;
    let member = app.register("member_g", "회원").await;
    let admin = app.register("operator_g", "운영자").await;
    app.make_admin("operator_g").await;
    let path = "/api/factory/avatar-factory/capabilities?probe=1";
    assert_eq!(app.call("GET", path, None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("GET", path, None, Some(&member)).await.status, StatusCode::FORBIDDEN);
    let reply = app.call("GET", path, None, Some(&admin)).await;
    assert_eq!(reply.body["ok"], true);
    let call = seen.0.lock().unwrap().last().cloned().unwrap();
    assert_eq!(call.uri, "/api/avatar-factory/capabilities?probe=1");
    assert!(call.authorization.unwrap().starts_with("Bearer "));
    assert_eq!(call.cookie, None);
    assert_eq!(app.call("GET", "/api/factory/a/../b", None, Some(&admin)).await.status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

async fn studio_app(seen: &Seen, access: FactoryAccess, paid_monthly: i64) -> TestApp {
    let url = fake_factory(seen.clone(), Studio::standard()).await;
    TestApp::new(Some(Factory { access, paid_monthly, ..factory(url) })).await
}

#[tokio::test]
async fn 스튜디오_경로는_회원에게_옷장만_열고_쓰기와_유료_작업은_설정대로_막는다() {
    let seen = Seen::default();
    let app = studio_app(&seen, FactoryAccess::Read, 0).await;
    let member = app.register("member_s", "회원").await;
    let admin = app.register("operator_s", "운영자").await;
    app.make_admin("operator_s").await;

    let wardrobe = "/api/avatar-factory/wardrobe/bodies";
    assert_eq!(app.call("GET", wardrobe, None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("GET", wardrobe, None, Some(&member)).await.body["ok"], true);
    let part = "/api/avatar-factory/jobs/job_1/native-parts/v3/top.glb";
    assert_eq!(app.call("GET", part, None, Some(&member)).await.status, StatusCode::OK);
    assert_eq!(seen.0.lock().unwrap().last().unwrap().uri, "/api/avatar-factory/jobs/job_1/native-parts/v3/top.glb");
    for other in ["/api/avatar-factory/jobs", "/api/studio/catalog", "/api/characters"] {
        assert_eq!(app.call("GET", other, None, Some(&member)).await.status, StatusCode::FORBIDDEN, "{other}");
    }
    assert_eq!(app.call("GET", "/api/studio/catalog", None, Some(&admin)).await.status, StatusCode::OK);

    let outfit = "/api/avatar-factory/wardrobe/outfits/mine";
    let read_only = app.call("PUT", outfit, Some(json!({"name": "a"})), Some(&admin)).await;
    assert_eq!(read_only.body["code"], "factory_read_only");
    let paid = app.call("POST", "/api/avatar-factory/variants", Some(json!({})), Some(&admin)).await;
    assert_eq!(paid.body["code"], "factory_paid_off");
    assert_eq!(app.call("PUT", outfit, Some(json!({})), Some(&member)).await.status, StatusCode::FORBIDDEN);
    app.cleanup().await;

    let app = studio_app(&seen, FactoryAccess::Paid, 1).await;
    let admin = app.register("operator_p", "운영자").await;
    app.make_admin("operator_p").await;
    let select = "/api/avatar-factory/jobs/job_1/native-parts/select";
    assert_eq!(app.call("POST", select, Some(json!({})), Some(&admin)).await.status, StatusCode::OK);
    let first = app.call("POST", "/api/studio/generations", Some(json!({"kind": "prop"})), Some(&admin)).await;
    assert_eq!(first.status, StatusCode::OK);
    let second = app.call("POST", "/api/studio/generations", Some(json!({"kind": "prop"})), Some(&admin)).await;
    assert_eq!((second.status, second.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    let usage = app.call("GET", "/api/catalog/admin/factory-usage", None, Some(&admin)).await;
    assert_eq!(usage.body, json!({"connected": true, "access": "paid", "paidThisMonth": 1, "paidMonthly": 1}));
    let recorded: Vec<(String, bool, Option<i16>)> =
        sqlx::query_as("SELECT path, paid, status FROM factory_requests ORDER BY id")
            .fetch_all(&app.state.db)
            .await
            .unwrap();
    assert_eq!(
        recorded,
        [
            ("avatar-factory/jobs/job_1/native-parts/select".to_owned(), false, Some(200)),
            ("studio/generations".to_owned(), true, Some(200)),
        ]
    );

    // Uploads are multipart and still need this site's origin.
    let upload = |origin: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/studio/glb-assets/upload")
            .header(header::ORIGIN, origin.to_owned())
            .header(header::COOKIE, admin.clone())
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=x")
            .body(Body::from("--x--"))
            .unwrap()
    };
    assert_eq!(app.send(upload(ORIGIN)).await.status, StatusCode::OK);
    assert_eq!(app.send(upload("https://evil.example")).await.status, StatusCode::FORBIDDEN);
    app.cleanup().await;
}

/// `text` written into a URL query.
fn encoded(text: &str) -> String {
    text.bytes()
        .map(|byte| if byte.is_ascii_alphanumeric() { char::from(byte).to_string() } else { format!("%{byte:02X}") })
        .collect()
}

#[tokio::test]
async fn 한_회원의_섬은_여덟_개만_남고_새로_저장하면_가장_오래_손대지_않은_섬이_밀려난다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_l", "주인").await;
    let save = |world: String, base: i64| {
        let (app, owner) = (&app, owner.clone());
        async move {
            let data = json!({"version": 1, "savedAt": 1, "domains": {"building": {}}});
            let body = json!({"worldId": world, "baseRevision": base, "data": data});
            app.call("PUT", "/api/homes/me/world", Some(body), Some(&owner)).await
        }
    };
    let ids = |versions: &[u32]| {
        let mut ids: Vec<String> = versions.iter().map(|at| format!("minihome-v{at}")).collect();
        ids.sort();
        ids
    };
    let kept = || async {
        sqlx::query_scalar::<_, String>("SELECT world_id FROM home_worlds ORDER BY world_id")
            .fetch_all(&app.state.db)
            .await
            .unwrap()
    };
    for at in 1..=8 {
        assert_eq!(save(format!("minihome-v{at}"), 0).await.status, StatusCode::OK, "{at}");
    }
    assert_eq!(kept().await, ids(&[1, 2, 3, 4, 5, 6, 7, 8]));

    // Saving v1 again makes v2 the one least recently updated: a ninth world takes its place, whatever its id.
    assert_eq!(save("minihome-v1".into(), 1).await.body["revision"], 2);
    let ninth = save("minihome-v9".into(), 0).await;
    assert_eq!((ninth.status, ninth.body["revision"].as_i64()), (StatusCode::OK, Some(1)), "{:?}", ninth.body);
    assert_eq!(kept().await, ids(&[1, 3, 4, 5, 6, 7, 8, 9]));
    assert_eq!(
        app.call("GET", "/api/homes/owner_l/world?worldId=minihome-v2", None, None).await.status,
        StatusCode::NO_CONTENT
    );

    // A first save of a world that exists is the usual conflict and pushes nothing out; the worlds kept save as ever.
    assert_eq!(save("minihome-v3".into(), 0).await.status, StatusCode::CONFLICT);
    assert_eq!(kept().await, ids(&[1, 3, 4, 5, 6, 7, 8, 9]));
    assert_eq!(save("minihome-v3".into(), 1).await.body["revision"], 2);

    // Five more at once: one member's saves are stored one at a time (the others are told to save again, as the page
    // does), all are kept in the end, and what is pushed out is the oldest of the rest, so the cap holds.
    let mut pending: Vec<u32> = (10..=14).collect();
    while !pending.is_empty() {
        let replies = futures_util::future::join_all(pending.iter().map(|at| save(format!("minihome-v{at}"), 0))).await;
        let mut again = Vec::new();
        for (at, reply) in pending.iter().zip(&replies) {
            match (reply.status, reply.body["code"].as_str()) {
                (StatusCode::OK, _) => {}
                (StatusCode::TOO_MANY_REQUESTS, Some("world_saving")) => again.push(*at),
                other => panic!("{at}: {other:?} {:?}", reply.body),
            }
        }
        assert!(again.len() < pending.len(), "one of them is always stored");
        pending = again;
    }
    assert_eq!(kept().await, ids(&[1, 3, 9, 10, 11, 12, 13, 14]));

    // The count is per member, and any id is fine.
    let other = app.register("other_l", "다른 주인").await;
    let body = json!({"worldId": "x", "baseRevision": 0, "data": {"version": 1, "savedAt": 1, "domains": {}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(body), Some(&other)).await.status, StatusCode::OK);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM home_worlds").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(rows, 9);
    app.cleanup().await;
}

async fn first_save(app: &TestApp, cookie: &str, world: &str) -> common::Reply {
    let body = json!({"worldId": world, "baseRevision": 0, "data": {"version": 1, "savedAt": 1, "domains": {}}});
    app.call("PUT", "/api/homes/me/world", Some(body), Some(cookie)).await
}

#[tokio::test]
async fn 섬_저장은_열_분에_백스무_번까지만_받는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("owner_t", "주인").await;
    let other = app.register("other_t", "다른 주인").await;
    // Refused attempts count like any other: a client stuck on a bad request cannot go on forever.
    for _ in 0..120 {
        assert_eq!(first_save(&app, &owner, "bad id!").await.body["code"], "invalid_world_id");
    }
    let limited = first_save(&app, &owner, "minihome-v1").await;
    assert_eq!((limited.status, limited.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert_eq!(first_save(&app, &other, "minihome-v1").await.status, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 탐색_목록은_아이디와_이름과_제목으로_찾고_와일드카드는_글자로_읽는다() {
    let app = TestApp::new(None).await;
    let mut cookies = HashMap::new();
    for (username, name, title) in [
        ("alice_q", "앨리스", "꽃밭 마을"),
        ("bob_q", "Bobby", "바다 마을"),
        ("cat_q", "a_b", "산"),
        ("dog_q", "axb", "산"),
        ("emu_q", "50%", "산"),
        ("fox_q", "5000", "산"),
        ("gnu_q", "a\\b", "산"),
        ("hen_q", "ab", "산"),
    ] {
        let cookie = app.register(username, name).await;
        app.call("PATCH", "/api/homes/me", Some(json!({"title": title})), Some(&cookie)).await;
        cookies.insert(username, cookie);
    }
    let find = |query: &str| {
        let app = &app;
        let path = format!("/api/homes?q={}", encoded(query));
        async move {
            let reply = app.call("GET", &path, None, None).await;
            assert_eq!(reply.status, StatusCode::OK, "{path}: {:?}", reply.body);
            let mut names: Vec<String> = reply.body["homes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|home| home["username"].as_str().unwrap().to_owned())
                .collect();
            names.sort();
            names
        }
    };
    assert_eq!(find("alice").await, ["alice_q"]);
    assert_eq!(find("ALICE").await, ["alice_q"]);
    assert_eq!(find("  alice  ").await, ["alice_q"]);
    assert_eq!(find("앨리").await, ["alice_q"]);
    assert_eq!(find("obb").await, ["bob_q"]);
    assert_eq!(find("바다").await, ["bob_q"]);
    assert_eq!(find("마을").await, ["alice_q", "bob_q"]);
    assert_eq!(find("nobody").await, Vec::<String>::new());
    // Blank is no filter; `%`, `_` and `\` are only themselves.
    assert_eq!(find("").await.len(), 8);
    assert_eq!(find("   ").await.len(), 8);
    assert_eq!(find("a_b").await, ["cat_q"]);
    assert_eq!(find("50%").await, ["emu_q"]);
    assert_eq!(find("%").await, ["emu_q"]);
    assert_eq!(find("a\\b").await, ["gnu_q"]);

    // Only public islands are found, and the listing's paging goes on working.
    let hidden = app
        .call(
            "PATCH",
            "/api/homes/me",
            Some(json!({"visibility": "private"})),
            cookies.get("bob_q").map(String::as_str),
        )
        .await;
    assert_eq!(hidden.status, StatusCode::OK);
    assert_eq!(find("bob").await, Vec::<String>::new());
    let first = app.call("GET", "/api/homes?q=_q&limit=3", None, None).await;
    let page: Vec<&str> =
        first.body["homes"].as_array().unwrap().iter().map(|home| home["username"].as_str().unwrap()).collect();
    assert_eq!(page.len(), 3);
    let before = first.body["homes"][2]["updatedAt"].as_str().unwrap();
    let rest = app.call("GET", &format!("/api/homes?q=_q&limit=50&before={}", encoded(before)), None, None).await;
    let rest: Vec<&str> =
        rest.body["homes"].as_array().unwrap().iter().map(|home| home["username"].as_str().unwrap()).collect();
    assert_eq!(page.len() + rest.len(), 7, "{page:?} {rest:?}");
    assert!(page.iter().all(|name| !rest.contains(name)));

    // Forty characters are the most; control characters are no search.
    assert_eq!(app.call("GET", &format!("/api/homes?q={}", "a".repeat(40)), None, None).await.status, StatusCode::OK);
    for query in ["a".repeat(41), "%00".to_owned(), "a%0Ab".to_owned()] {
        let reply = app.call("GET", &format!("/api/homes?q={query}"), None, None).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_query")),
            "{query}"
        );
    }

    // Searches are counted per address; the plain listing is not.
    for _ in 0..300 {
        rate_record(&app.state, "home-search:local".into());
    }
    let limited = app.call("GET", "/api/homes?q=alice", None, None).await;
    assert_eq!((limited.status, limited.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert_eq!(app.call("GET", "/api/homes?limit=3", None, None).await.status, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 진행이_멈춘_가져오기는_실패로_적혀_항목을_다시_가져올_수_있다() {
    let app = TestApp::new(None).await;
    for (item, status, minutes) in [("stuck", "running", 31), ("moving", "running", 1), ("waiting", "queued", 31)] {
        sqlx::query(
            "INSERT INTO catalog_imports (id, item_id, kind, label, emoji, factory_job_id, status, updated_at)
             VALUES ($1, $2, 'minime', '이름', '🙂', 'job', $3, now() - make_interval(mins => $4))",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(item)
        .bind(status)
        .bind(minutes)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    assert_eq!(mogaesup_server::imports::interrupt_stale(&app.state.db).await.unwrap(), 1);
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT item_id, status, error_code FROM catalog_imports ORDER BY item_id")
            .fetch_all(&app.state.db)
            .await
            .unwrap();
    assert_eq!(
        rows,
        [
            ("moving".into(), "running".into(), None),
            ("stuck".into(), "failed".into(), Some("interrupted".into())),
            ("waiting".into(), "queued".into(), None),
        ]
    );
    // The item is free again: a new import of it is no longer refused as one already running.
    let again = sqlx::query(
        "INSERT INTO catalog_imports (id, item_id, kind, label, emoji, factory_job_id) VALUES ($1, 'stuck', 'minime', '이름', '🙂', 'job')
         ON CONFLICT DO NOTHING",
    )
    .bind(uuid::Uuid::new_v4())
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(again.rows_affected(), 1);
    app.cleanup().await;
}
