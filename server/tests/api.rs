mod common;

use axum::{
    Json, Router,
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{ORIGIN, TestApp};
use mogaesup_server::config::{Factory, FactoryAccess, FactoryToken};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

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
            Some(json!({"statusMessage": "오늘도 느긋하게", "mood": 2, "minime": "teacher", "emoji": "👩‍🏫"})),
            Some(&owner),
        )
        .await;
    assert_eq!(patched.body["profile"]["minime"], "teacher");
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

/// A GLB of just a JSON chunk.
fn glb(json: Value) -> Vec<u8> {
    let mut chunk = serde_json::to_vec(&json).unwrap();
    while !chunk.len().is_multiple_of(4) {
        chunk.push(b' ');
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0x4654_6c67u32.to_le_bytes());
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&((12 + 8 + chunk.len()) as u32).to_le_bytes());
    bytes.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"JSON");
    bytes.extend_from_slice(&chunk);
    bytes
}

/// Rigged, with the clips the character server's Meshy delivery names.
fn character_glb() -> Vec<u8> {
    glb(json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}],
        "animations": [{"name": "idle"}, {"name": "walk"}, {"name": "run"}, {"name": "sit"}]}))
}

/// Animated but without a skin: nothing a 미니미 can be.
fn statue_glb() -> Vec<u8> {
    glb(json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]}))
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

fn factory_job(id: &str, created: &str, model_sha: &str) -> Value {
    json!({"id": id, "character_id": format!("c_{id}"), "character_name": format!("{id} 캐릭터"), "created_at": created,
        "production_mode": "character_parts", "assembly_version": "v3", "assembly_origin": "generated_parts_fitted_to_meshy_body",
        "character_flow": {"stage": "complete"}, "assembly_artifacts": [{"name": "model.glb", "sha256": model_sha}]})
}

/// One request the fake character server received.
#[derive(Clone, Debug, PartialEq)]
struct Call {
    uri: String,
    authorization: Option<String>,
    api_key: Option<String>,
    cookie: Option<String>,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Call>>>);

/// A character server stand-in with three sealed characters and one still assembling: `job_1` has a chosen face,
/// `statue` has no rig, `tampered` serves bytes its record does not match. Files redirect to a "presigned" URL.
async fn fake_factory(seen: Seen) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let jobs = json!({"jobs": [
        factory_job("job_1", "2026-09-03T00:00:00Z", &sha256(&character_glb())),
        factory_job("statue", "2026-09-02T00:00:00Z", &sha256(&statue_glb())),
        factory_job("tampered", "2026-09-01T00:00:00Z", &"0".repeat(64)),
        {"id": "wip", "production_mode": "character_parts", "assembly_version": null, "character_flow": {"stage": "assemble"}},
    ]});
    let url = base.clone();
    let app = Router::new().fallback(move |request: Request| {
        let (seen, jobs, base) = (seen.clone(), jobs.clone(), base.clone());
        async move {
            let headers = request.headers();
            let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            seen.0.lock().unwrap().push(Call {
                uri: request.uri().to_string(),
                authorization: get("authorization"),
                api_key: get("x-api-key"),
                cookie: get("cookie"),
            });
            let redirect = |file: &str| {
                (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, format!("{base}/signed/{file}"))]).into_response()
            };
            let path = request.uri().path().trim_start_matches('/').to_owned();
            let segments: Vec<&str> = path.split('/').collect();
            match segments.as_slice() {
                ["api", "avatar-factory", "jobs"] => Json(jobs).into_response(),
                ["api", "studio", "catalog"] => {
                    Json(json!({"items": {}, "parts": {"job_1:body": {"name": "공장 영웅"}}, "characters": {}}))
                        .into_response()
                }
                ["api", "avatar-factory", "jobs", id] => {
                    match jobs["jobs"].as_array().unwrap().iter().find(|job| job["id"] == *id) {
                        Some(job) => Json(job.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
                ["api", "studio", "bodies", "job_1", "v3", "expressions"] => Json(json!({"selected": "smile",
                    "items": [{"id": "smile", "artifacts": [{"name": "model.glb", "sha256": sha256(&character_glb())}]}]}))
                .into_response(),
                ["api", "studio", "bodies", "job_1", "v3", "expressions", "smile", "model.glb"] => redirect("face.glb"),
                ["api", "avatar-factory", "jobs", "statue", "native-parts", "v3", "model.glb"] => redirect("statue.glb"),
                ["api", "avatar-factory", "jobs", _, "native-parts", "v3", "model.glb"] => redirect("plain.glb"),
                ["api", "avatar-factory", "jobs", _, "native-parts", "v3", "front.png"] => redirect("front.png"),
                ["signed", "face.glb" | "plain.glb"] => character_glb().into_response(),
                ["signed", "statue.glb"] => statue_glb().into_response(),
                ["signed", "front.png"] => png(800, 800).into_response(),
                ["api", ..] if path.contains("/expressions") => StatusCode::NOT_FOUND.into_response(),
                _ => Json(json!({"ok": true})).into_response(),
            }
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}
#[tokio::test]
async fn 관리자는_캐릭터_서버의_완성_캐릭터를_골라_저장소로_가져오고_공개한다() {
    let seen = Seen::default();
    let url = fake_factory(seen.clone()).await;
    let token =
        FactoryToken { key: vec![3; 32], issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 1 };
    let app = TestApp::new(Some(Factory {
        url,
        api_key: Some("factory-key".into()),
        token: Some(token),
        access: FactoryAccess::Read,
        paid_monthly: 0,
    }))
    .await;
    let member = app.register("member_f", "회원").await;
    let admin = app.register("operator_f", "운영자").await;
    app.make_admin("operator_f").await;
    assert_eq!(
        app.call("GET", "/api/catalog/items?kind=minime", None, None).await.body["items"].as_array().unwrap().len(),
        8
    );

    let listing = "/api/catalog/admin/factory-characters";
    assert_eq!(app.call("GET", listing, None, Some(&member)).await.status, StatusCode::FORBIDDEN);
    let characters = app.call("GET", listing, None, Some(&admin)).await;
    let ids: Vec<&str> =
        characters.body["characters"].as_array().unwrap().iter().map(|c| c["jobId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["job_1", "statue", "tampered"]);
    let first = &characters.body["characters"][0];
    assert_eq!((first["name"].as_str(), first["version"].as_str()), (Some("공장 영웅"), Some("v3")));
    assert_eq!(first["thumbnailUrl"], "/api/factory/avatar-factory/jobs/job_1/native-parts/v3/front.png");
    assert_eq!(first["imported"], Value::Null);
    let calls = seen.0.lock().unwrap().clone();
    assert_eq!(calls[0].api_key.as_deref(), Some("factory-key"));
    let bearer = calls[0].authorization.as_deref().unwrap().trim_start_matches("Bearer ");
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(bearer.split('.').nth(1).unwrap()).unwrap()).unwrap();
    assert_eq!((claims["userId"].as_i64(), claims["roles"][0].as_str()), (Some(1), Some("ADMIN")));

    let import = |job: &str, id: &str| json!({"id": id, "kind": "minime", "label": "공장 영웅", "emoji": "🦸", "factoryJobId": job});
    let path = "/api/catalog/admin/import";
    assert_eq!(
        app.call("POST", path, Some(import("job_1", "hero")), Some(&member)).await.status,
        StatusCode::FORBIDDEN
    );
    let imported = app.call("POST", path, Some(import("job_1", "factory-hero")), Some(&admin)).await;
    assert_eq!(imported.status, StatusCode::CREATED, "{:?}", imported.body);
    assert_eq!(imported.body["status"], "draft");
    assert_eq!(imported.body["sourceRef"], "job_1/v3/smile");
    assert_eq!(imported.body["clips"], json!(["idle", "run", "walk"]));
    let model_url = imported.body["modelUrl"].as_str().unwrap().to_owned();
    assert_eq!(model_url, format!("/models/{}.glb", sha256(&character_glb())));
    let signed: Vec<Call> =
        seen.0.lock().unwrap().iter().filter(|call| call.uri.starts_with("/signed/")).cloned().collect();
    assert_eq!(
        signed.iter().map(|call| call.uri.as_str()).collect::<Vec<_>>(),
        ["/signed/face.glb", "/signed/front.png"]
    );
    assert!(signed.iter().all(|call| call.authorization.is_none() && call.api_key.is_none() && call.cookie.is_none()));

    let model = app.call("GET", &model_url, None, None).await;
    assert_eq!(model.bytes, character_glb());
    assert!(model.headers[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
    let picture = app.call("GET", imported.body["thumbnailUrl"].as_str().unwrap(), None, None).await;
    let picture = image::load_from_memory(&picture.bytes).unwrap();
    assert_eq!((picture.width(), picture.height()), (256, 256));

    let characters = app.call("GET", listing, None, Some(&admin)).await;
    assert_eq!(
        characters.body["characters"][0]["imported"],
        json!({"id": "factory-hero", "status": "draft", "current": true})
    );
    let hidden = app.call("GET", "/api/catalog/items", None, None).await;
    assert!(!hidden.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "factory-hero"));
    app.call("PATCH", "/api/catalog/admin/items/factory-hero", Some(json!({"status": "published"})), Some(&admin))
        .await;
    let shown = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    assert!(shown.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "factory-hero"));

    let refused = |job: &'static str| {
        let app = &app;
        let admin = admin.clone();
        async move { app.call("POST", path, Some(import(job, "other")), Some(&admin)).await }
    };
    assert_eq!(refused("statue").await.body["code"], "not_playable");
    assert_eq!(refused("tampered").await.body["code"], "factory_checksum");
    assert_eq!(refused("wip").await.body["code"], "factory_not_sealed");
    assert_eq!(refused("nobody").await.status, StatusCode::NOT_FOUND);
    assert_eq!(refused("../etc").await.status, StatusCode::NOT_FOUND);
    assert!(
        app.call("GET", "/api/catalog/admin/items", None, Some(&admin)).await.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "other")
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 캐릭터_서버_프록시는_관리자만_운영자_토큰으로_통과한다() {
    let seen = Seen::default();
    let url = fake_factory(seen.clone()).await;
    let token =
        FactoryToken { key: vec![5; 32], issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 1 };
    let app = TestApp::new(Some(Factory {
        url,
        api_key: None,
        token: Some(token),
        access: FactoryAccess::Read,
        paid_monthly: 0,
    }))
    .await;
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
    let url = fake_factory(seen.clone()).await;
    let token =
        FactoryToken { key: vec![7; 32], issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 1 };
    TestApp::new(Some(Factory { url, api_key: None, token: Some(token), access, paid_monthly })).await
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
