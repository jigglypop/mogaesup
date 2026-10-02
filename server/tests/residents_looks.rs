//! 주민 (NPCs) and members' own looks: the packaged figures giving way to one fallback, residents imported from the
//! studio and placed on islands, and a wardrobe look assembled into the island's player model.

mod common;

use axum::{Json, Router, extract::Request, http::StatusCode, response::IntoResponse};
use common::{TestApp, TestDb};
use mogaesup_server::{
    MIGRATOR,
    config::{Factory, FactoryAccess, FactoryToken},
    glb, looks,
};
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};

fn sha256(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

fn f32s(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn png(color: [u8; 4]) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(4, 4, image::Rgba(color)).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A GLB of `json` whose buffer view i holds piece i.
fn build(mut json: Value, pieces: &[Vec<u8>]) -> Vec<u8> {
    let mut bin = Vec::new();
    let mut views = Vec::new();
    for piece in pieces {
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        views.push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": piece.len()}));
        bin.extend_from_slice(piece);
    }
    json["bufferViews"] = views.into();
    json["buffers"] = json!([{"byteLength": bin.len()}]);
    glb::join(&json, &bin)
}

const INVERSE_BINDS: [f32; 32] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., -1., 0., 1., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.,
    0., -1.5, 0., 1.,
];

/// Root › Hips › Head; `head` is how far the head stands above the hips.
fn bones(head: f64, mesh_name: &str, slot: Option<&str>) -> Vec<Value> {
    let mut mesh = json!({"name": mesh_name, "mesh": 0, "skin": 0});
    if let Some(slot) = slot {
        mesh["extras"] = json!({"standard_slot": slot});
    }
    vec![
        json!({"name": "Root", "children": [1, 3]}),
        json!({"name": "Hips", "translation": [0.0, 1.0, 0.0], "children": [2]}),
        json!({"name": "Head", "translation": [0.0, head, 0.0]}),
        mesh,
    ]
}

/// The wardrobe body: a skinned quad with a white map, standing and walking.
fn body_glb() -> Vec<u8> {
    let clip = |name: &str| json!({"name": name, "samplers": [{"input": 5, "output": 6}], "channels": [{"sampler": 0, "target": {"node": 2, "path": "rotation"}}]});
    build(
        json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": bones(0.5, "Body", None),
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 2, "WEIGHTS_0": 3}, "indices": 1, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
            "textures": [{"source": 0}], "images": [{"bufferView": 7, "mimeType": "image/png"}],
            "skins": [{"joints": [1, 2], "inverseBindMatrices": 4}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1.7, 0]},
                {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"},
                {"bufferView": 2, "componentType": 5121, "count": 4, "type": "VEC4"},
                {"bufferView": 3, "componentType": 5126, "count": 4, "type": "VEC4"},
                {"bufferView": 4, "componentType": 5126, "count": 2, "type": "MAT4"},
                {"bufferView": 5, "componentType": 5126, "count": 2, "type": "SCALAR", "min": [0], "max": [1]},
                {"bufferView": 6, "componentType": 5126, "count": 2, "type": "VEC4"}],
            "animations": [clip("Idle"), clip("Walking"), clip("Running")],
        }),
        &[
            f32s(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.7, 0.0, 0.0, 1.7, 0.0]),
            [0u16, 1, 2, 0, 2, 3].iter().flat_map(|i| i.to_le_bytes()).collect(),
            [0u8, 0, 0, 0].repeat(4),
            f32s(&[1.0, 0.0, 0.0, 0.0].repeat(4)),
            f32s(&INVERSE_BINDS),
            f32s(&[0.0, 1.0]),
            f32s(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]),
            png([255, 255, 255, 255]),
        ],
    )
}

/// A part on the head bone, in `slot`, with a grey map; `head` other than 0.5 puts its bones where the body has none.
fn part_glb(slot: &str, head: f64) -> Vec<u8> {
    build(
        json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": bones(head, "Piece", Some(slot)),
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
            "textures": [{"source": 0}], "images": [{"bufferView": 4, "mimeType": "image/png"}],
            "skins": [{"joints": [1, 2], "inverseBindMatrices": 3}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 1.5, 0], "max": [1, 2, 0]},
                {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
                {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
                {"bufferView": 3, "componentType": 5126, "count": 2, "type": "MAT4"}],
        }),
        &[
            f32s(&[0.0, 1.5, 0.0, 1.0, 1.5, 0.0, 0.5, 2.0, 0.0]),
            [1u8, 0, 0, 0].repeat(3),
            f32s(&[1.0, 0.0, 0.0, 0.0].repeat(3)),
            f32s(&INVERSE_BINDS),
            png([128, 128, 128, 255]),
        ],
    )
}

/// A hat of a hundred and fifty thousand triangles (all of them degenerate, which the bake does not mind): worn, the
/// look is too heavy to store.
fn heavy_glb() -> Vec<u8> {
    build(
        json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": bones(0.5, "Piece", Some("hat")),
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}, "indices": 4, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
            "textures": [{"source": 0}], "images": [{"bufferView": 5, "mimeType": "image/png"}],
            "skins": [{"joints": [1, 2], "inverseBindMatrices": 3}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 1.5, 0], "max": [1, 2, 0]},
                {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
                {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
                {"bufferView": 3, "componentType": 5126, "count": 2, "type": "MAT4"},
                {"bufferView": 4, "componentType": 5123, "count": 450_003, "type": "SCALAR"}],
        }),
        &[
            f32s(&[0.0, 1.5, 0.0, 1.0, 1.5, 0.0, 0.5, 2.0, 0.0]),
            [1u8, 0, 0, 0].repeat(3),
            f32s(&[1.0, 0.0, 0.0, 0.0].repeat(3)),
            f32s(&INVERSE_BINDS),
            vec![0; 450_003 * 2],
            png([128, 128, 128, 255]),
        ],
    )
}

/// A studio character that stands but never walks.
fn standing_glb() -> Vec<u8> {
    let bytes = body_glb();
    let (mut json, bin) = glb::split(&bytes).unwrap();
    let mut wave = json["animations"][0].clone();
    wave["name"] = "Wave".into();
    json["animations"] = json!([json["animations"][0].clone(), wave]);
    glb::join(&json, bin)
}

/// What the fake character server knows: two finished characters, and a wardrobe with one body and parts that each go
/// wrong in their own way: `bare` has no coverage record, `twisted` one that is not base64, `plain` no colour regions,
/// `flat` a 422 for them (no texture), `blurred` a mask that is not a picture, `heavy` too many triangles.
struct Studio {
    body: Vec<u8>,
    hat: Vec<u8>,
    tall_hat: Vec<u8>,
    heavy_hat: Vec<u8>,
    standing: Vec<u8>,
    /// Wardrobe requests seen, by path.
    seen: Mutex<Vec<String>>,
}

fn job(id: &str, model: &[u8]) -> Value {
    json!({"id": id, "character_id": format!("c_{id}"), "character_name": format!("{id} 캐릭터"), "created_at": "2026-09-20T00:00:00Z",
        "production_mode": "character_parts", "assembly_version": "v1", "assembly_origin": "generated_parts_fitted_to_meshy_body",
        "character_flow": {"stage": "complete"}, "assembly_artifacts": [{"name": "model.glb", "sha256": sha256(model)}]})
}

impl Studio {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            body: body_glb(),
            hat: part_glb("hat", 0.5),
            tall_hat: part_glb("hat", 0.8),
            heavy_hat: heavy_glb(),
            standing: standing_glb(),
            seen: Mutex::default(),
        })
    }

    fn parts(&self) -> Value {
        let part = |job: &str, bytes: &[u8]| json!({"job_id": job, "version": "v2", "slot": "hat", "name": format!("{job} 모자"), "sha256": sha256(bytes)});
        let plain: Vec<Value> =
            ["hats", "bare", "twisted", "plain", "flat", "blurred"].iter().map(|job| part(job, &self.hat)).collect();
        let others = [part("tall", &self.tall_hat), part("heavy", &self.heavy_hat)];
        let parts = [plain, others.to_vec()].concat();
        json!({"body": {"job_id": "body", "version": "v1"}, "parts": parts})
    }

    fn answer(&self, path: &str) -> axum::response::Response {
        self.seen.lock().unwrap().push(path.to_owned());
        let file = |bytes: &[u8]| bytes.to_vec().into_response();
        let segments: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
        match segments.as_slice() {
            ["avatar-factory", "jobs"] => Json(json!({"jobs": [job("resident", &self.standing)]})).into_response(),
            ["avatar-factory", "jobs", "resident"] => Json(job("resident", &self.standing)).into_response(),
            ["studio", "catalog"] => Json(json!({"items": {}, "parts": {}, "characters": {}})).into_response(),
            ["avatar-factory", "jobs", "resident", "native-parts", "v1", "model.glb"] => file(&self.standing),
            ["avatar-factory", "wardrobe", "bodies"] => Json(json!({"revision": "1", "bodies": [
                {"job_id": "body", "version": "v1", "body_sha256": sha256(&self.body), "name": "기본 몸", "is_default": true}]}))
            .into_response(),
            ["avatar-factory", "wardrobe", "bodies", "body", "parts"] => Json(self.parts()).into_response(),
            ["avatar-factory", "jobs", "body", "native-parts", "v1", "body.glb"] => file(&self.body),
            ["avatar-factory", "jobs", "tall", "native-parts", "v2", "hat.glb"] => file(&self.tall_hat),
            ["avatar-factory", "jobs", "heavy", "native-parts", "v2", "hat.glb"] => file(&self.heavy_hat),
            ["avatar-factory", "jobs", _, "native-parts", "v2", "hat.glb"] => file(&self.hat),
            ["avatar-factory", "wardrobe", "bodies", "body", "coverage", "bare", "hat"] => {
                StatusCode::NOT_FOUND.into_response()
            }
            ["avatar-factory", "wardrobe", "bodies", "body", "coverage", "twisted", "hat"] => {
                Json(json!({"slot": "hat", "hidden": {"0:0": "not base64!"}, "triangles": {}, "covers_bottom": false}))
                    .into_response()
            }
            ["avatar-factory", "wardrobe", "bodies", "body", "coverage", _, "hat"] => {
                Json(json!({"slot": "hat", "hidden": {}, "triangles": {}, "covers_bottom": false})).into_response()
            }
            // `plain` has no colour regions at all; `flat` has no texture to colour.
            ["avatar-factory", "wardrobe", "colors", "plain", "hat"] => StatusCode::NOT_FOUND.into_response(),
            ["avatar-factory", "wardrobe", "colors", "flat", "hat"] => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({"code": "no_texture", "message": "색을 바꿀 텍스처가 없는 파츠입니다."})),
            )
                .into_response(),
            ["avatar-factory", "wardrobe", "colors", "blurred", "hat", "mask"] => file(b"not a picture"),
            ["avatar-factory", "wardrobe", "colors", _, "hat"] => {
                Json(json!({"slot": "hat", "material": 0, "regions": [{"index": 0, "color": "#808080", "share": 1.0, "light": 0.2}]}))
                    .into_response()
            }
            ["avatar-factory", "wardrobe", "colors", _, "hat", "mask"] => file(&png([255, 0, 0, 255])),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

async fn fake_factory(studio: Arc<Studio>) -> Factory {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(move |request: Request| {
        let studio = studio.clone();
        async move { studio.answer(request.uri().path()) }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
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

async fn until<F, Fut>(what: &str, mut check: F) -> Value
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    for _ in 0..1200 {
        if let Some(value) = check().await {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{what} did not happen");
}

#[tokio::test]
async fn 포장된_미니미는_기본_하나만_남고_고른_섬은_기본으로_돌아간다() {
    use sqlx::{Row, migrate::Migrate};
    let test_db = TestDb::create().await;
    let db = &test_db.pool;
    let this = MIGRATOR.iter().find(|m| m.description == "residents looks").unwrap().version;
    let mut conn = db.acquire().await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in MIGRATOR.iter().filter(|m| m.version < this) {
        conn.apply(migration).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash) VALUES
         ('00000000-0000-0000-0000-000000000001', 'teach', '선생', 'x'),
         ('00000000-0000-0000-0000-000000000002', 'police', '경찰', 'x'),
         ('00000000-0000-0000-0000-000000000003', 'studio', '스튜디오', 'x')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, source, status) VALUES
         ('hero', 'minime', '영웅', '🦸', '/models/hero.glb', 'factory', 'published')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    // Picked with its emoji; picked with an emoji of the owner's own; a studio character.
    sqlx::query(
        "INSERT INTO homes (owner_id, title, minime, emoji) VALUES
         ('00000000-0000-0000-0000-000000000001', '섬', 'teacher', '👩‍🏫'),
         ('00000000-0000-0000-0000-000000000002', '섬', 'police', '🌸'),
         ('00000000-0000-0000-0000-000000000003', '섬', 'hero', '🦸')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    drop(conn);
    MIGRATOR.run(db).await.unwrap();

    let homes: Vec<(String, String)> = sqlx::query("SELECT minime, emoji FROM homes ORDER BY owner_id")
        .fetch_all(db)
        .await
        .unwrap()
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect();
    assert_eq!(homes, [("man".into(), "🧑".into()), ("man".into(), "🌸".into()), ("hero".into(), "🦸".into())]);
    let minimes: Vec<(String, String, i32)> =
        sqlx::query("SELECT id, source, sort_order FROM catalog_items WHERE kind = 'minime' ORDER BY sort_order")
            .fetch_all(db)
            .await
            .unwrap()
            .iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect();
    assert_eq!(minimes, [("hero".into(), "factory".into(), 100), ("man".into(), "builtin".into(), 1000)]);
    test_db.remove().await;

    // On a fresh server the fallback is the only packaged 미니미, still pickable; a removed one is not.
    let app = TestApp::new(None).await;
    let member = app.register("member_fallback", "회원").await;
    let public = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    let ids: Vec<&str> =
        public.body["items"].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["man"]);
    let mine = app.call("GET", "/api/homes/me", None, Some(&member)).await;
    assert_eq!(mine.body["profile"]["minime"], "man");
    let refused = app.call("PATCH", "/api/homes/me", Some(json!({"minime": "teacher"})), Some(&member)).await;
    assert_eq!(refused.body["code"], "invalid_minime");
    app.cleanup().await;
}

async fn resident_app() -> (TestApp, Arc<Studio>, String, String) {
    let studio = Studio::new();
    let app = TestApp::new(Some(fake_factory(studio.clone()).await)).await;
    let admin = app.register("operator_r", "운영자").await;
    app.make_admin("operator_r").await;
    let owner = app.register("owner_r", "주인").await;
    (app, studio, admin, owner)
}

async fn imported(app: &TestApp, admin: &str, body: Value) -> Value {
    let queued = app.call("POST", "/api/catalog/admin/import", Some(body), Some(admin)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    let id = queued.body["id"].as_str().unwrap().to_owned();
    until("the import", || async {
        let reply = app.call("GET", &format!("/api/catalog/admin/imports/{id}"), None, Some(admin)).await;
        matches!(reply.body["status"].as_str(), Some("done" | "failed")).then_some(reply.body)
    })
    .await
}

fn world(residents: Value) -> Value {
    json!({"worldId": "minihome-v6", "baseRevision": 0, "data": {"version": 1, "savedAt": 1,
        "domains": {"building": {}, "residents": {"version": 1, "residents": residents}}}})
}

fn resident(id: &str, npc: &str) -> Value {
    json!({"id": id, "npc": npc, "name": "모개", "greeting": "우리 섬에 온 걸 환영해!", "position": [1.8, 0.0, -12.0], "rotation": 0.0})
}

#[tokio::test]
async fn 관리자가_가져온_주민을_섬_주인이_인사말과_함께_두고_방문자도_본다() {
    let (app, _studio, admin, owner) = resident_app().await;
    // A character that never walks cannot be a 미니미, but stands fine as a resident.
    let body = |kind: &str, id: &str| json!({"id": id, "kind": kind, "label": "모개", "emoji": "🧑‍🌾", "factoryJobId": "resident"});
    let refused = imported(&app, &admin, body("minime", "npc-walker")).await;
    assert_eq!((refused["status"].as_str(), refused["errorCode"].as_str()), (Some("failed"), Some("not_playable")));
    let done = imported(&app, &admin, body("npc", "npc-mogae")).await;
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(done["kind"], "npc");
    let clips =
        done["report"]["checks"].as_array().unwrap().iter().find(|check| check["code"] == "clips").unwrap().clone();
    assert_eq!(
        (clips["level"].as_str(), clips["message"].as_str()),
        (Some("ok"), Some("필요한 애니메이션(idle)이 있습니다."))
    );
    // The same item cannot turn into a 미니미 on a later import.
    let changed = app.call("POST", "/api/catalog/admin/import", Some(body("minime", "npc-mogae")), Some(&admin)).await;
    assert_eq!(changed.body["code"], "kind_mismatch");
    let listing = app.call("GET", "/api/catalog/admin/factory-characters", None, Some(&admin)).await;
    assert_eq!(listing.body["characters"][0]["imported"]["kind"], "npc");

    // Drafts stay off the islands' drawer until published; the 미니미 picker never lists residents.
    let npcs = || async { app.call("GET", "/api/catalog/items?kind=npc", None, None).await.body["items"].clone() };
    assert_eq!(npcs().await, json!([]));
    app.call("PATCH", "/api/catalog/admin/items/npc-mogae", Some(json!({"status": "published"})), Some(&admin)).await;
    let items = npcs().await;
    assert_eq!((items[0]["id"].as_str(), items[0]["kind"].as_str()), (Some("npc-mogae"), Some("npc")));
    assert!(items[0]["modelUrl"].as_str().unwrap().starts_with("/models/"));
    let minimes = app.call("GET", "/api/catalog/items?kind=minime", None, None).await;
    assert!(!minimes.body["items"].as_array().unwrap().iter().any(|item| item["id"] == "npc-mogae"));
    let as_minime = app.call("PATCH", "/api/homes/me", Some(json!({"minime": "npc-mogae"})), Some(&owner)).await;
    assert_eq!(as_minime.body["code"], "invalid_minime");

    // The owner stands the resident on the island with a greeting, saved with the island.
    let saved =
        app.call("PUT", "/api/homes/me/world", Some(world(json!([resident("r1", "npc-mogae")]))), Some(&owner)).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    // A visitor, signed in or not, reads the same residents.
    let visitor = app.register("visitor_r", "손님").await;
    for cookie in [Some(visitor.as_str()), None] {
        let read = app.call("GET", "/api/homes/owner_r/world?worldId=minihome-v6", None, cookie).await;
        assert_eq!(read.body["data"]["domains"]["residents"]["residents"][0]["greeting"], "우리 섬에 온 걸 환영해!");
    }

    // Anything but a catalog resident, or a malformed one, is refused and the island keeps its last save.
    let update = |residents: Value| {
        let mut body = world(residents);
        body["baseRevision"] = json!(1);
        body
    };
    for residents in [
        json!([resident("r1", "nobody")]),
        json!([resident("r1", "man")]),
        json!([{"id": "r1", "npc": "npc-mogae", "name": "", "greeting": "", "position": [0, 0, 0], "rotation": 0}]),
        json!([resident("r1", "npc-mogae"), resident("r1", "npc-mogae")]),
        json!((0..13).map(|i| resident(&format!("r{i}"), "npc-mogae")).collect::<Vec<_>>()),
    ] {
        let reply = app.call("PUT", "/api/homes/me/world", Some(update(residents.clone())), Some(&owner)).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_residents")),
            "{residents}"
        );
    }
    // Retiring a resident keeps islands that have it saving; the drawer no longer offers it.
    app.call("PATCH", "/api/catalog/admin/items/npc-mogae", Some(json!({"status": "retired"})), Some(&admin)).await;
    let kept =
        app.call("PUT", "/api/homes/me/world", Some(update(json!([resident("r1", "npc-mogae")]))), Some(&owner)).await;
    assert_eq!(kept.status, StatusCode::OK, "{:?}", kept.body);
    assert_eq!(npcs().await, json!([]));
    app.cleanup().await;
}

fn look(part_job: &str) -> Value {
    let studio = Studio::new();
    let sha = match part_job {
        "tall" => sha256(&studio.tall_hat),
        "heavy" => sha256(&studio.heavy_hat),
        _ => sha256(&studio.hat),
    };
    json!({"body": {"jobId": "body", "version": "v1"}, "parts": {"hat": {"jobId": part_job, "version": "v2", "sha256": sha}},
        "hairColor": null, "colors": {"hat": {"0": "#00ff00"}}})
}

/// The same look in another colour: another model.
fn recolored(part_job: &str, color: &str) -> Value {
    let mut look = look(part_job);
    look["colors"]["hat"]["0"] = json!(color);
    look
}

/// Every import slot: while held, a bake that has everything it needs waits for its turn at the heavy work.
async fn busy_slots(app: &TestApp) -> tokio::sync::OwnedSemaphorePermit {
    app.state.imports.clone().acquire_many_owned(mogaesup_server::imports::SLOTS as u32).await.unwrap()
}

fn stored_models(app: &TestApp) -> usize {
    let files = std::fs::read_dir(&app.model_dir).unwrap();
    files.filter(|file| file.as_ref().unwrap().file_name().to_string_lossy().ends_with(".glb")).count()
}

async fn settled(app: &TestApp, member: &str) -> Value {
    until("the look to settle", || async {
        let reply = app.call("GET", "/api/looks/me", None, Some(member)).await;
        (reply.body["look"]["status"] != "baking").then(|| reply.body["look"].clone())
    })
    .await
}

#[tokio::test]
async fn 옷장에서_꾸민_모습을_저장하면_한_모델로_조립되어_섬에서_입는다() {
    let (app, studio, _admin, member) = resident_app().await;
    assert_eq!(app.call("GET", "/api/looks/me", None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("GET", "/api/looks/me", None, Some(&member)).await.body, json!({"look": null}));
    assert_eq!(app.call("PUT", "/api/looks/me", Some(look("hats")), None).await.status, StatusCode::UNAUTHORIZED);

    let queued = app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    assert_eq!(queued.body["look"]["status"], "baking");
    let ready = settled(&app, &member).await;
    assert_eq!((ready["status"].as_str(), ready["worn"].as_bool()), (Some("ready"), Some(true)), "{ready}");
    let model = ready["modelUrl"].as_str().unwrap().to_owned();
    assert!(model.starts_with("/models/") && model.ends_with(".glb"), "{model}");
    assert_eq!(ready["report"]["parts"], json!([{"slot": "hat", "meshes": 1}]));
    assert_eq!(ready["report"]["recoloredMaterials"], 1);
    assert_eq!(ready["request"]["colors"], json!({"hat": {"0": "#00ff00"}}));
    // The stored model is one playable, rigged GLB served like any catalog model.
    let served = app.call("GET", &model, None, None).await;
    assert_eq!(served.status, StatusCode::OK);
    let details = glb::details(&served.bytes).unwrap();
    assert!(details.summary().playable());
    assert_eq!(details.meshes, 2);
    let seen = studio.seen.lock().unwrap().clone();
    for path in
        ["/api/avatar-factory/jobs/body/native-parts/v1/body.glb", "/api/avatar-factory/wardrobe/colors/hats/hat/mask"]
    {
        assert!(seen.iter().any(|seen| seen == path), "{path} in {seen:?}");
    }

    // Picking a 미니미 takes the look off; wearing it again puts it back. Only a ready model can be worn.
    app.call("PATCH", "/api/homes/me", Some(json!({"minime": "man"})), Some(&member)).await;
    assert_eq!(app.call("GET", "/api/looks/me", None, Some(&member)).await.body["look"]["worn"], false);
    let worn = app.call("PATCH", "/api/looks/me", Some(json!({"worn": true})), Some(&member)).await;
    assert_eq!(worn.body["look"]["worn"], true);

    // A part whose bones stand elsewhere fails with a reason, and the last model stays worn.
    let misfit = app.call("PUT", "/api/looks/me", Some(look("tall")), Some(&member)).await;
    assert_eq!(misfit.status, StatusCode::ACCEPTED);
    let failed = settled(&app, &member).await;
    assert_eq!((failed["status"].as_str(), failed["error"]["code"].as_str()), (Some("failed"), Some("look_part_rig")));
    assert_eq!((failed["modelUrl"].as_str(), failed["worn"].as_bool()), (Some(model.as_str()), Some(true)));

    // Parts are checked against the wardrobe before anything is made: another file, another body, a made-up slot.
    let mut other_file = look("hats");
    other_file["parts"]["hat"]["sha256"] = json!("0".repeat(64));
    let mut other_body = look("hats");
    other_body["body"]["version"] = json!("v0");
    let mut unknown = look("hats");
    unknown["parts"]["h4t"] = json!({"jobId": "x", "version": "v", "sha256": "0".repeat(64)});
    for (body, code) in
        [(other_file, "look_part_changed"), (other_body, "look_body_changed"), (unknown, "invalid_look")]
    {
        let reply = app.call("PUT", "/api/looks/me", Some(body), Some(&member)).await;
        assert_eq!(reply.body["code"], code);
    }

    // A member without a look cannot wear one; each member only ever reaches their own.
    let other = app.register("other_l", "다른 회원").await;
    assert_eq!(
        app.call("PATCH", "/api/looks/me", Some(json!({"worn": true})), Some(&other)).await.body["code"],
        "look_not_found"
    );
    assert_eq!(app.call("GET", "/api/looks/me", None, Some(&other)).await.body, json!({"look": null}));
    assert_eq!(app.call("GET", "/api/looks/member_x", None, Some(&other)).await.status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn 읽을_수_없는_가림_정보와_입힐_수_없는_색은_조용히_넘기지_않고_실패로_알린다() {
    let (app, _studio, _admin, member) = resident_app().await;
    for (job, code) in [
        ("bare", "look_coverage"),
        ("twisted", "look_coverage"),
        ("plain", "look_colors"),
        ("flat", "look_colors"),
        ("blurred", "look_colors"),
    ] {
        let queued = app.call("PUT", "/api/looks/me", Some(look(job)), Some(&member)).await;
        assert_eq!(queued.status, StatusCode::ACCEPTED, "{job}: {:?}", queued.body);
        let failed = settled(&app, &member).await;
        assert_eq!(
            (failed["status"].as_str(), failed["error"]["code"].as_str()),
            (Some("failed"), Some(code)),
            "{job}"
        );
        assert!(failed["error"]["message"].as_str().unwrap().starts_with("hat "), "{job}: {failed}");
    }
    assert_eq!(stored_models(&app), 0);

    // Colours are only needed where one was chosen: the same part without any bakes fine.
    let mut uncolored = look("plain");
    uncolored["colors"] = json!({});
    assert_eq!(app.call("PUT", "/api/looks/me", Some(uncolored), Some(&member)).await.status, StatusCode::ACCEPTED);
    let ready = settled(&app, &member).await;
    assert_eq!(ready["status"], "ready", "{ready}");
    assert_eq!(ready["report"]["recoloredMaterials"], 0);
    assert_eq!(
        (ready["report"]["skippedHides"].as_u64(), ready["report"]["skippedTucks"].as_u64()),
        (Some(0), Some(0))
    );
    assert_eq!(stored_models(&app), 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 너무_큰_모습은_저장하지_않고_look_too_large로_알린다() {
    let (app, _studio, _admin, member) = resident_app().await;
    let queued = app.call("PUT", "/api/looks/me", Some(look("heavy")), Some(&member)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    let failed = settled(&app, &member).await;
    assert_eq!((failed["status"].as_str(), failed["error"]["code"].as_str()), (Some("failed"), Some("look_too_large")));
    assert_eq!((failed["modelUrl"].clone(), failed["worn"].clone()), (Value::Null, json!(false)));
    assert_eq!(stored_models(&app), 0);
    app.cleanup().await;
}

#[tokio::test]
async fn 서버가_다시_뜨면_멈춘_모습_입히기를_실패로_적고_바로_다시_저장할_수_있다() {
    let (app, _studio, _admin, member) = resident_app().await;
    let user = app.user_id("owner_r").await;
    // What the last process left behind: still baking, and too recent for the staleness rule to free it.
    sqlx::query("INSERT INTO user_looks (user_id, request, status) VALUES ($1, $2, 'baking')")
        .bind(user)
        .bind(look("hats"))
        .execute(&app.state.db)
        .await
        .unwrap();
    let stuck = app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)).await;
    assert_eq!((stuck.status, stuck.body["code"].as_str()), (StatusCode::CONFLICT, Some("look_baking")));

    assert_eq!(looks::interrupt_unfinished(&app.state.db).await.unwrap(), 1);
    let after = app.call("GET", "/api/looks/me", None, Some(&member)).await.body["look"].clone();
    assert_eq!((after["status"].as_str(), after["error"]["code"].as_str()), (Some("failed"), Some("interrupted")));
    assert!(after["error"]["message"].as_str().is_some_and(|message| !message.is_empty()));
    assert_eq!(looks::interrupt_unfinished(&app.state.db).await.unwrap(), 0, "a failed look is not touched again");

    assert_eq!(app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)).await.status, StatusCode::ACCEPTED);
    assert_eq!(settled(&app, &member).await["status"], "ready");
    assert_eq!(looks::interrupt_unfinished(&app.state.db).await.unwrap(), 0, "a finished look is not touched either");
    app.cleanup().await;
}

#[tokio::test]
async fn 새로_저장하면_앞선_입히기는_일을_하지_않고_물러난다() {
    let (app, studio, _admin, member) = resident_app().await;
    let slots = busy_slots(&app).await;
    let first = app.call("PUT", "/api/looks/me", Some(recolored("hats", "#00ff00")), Some(&member)).await;
    assert_eq!(first.status, StatusCode::ACCEPTED, "{:?}", first.body);
    // It has run for longer than a bake may, so a second save is let in while the first still waits for a slot.
    sqlx::query("UPDATE user_looks SET updated_at = now() - interval '11 minutes'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let second = app.call("PUT", "/api/looks/me", Some(recolored("hats", "#0000ff")), Some(&member)).await;
    assert_eq!(second.status, StatusCode::ACCEPTED, "{:?}", second.body);
    // Neither queued bake may download a body or mask before obtaining a memory-heavy slot.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!studio.seen.lock().unwrap().iter().any(|path| path.ends_with(".glb") || path.ends_with("/mask")));
    drop(slots);

    let ready = settled(&app, &member).await;
    assert_eq!(ready["status"], "ready", "{ready}");
    assert_eq!(ready["request"]["colors"], json!({"hat": {"0": "#0000ff"}}));
    // The older bake stepped aside: nothing of it was assembled or stored.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stored_models(&app), 1);
    assert_eq!(app.call("GET", "/api/looks/me", None, Some(&member)).await.body["look"]["status"], "ready");
    app.cleanup().await;
}

#[tokio::test]
async fn 모습을_입히는_사람이_너무_많으면_저장을_거절하고_열여섯까지는_받는다() {
    let (app, _studio, _admin, member) = resident_app().await;
    for at in 0..16 {
        let id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $2, 'x')")
            .bind(id)
            .bind(format!("baker{at}"))
            .execute(&app.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_looks (user_id, request, status) VALUES ($1, '{}', 'baking')")
            .bind(id)
            .execute(&app.state.db)
            .await
            .unwrap();
    }
    let turned_away = app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)).await;
    assert_eq!(
        (turned_away.status, turned_away.body["code"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("looks_busy"))
    );
    assert_eq!(app.call("GET", "/api/looks/me", None, Some(&member)).await.body, json!({"look": null}));

    // Fifteen remain active; concurrent reservations must accept exactly one sixteenth bake.
    sqlx::query(
        "UPDATE user_looks SET updated_at = now() - interval '11 minutes'
         WHERE user_id = (SELECT id FROM users WHERE username = 'baker0')",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let another = app.register("another_baker", "입히기").await;
    let slots = busy_slots(&app).await;
    let (a, b) = tokio::join!(
        app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)),
        app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&another))
    );
    let mut statuses = [a.status.as_u16(), b.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [202, 429], "{:?} {:?}", a.body, b.body);
    drop(slots);
    assert_eq!(
        settled(&app, if a.status == StatusCode::ACCEPTED { &member } else { &another }).await["status"],
        "ready"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 입히는_동안_미니미를_고르면_끝난_모습을_입히지_않는다() {
    let (app, _studio, _admin, member) = resident_app().await;
    let worn = |reply: &Value| reply["worn"].as_bool().unwrap();
    // A 미니미 picked while the look bakes: the finished look stays off.
    let slots = busy_slots(&app).await;
    assert_eq!(app.call("PUT", "/api/looks/me", Some(look("hats")), Some(&member)).await.status, StatusCode::ACCEPTED);
    app.call("PATCH", "/api/homes/me", Some(json!({"minime": "man"})), Some(&member)).await;
    drop(slots);
    let first = settled(&app, &member).await;
    assert_eq!(first["status"], "ready", "{first}");
    assert!(!worn(&first));
    assert!(first["modelUrl"].is_string());

    // Wearing it by hand puts it on; taking it off while a new one bakes keeps the new one off too.
    assert!(worn(&app.call("PATCH", "/api/looks/me", Some(json!({"worn": true})), Some(&member)).await.body["look"]));
    let slots = busy_slots(&app).await;
    assert_eq!(
        app.call("PUT", "/api/looks/me", Some(recolored("hats", "#0000ff")), Some(&member)).await.status,
        StatusCode::ACCEPTED
    );
    assert!(!worn(&app.call("PATCH", "/api/looks/me", Some(json!({"worn": false})), Some(&member)).await.body["look"]));
    drop(slots);
    let second = settled(&app, &member).await;
    assert_eq!((second["status"].as_str(), worn(&second)), (Some("ready"), false), "{second}");

    // Saving again means to wear it, whatever was chosen before.
    assert_eq!(
        app.call("PUT", "/api/looks/me", Some(recolored("hats", "#ff0000")), Some(&member)).await.status,
        StatusCode::ACCEPTED
    );
    let third = settled(&app, &member).await;
    assert_eq!((third["status"].as_str(), worn(&third)), (Some("ready"), true), "{third}");
    app.cleanup().await;
}
