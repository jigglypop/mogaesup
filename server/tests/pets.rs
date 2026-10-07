//! Pets: the breeds the app ships, adopting one, saving its brain, who sees it on the island, the editors' breeds and
//! the studio dogs they import as breeds, and the island's game socket relaying where it is.

mod common;
#[path = "fixtures/character.rs"]
mod test_glb;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::Duration,
};

use axum::{Json, Router, extract::Request, http::StatusCode, response::IntoResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::{ORIGIN, TestApp, factory_token};
use futures_util::{SinkExt, StreamExt};
use mogaesup_server::{
    MIGRATOR,
    config::{Factory, FactoryAccess},
    glb,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};
use uuid::Uuid;

/// FNV-1a 32 of `malecns-v1.0-dna02-neighborhood-128`, as frontend/src/pets/brain/graph.ts hashes it.
const GRAPH_HASH: u32 = 0x7472_dea7;
const WEIGHTS: usize = 10 * 129;

/// A `pet-brain-v1` brain as frontend/src/pets/brain/codec.ts writes it: every weight `weight`, `updates` learning
/// updates.
fn brain_bytes(weight: f32, updates: u32) -> Vec<u8> {
    let mut bytes = b"MGPB".to_vec();
    for value in [1u16, 20, 10, 129] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for value in [GRAPH_HASH, 0xdead_beef, updates] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for _ in 0..WEIGHTS {
        bytes.extend_from_slice(&weight.to_le_bytes());
    }
    bytes
}

fn brain(weight: f32, updates: u32) -> String {
    STANDARD.encode(brain_bytes(weight, updates))
}

fn drives() -> Value {
    json!({"energy": 0.9, "satiety": 0.5, "mood": 0.6, "bond": 0.12})
}

fn stats() -> Value {
    json!({"bondDay": 20_368, "bondGainedMilli": 20, "treats": 3,
        "commands": {"sit": {"given": 4, "treats": 3, "mastery": 50}}})
}

/// Signs up `username` and adopts a 시바견 named `name` at (1, -2); the cookie, the account's id and the pet.
async fn adopted(app: &TestApp, username: &str, name: &str) -> (String, Uuid, Value) {
    let cookie = app.register(username, username).await;
    let owner = app.user_id(username).await;
    let reply = app
        .call(
            "POST",
            "/api/pets/me",
            Some(
                json!({"expectedOwnerId": owner, "breedId": "shiba-inu", "name": name, "home": {"x": 1.0, "z": -2.0}}),
            ),
            Some(&cookie),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    (cookie, owner, reply.body["pet"].clone())
}

#[tokio::test]
async fn 앱에_든_강아지_19종이_공개_품종으로_들어가_있다() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let shipped: Value =
        serde_json::from_str(&fs::read_to_string(repo.join("frontend/src/pets/breeds.json")).unwrap()).unwrap();
    let shipped = shipped.as_array().unwrap();
    assert_eq!(shipped.len(), 19);

    let app = TestApp::new(None).await;
    let listed = app.call("GET", "/api/pets/breeds", None, None).await;
    assert_eq!(listed.status, StatusCode::OK);
    let breeds = listed.body["breeds"].as_array().unwrap();
    assert_eq!(breeds.len(), shipped.len(), "every shipped dog is a breed: a new one needs a migration row");
    let mut by_order: Vec<&Value> = shipped.iter().collect();
    by_order.sort_by_key(|dog| dog["order"].as_i64().unwrap());
    for (breed, dog) in breeds.iter().zip(by_order) {
        let slug = dog["slug"].as_str().unwrap();
        assert_eq!(breed["id"], dog["slug"], "the studio's order");
        assert_eq!(breed["label"], dog["name"], "{slug}");
        assert_eq!(breed["modelUrl"], dog["model"], "{slug}");
        assert_eq!(breed["thumbnailUrl"], dog["thumbnail"], "{slug}");
        assert_eq!(breed["heightM"], dog["height_m"], "{slug}");
        let clips: HashSet<&str> =
            breed["clips"].as_array().unwrap().iter().map(|clip| clip.as_str().unwrap()).collect();
        let shipped_clips: HashSet<&str> = dog["clips"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(clips, shipped_clips, "{slug}");
        assert!(clips.contains("sit_hold") && clips.contains("lie_hold"), "{slug}");
        // The app ships the model and its picture.
        let public = repo.join("frontend/public");
        let glb = fs::read(public.join(dog["model"].as_str().unwrap().trim_start_matches('/'))).unwrap();
        assert_eq!(&glb[..4], b"glTF", "{slug}");
        let webp = fs::read(public.join(dog["thumbnail"].as_str().unwrap().trim_start_matches('/'))).unwrap();
        assert_eq!((&webp[..4], &webp[8..12]), (&b"RIFF"[..], &b"WEBP"[..]), "{slug}");
    }

    // Editors rename and retire them like any breed, and running the rows again keeps what they changed.
    let editor = app.register("pet_editor_seed", "편집").await;
    app.make_admin("pet_editor_seed").await;
    let renamed = app
        .call(
            "PATCH",
            "/api/pets/admin/breeds/pug",
            Some(json!({"label": "퍼그 강아지", "status": "retired"})),
            Some(&editor),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{:?}", renamed.body);
    let seeded = MIGRATOR.iter().find(|migration| migration.description == "pets").unwrap();
    sqlx::raw_sql(&seeded.sql).execute(&app.state.db).await.unwrap();
    let listed = app.call("GET", "/api/pets/breeds", None, None).await;
    let ids: Vec<&str> = listed.body["breeds"].as_array().unwrap().iter().map(|b| b["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 18);
    assert!(!ids.contains(&"pug"));
    let all = app.call("GET", "/api/pets/admin/breeds", None, Some(&editor)).await;
    let pug = all.body["breeds"].as_array().unwrap().iter().find(|breed| breed["id"] == "pug").unwrap().clone();
    assert_eq!((pug["label"].as_str(), pug["status"].as_str()), (Some("퍼그 강아지"), Some("retired")));
    assert_eq!((pug["source"].as_str(), pug["species"].as_str()), (Some("builtin"), Some("dog")));
    app.cleanup().await;
}

#[tokio::test]
async fn 회원은_한_마리를_입양해_이름과_집을_바꾸고_떠나보낸다() {
    let app = TestApp::new(None).await;
    let (cookie, owner, pet) = adopted(&app, "pet_owner", " 초코 ").await;
    let id = pet["id"].as_str().unwrap().to_owned();
    assert_eq!(pet["name"], "초코");
    assert_eq!((pet["breed"].as_str(), pet["breedInfo"]["id"].as_str()), (Some("shiba-inu"), Some("shiba-inu")));
    assert_eq!(pet["breedInfo"]["modelUrl"], "/gltf/pets/shiba-inu.glb");
    assert_eq!(pet["home"], json!({"x": 1.0, "z": -2.0}));
    assert_eq!(
        (pet["graphId"].as_str(), pet["model"].as_str()),
        (Some("malecns-v1.0-dna02-neighborhood-128"), Some("pet-brain-v1"))
    );
    assert!(pet["seed"].as_i64().is_some_and(|seed| (0..=i64::from(u32::MAX)).contains(&seed)));
    assert_eq!(
        (pet["brain"].clone(), pet["drives"].clone(), pet["stats"].clone()),
        (Value::Null, json!({}), json!({}))
    );
    assert_eq!(pet["revision"], 1);
    assert_eq!(app.call("GET", "/api/pets/me", None, Some(&cookie)).await.body["pet"], pet);

    // One pet each; the account the page was loaded for must be the one signed in.
    let adopt = |body: Value| app.call("POST", "/api/pets/me", Some(body), Some(&cookie));
    let again =
        adopt(json!({"expectedOwnerId": owner, "breedId": "poodle", "name": "둘째", "home": {"x": 0, "z": 0}})).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::CONFLICT, Some("pet_exists")));
    let stale = adopt(
        json!({"expectedOwnerId": Uuid::new_v4(), "breedId": "poodle", "name": "둘째", "home": {"x": 0, "z": 0}}),
    )
    .await;
    assert_eq!((stale.status, stale.body["code"].as_str()), (StatusCode::CONFLICT, Some("owner_changed")));
    let unnamed = adopt(json!({"breedId": "poodle", "name": "둘째", "home": {"x": 0, "z": 0}})).await;
    assert_eq!(unnamed.body["code"], "owner_changed");

    // Someone else picks a breed that is there and published, a name that shows, and a home on the island.
    let other = app.register("pet_other", "다른 사람").await;
    let other_id = app.user_id("pet_other").await;
    let try_adopt = |breed: &str, name: &str, x: f64| {
        let body = json!({"expectedOwnerId": other_id, "breedId": breed, "name": name, "home": {"x": x, "z": 0}});
        app.call("POST", "/api/pets/me", Some(body), Some(&other))
    };
    for (breed, name, x, code) in [
        ("wolf", "늑대", 0.0, "breed_unavailable"),
        ("../shiba-inu", "초코", 0.0, "breed_unavailable"),
        ("poodle", "", 0.0, "invalid_pet_name"),
        ("poodle", "가나다라마바사아자차카타파", 0.0, "invalid_pet_name"),
        ("poodle", "초\u{202e}코", 0.0, "invalid_pet_name"),
        ("poodle", "초코", 200.5, "invalid_home"),
    ] {
        let refused = try_adopt(breed, name, x).await;
        assert_eq!(
            (refused.status, refused.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some(code)),
            "{breed} {name}"
        );
    }
    assert_eq!(app.call("GET", "/api/pets/me", None, Some(&other)).await.body["pet"], Value::Null);
    assert_eq!(app.call("GET", "/api/pets/me", None, None).await.status, StatusCode::UNAUTHORIZED);

    // A new name and home leave the brain's revision alone; a page holding another pet changes nothing.
    let patch = |body: Value| app.call("PATCH", "/api/pets/me", Some(body), Some(&cookie));
    let moved =
        patch(json!({"expectedOwnerId": owner, "petId": id, "name": "보리", "home": {"x": -3.5, "z": 4.25}})).await;
    assert_eq!(moved.status, StatusCode::OK, "{:?}", moved.body);
    assert_eq!((moved.body["pet"]["name"].as_str(), moved.body["pet"]["revision"].as_i64()), (Some("보리"), Some(1)));
    assert_eq!(moved.body["pet"]["home"], json!({"x": -3.5, "z": 4.25}));
    assert_eq!(moved.body["pet"]["updatedAt"], pet["updatedAt"], "updatedAt is when the brain was saved");
    let elsewhere = patch(json!({"expectedOwnerId": owner, "petId": Uuid::new_v4(), "name": "다른"})).await;
    assert_eq!((elsewhere.status, elsewhere.body["code"].as_str()), (StatusCode::CONFLICT, Some("pet_changed")));
    let bad = patch(json!({"expectedOwnerId": owner, "name": "\u{3164}"})).await;
    assert_eq!(bad.body["code"], "invalid_pet_name");
    let nothing =
        app.call("PATCH", "/api/pets/me", Some(json!({"expectedOwnerId": other_id, "name": "새"})), Some(&other)).await;
    assert_eq!((nothing.status, nothing.body["code"].as_str()), (StatusCode::NOT_FOUND, Some("pet_not_found")));

    // Letting it go takes its records with it, and makes room for another.
    let release = |body: Value| app.call("DELETE", "/api/pets/me", Some(body), Some(&cookie));
    assert_eq!(release(json!({"expectedOwnerId": owner, "petId": Uuid::new_v4()})).await.body["code"], "pet_changed");
    assert_eq!(release(json!({"petId": id})).await.body["code"], "owner_changed");
    assert_eq!(release(json!({"expectedOwnerId": owner, "petId": id})).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.call("GET", "/api/pets/me", None, Some(&cookie)).await.body["pet"], Value::Null);
    let gone = release(json!({"expectedOwnerId": owner})).await;
    assert_eq!((gone.status, gone.body["code"].as_str()), (StatusCode::NOT_FOUND, Some("pet_not_found")));
    let next =
        adopt(json!({"expectedOwnerId": owner, "breedId": "poodle", "name": "둘째", "home": {"x": 0, "z": 0}})).await;
    assert_eq!(next.status, StatusCode::CREATED);
    assert_ne!(next.body["pet"]["id"].as_str(), Some(id.as_str()));
    app.cleanup().await;
}

#[tokio::test]
async fn 뇌는_정해진_형식만_리비전을_지켜_저장된다() {
    let app = TestApp::new(None).await;
    let (cookie, owner, pet) = adopted(&app, "brain_owner", "초코").await;
    let id = pet["id"].as_str().unwrap().to_owned();
    let save = |body: Value| app.call("PUT", "/api/pets/me/brain", Some(body), Some(&cookie));
    let body = |revision: i64, brain: Value| {
        json!({"expectedOwnerId": owner, "petId": id, "revision": revision, "brain": brain, "drives": drives(),
            "stats": stats()})
    };

    let saved = save(body(1, json!(brain(0.5, 7)))).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["revision"], 2);
    let mine = app.call("GET", "/api/pets/me", None, Some(&cookie)).await.body["pet"].clone();
    assert_eq!(mine["brain"].as_str(), Some(brain(0.5, 7).as_str()));
    assert_eq!(
        (mine["drives"].clone(), mine["stats"].clone(), mine["revision"].clone()),
        (drives(), stats(), json!(2))
    );
    assert_eq!(mine["updatedAt"], saved.body["updatedAt"]);

    // A page that saved from the revision before, or holds another pet, is told to load again.
    let late = save(body(1, json!(brain(0.25, 8)))).await;
    assert_eq!((late.status, late.body["code"].as_str()), (StatusCode::CONFLICT, Some("pet_changed")));
    let mut other_pet = body(2, json!(brain(0.25, 8)));
    other_pet["petId"] = json!(Uuid::new_v4());
    assert_eq!(save(other_pet).await.body["code"], "pet_changed");
    let mut other_account = body(2, json!(brain(0.25, 8)));
    other_account["expectedOwnerId"] = json!(Uuid::new_v4());
    assert_eq!(save(other_account).await.body["code"], "owner_changed");

    // Only the pets' brain of the pets' circuit, with every weight finite and within ±12.
    let mut wrong: Vec<(&str, String)> = vec![
        ("short", STANDARD.encode(&brain_bytes(0.0, 0)[..5180])),
        ("long", STANDARD.encode([brain_bytes(0.0, 0), vec![0; 3]].concat())),
        ("not base64", "*".repeat(6912)),
        ("past the bound", brain(12.5, 0)),
        ("not a number", brain(f32::NAN, 0)),
    ];
    for (name, at, value) in [
        ("magic", 0, b"MGPX".to_vec()),
        ("version", 4, 2u16.to_le_bytes().to_vec()),
        ("senses", 6, 19u16.to_le_bytes().to_vec()),
        ("actions", 8, 9u16.to_le_bytes().to_vec()),
        ("features", 10, 130u16.to_le_bytes().to_vec()),
        ("circuit", 12, 0x1234_5678u32.to_le_bytes().to_vec()),
        ("infinity", 24 + 4 * 77, f32::INFINITY.to_le_bytes().to_vec()),
    ] {
        let mut bytes = brain_bytes(-1.0, 3);
        bytes[at..at + value.len()].copy_from_slice(&value);
        wrong.push((name, STANDARD.encode(bytes)));
    }
    for (name, text) in wrong {
        let refused = save(body(2, json!(text))).await;
        assert_eq!(
            (refused.status, refused.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_brain")),
            "{name}"
        );
    }
    let mut extra_drive = body(2, json!(brain(1.0, 9)));
    extra_drive["drives"]["hunger"] = json!(0.5);
    assert_eq!(save(extra_drive).await.body["code"], "invalid_drives");
    let mut high_drive = body(2, json!(brain(1.0, 9)));
    high_drive["drives"]["mood"] = json!(1.5);
    assert_eq!(save(high_drive).await.body["code"], "invalid_drives");
    let mut unknown_stat = body(2, json!(brain(1.0, 9)));
    unknown_stat["stats"]["commands"]["roll"] = json!({"given": 1});
    assert_eq!(save(unknown_stat).await.body["code"], "invalid_stats");
    let mut fraction = body(2, json!(brain(1.0, 9)));
    fraction["stats"]["treats"] = json!(2.5);
    assert_eq!(save(fraction).await.body["code"], "invalid_stats");
    // Nothing refused was kept.
    let mine = app.call("GET", "/api/pets/me", None, Some(&cookie)).await.body["pet"].clone();
    assert_eq!((mine["brain"].as_str(), mine["revision"].as_i64()), (Some(brain(0.5, 7).as_str()), Some(2)));

    // What a save leaves out stays, and the weights' bound itself is allowed.
    let partial = save(json!({"expectedOwnerId": owner, "revision": 2, "brain": brain(-12.0, 10)})).await;
    assert_eq!(partial.body["revision"], 3, "{:?}", partial.body);
    let mine = app.call("GET", "/api/pets/me", None, Some(&cookie)).await.body["pet"].clone();
    assert_eq!(
        (mine["brain"].as_str(), mine["drives"].clone(), mine["stats"].clone()),
        (Some(brain(-12.0, 10).as_str()), drives(), stats())
    );
    let drives = json!({"energy": 1, "satiety": 0, "mood": 1, "bond": 0});
    let drives_only = save(json!({"expectedOwnerId": owner, "petId": id, "revision": 3, "drives": drives})).await;
    assert_eq!(drives_only.body["revision"], 4);

    // Someone without a pet has nothing to save.
    let other = app.register("brain_other", "다른").await;
    let other_id = app.user_id("brain_other").await;
    let none = app
        .call(
            "PUT",
            "/api/pets/me/brain",
            Some(json!({"expectedOwnerId": other_id, "revision": 1, "brain": brain(0.0, 0)})),
            Some(&other),
        )
        .await;
    assert_eq!((none.status, none.body["code"].as_str()), (StatusCode::NOT_FOUND, Some("pet_not_found")));
    app.cleanup().await;
}

#[tokio::test]
async fn 뇌_저장은_10분에_30번까지다() {
    let app = TestApp::new(None).await;
    let (cookie, owner, _) = adopted(&app, "busy_owner", "초코").await;
    for revision in 1..=30 {
        let body = json!({"expectedOwnerId": owner, "revision": revision, "brain": brain(0.1, revision as u32),
            "drives": drives()});
        let saved = app.call("PUT", "/api/pets/me/brain", Some(body), Some(&cookie)).await;
        assert_eq!(saved.body["revision"], revision + 1, "{:?}", saved.body);
    }
    let body = json!({"expectedOwnerId": owner, "revision": 31, "brain": brain(0.1, 31), "drives": drives()});
    let busy = app.call("PUT", "/api/pets/me/brain", Some(body), Some(&cookie)).await;
    assert_eq!((busy.status, busy.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("pet_saves_busy")));
    app.cleanup().await;
}

#[tokio::test]
async fn 섬의_펫은_그_섬을_볼_수_있는_사람에게만_보인다() {
    let app = TestApp::new(None).await;
    let (owner_cookie, _, pet) = adopted(&app, "isle_owner", "초코").await;
    let friend = app.register("isle_friend", "일촌").await;
    let stranger = app.register("isle_stranger", "모르는 사람").await;
    let (owner, friend_id) = (app.user_id("isle_owner").await, app.user_id("isle_friend").await);
    sqlx::query("INSERT INTO ilchons (user_id, friend_id, name) VALUES ($1, $2, 'pal'), ($2, $1, 'pal')")
        .bind(owner)
        .bind(friend_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let path = "/api/homes/isle_owner/pet";

    // A public island's pet, for anyone: its name, breed and home, nothing of its brain.
    let seen = app.call("GET", path, None, None).await;
    assert_eq!(seen.status, StatusCode::OK);
    let shown = &seen.body["pet"];
    assert_eq!(shown["id"], pet["id"]);
    assert_eq!((shown["name"].as_str(), shown["breed"].as_str()), (Some("초코"), Some("shiba-inu")));
    assert_eq!(shown["breedInfo"], pet["breedInfo"]);
    assert_eq!(shown["home"], json!({"x": 1.0, "z": -2.0}));
    let fields: HashSet<&str> = shown.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, HashSet::from(["id", "name", "breed", "breedInfo", "home"]));

    // An island open to 일촌 shows it to them and its owner only; a private one to its owner only.
    let narrowed = app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "ilchon"})), Some(&owner_cookie)).await;
    assert_eq!(narrowed.status, StatusCode::OK);
    assert_eq!(app.call("GET", path, None, Some(&friend)).await.body["pet"]["name"], "초코");
    assert_eq!(app.call("GET", path, None, Some(&owner_cookie)).await.body["pet"]["name"], "초코");
    for viewer in [Some(stranger.as_str()), None] {
        let refused = app.call("GET", path, None, viewer).await;
        assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::FORBIDDEN, Some("home_private")));
    }
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&owner_cookie)).await;
    assert_eq!(app.call("GET", path, None, Some(&friend)).await.body["code"], "home_private");
    assert_eq!(app.call("GET", path, None, Some(&owner_cookie)).await.body["pet"]["name"], "초코");

    // An island without a pet, and one that is not there.
    assert_eq!(app.call("GET", "/api/homes/isle_friend/pet", None, None).await.body, json!({"pet": null}));
    assert_eq!(app.call("GET", "/api/homes/nobody_here/pet", None, None).await.status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn 카탈로그_편집자는_품종을_내리고_올리고_앱에_든_모델을_더한다() {
    let app = TestApp::new(None).await;
    let (_, _, pet) = adopted(&app, "breed_owner", "초코").await;
    let member = app.register("breed_member", "회원").await;
    let member_id = app.user_id("breed_member").await;
    for (method, path) in [("GET", "/api/pets/admin/breeds"), ("PATCH", "/api/pets/admin/breeds/poodle")] {
        let refused = app.call(method, path, Some(json!({"status": "retired"})), Some(&member)).await;
        assert_eq!(
            (refused.status, refused.body["code"].as_str()),
            (StatusCode::FORBIDDEN, Some("catalog_editor_only"))
        );
    }
    let editor = app.register("breed_editor", "편집").await;
    app.make_admin("breed_editor").await;

    // Every breed, with how many pets are of it.
    let all = app.call("GET", "/api/pets/admin/breeds", None, Some(&editor)).await;
    let breeds = all.body["breeds"].as_array().unwrap();
    assert_eq!(breeds.len(), 19);
    let shiba = breeds.iter().find(|breed| breed["id"] == "shiba-inu").unwrap();
    assert_eq!(
        (shiba["pets"].as_i64(), shiba["status"].as_str(), shiba["sortOrder"].as_i64()),
        (Some(1), Some("published"), Some(7))
    );
    assert_eq!(shiba["sourceRef"], "animal:fa357047d711d0f6328e2f32");

    // A breed taken off the list cannot be adopted; the pets of it keep it.
    let retired = app
        .call(
            "PATCH",
            "/api/pets/admin/breeds/shiba-inu",
            Some(json!({"status": "draft", "heightM": 0.6})),
            Some(&editor),
        )
        .await;
    assert_eq!((retired.body["status"].as_str(), retired.body["heightM"].as_f64()), (Some("draft"), Some(0.6)));
    let listed = app.call("GET", "/api/pets/breeds", None, None).await;
    assert!(listed.body["breeds"].as_array().unwrap().iter().all(|breed| breed["id"] != "shiba-inu"));
    let body = json!({"expectedOwnerId": member_id, "breedId": "shiba-inu", "name": "바둑", "home": {"x": 0, "z": 0}});
    assert_eq!(app.call("POST", "/api/pets/me", Some(body), Some(&member)).await.body["code"], "breed_unavailable");
    let kept = app.call("GET", "/api/homes/breed_owner/pet", None, None).await;
    assert_eq!(
        (kept.body["pet"]["id"].clone(), kept.body["pet"]["breedInfo"]["heightM"].as_f64()),
        (pet["id"].clone(), Some(0.6))
    );
    for (changes, code) in [
        (json!({"status": "gone"}), "invalid_status"),
        (json!({"heightM": 5}), "invalid_height"),
        (json!({"label": ""}), "invalid_label"),
    ] {
        let refused = app.call("PATCH", "/api/pets/admin/breeds/poodle", Some(changes), Some(&editor)).await;
        assert_eq!(refused.body["code"], code);
    }
    let missing =
        app.call("PATCH", "/api/pets/admin/breeds/wolf", Some(json!({"status": "published"})), Some(&editor)).await;
    assert_eq!((missing.status, missing.body["code"].as_str()), (StatusCode::NOT_FOUND, Some("breed_not_found")));

    // A breed whose model the app ships, a draft until it is published.
    let add = |body: Value| app.call("POST", "/api/pets/admin/breeds", Some(body), Some(&editor));
    let new = json!({"id": "jindo", "label": "진돗개", "modelUrl": "/gltf/pets/jindo.glb",
        "thumbnailUrl": "/gltf/pets/jindo.webp", "clips": ["idle", "walk", "sit_hold"], "heightM": 0.5,
        "sortOrder": 30});
    let added = add(new.clone()).await;
    assert_eq!(added.status, StatusCode::CREATED, "{:?}", added.body);
    assert_eq!(
        (added.body["status"].as_str(), added.body["source"].as_str(), added.body["emoji"].as_str()),
        (Some("draft"), Some("builtin"), Some("🐶"))
    );
    assert_eq!(added.body["clips"], json!(["idle", "walk", "sit_hold"]));
    assert_eq!(add(new.clone()).await.body["code"], "breed_exists");
    for (field, value, code) in [
        ("modelUrl", json!("/models/0000.glb"), "invalid_model_url"),
        ("modelUrl", json!("https://example.com/gltf/pets/jindo.glb"), "invalid_model_url"),
        ("modelUrl", json!("/gltf/pets/../decor/door-basic.glb"), "invalid_model_url"),
        ("thumbnailUrl", json!("/gltf/pets/jindo.glb"), "invalid_thumbnail_url"),
        ("clips", json!(["Idle"]), "invalid_clips"),
        ("id", json!("Jindo"), "invalid_id"),
    ] {
        let mut wrong = new.clone();
        wrong["id"] = json!("jindo-two");
        wrong[field] = value;
        assert_eq!(add(wrong).await.body["code"], code, "{field}");
    }
    let published =
        app.call("PATCH", "/api/pets/admin/breeds/jindo", Some(json!({"status": "published"})), Some(&editor)).await;
    assert_eq!(published.body["status"], "published");
    let listed = app.call("GET", "/api/pets/breeds", None, None).await;
    assert_eq!(listed.body["breeds"].as_array().unwrap().last().unwrap()["id"], "jindo");
    app.cleanup().await;
}

// ---- Studio dogs imported as breeds

const DOG: &str = "0123456789abcdef01234567";
const PUPPY: &str = "fedcba9876543210fedcba98";

/// A character server stand-in that lists its studio animals (`studio/animals`) and serves their files: `DOG`, done
/// through its standard motions, and `PUPPY`, still being rigged.
async fn fake_studio(model: Vec<u8>) -> String {
    let mut picture = std::io::Cursor::new(Vec::new());
    image::RgbaImage::new(64, 64).write_to(&mut picture, image::ImageFormat::Png).unwrap();
    let sha = hex::encode(Sha256::digest(&model));
    let files: HashMap<String, Vec<u8>> = HashMap::from([
        (format!("{DOG}/motions-standard.glb"), model),
        (format!("{DOG}/front.png"), picture.into_inner()),
    ]);
    let animal = |id: &str, standard: &str| {
        let url = |name: &str| format!("/api/studio/animals/{id}/{name}");
        json!({"id": id, "name": "진돗개", "species": "dog", "stages": {"standard": {"status": standard}},
            "artifacts": [{"name": "motions-standard.glb", "sha256": sha, "url": url("motions-standard.glb")},
                {"name": "front.png", "sha256": "0".repeat(64), "url": url("front.png")}]})
    };
    let listing = json!({"items": [animal(DOG, "complete"), animal(PUPPY, "running")]});
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(move |request: Request| {
        let (listing, files) = (listing.clone(), files.clone());
        async move {
            let path = request.uri().path();
            if path == "/api/studio/animals" {
                return Json(listing).into_response();
            }
            let file = path.strip_prefix("/api/studio/animals/").and_then(|file| files.get(file));
            file.map_or_else(|| StatusCode::NOT_FOUND.into_response(), |bytes| bytes.clone().into_response())
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// Queues an import and waits for its end; the import as it ended.
async fn imported(app: &TestApp, editor: &str, body: Value) -> Value {
    let queued = app.call("POST", "/api/catalog/admin/import", Some(body), Some(editor)).await;
    assert_eq!(queued.status, StatusCode::ACCEPTED, "{:?}", queued.body);
    let path = format!("/api/catalog/admin/imports/{}", queued.body["id"].as_str().unwrap());
    for _ in 0..1200 {
        let reply = app.call("GET", &path, None, Some(editor)).await;
        if matches!(reply.body["status"].as_str(), Some("done" | "failed")) {
            return reply.body;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the import did not finish");
}

#[tokio::test]
async fn 카탈로그_편집자는_표준_동작까지_끝난_스튜디오_강아지를_품종으로_가져온다() {
    let model = test_glb::character(&["idle", "walk", "run", "sit_hold", "lie_hold", "bark", "jump"]);
    let sha = hex::encode(Sha256::digest(&model));
    let factory = Factory {
        url: fake_studio(model).await,
        api_key: None,
        token: factory_token(),
        access: FactoryAccess::Read,
        paid_monthly: 0,
        gateway_key: None,
        instance: None,
    };
    let app = TestApp::new(Some(factory)).await;
    let editor = app.register("dog_editor", "편집").await;
    app.make_admin("dog_editor").await;
    let body = |id: &str, animal: &str| json!({"id": id, "kind": "pet", "label": "진돗개", "emoji": "🐕", "factoryJobId": animal, "sortOrder": 40});

    // A new breed is a draft with the stored model and picture, the clips the model has, and where it came from.
    let done = imported(&app, &editor, body("jindo", DOG)).await;
    assert_eq!(
        (done["status"].as_str(), done["report"]["outcome"].as_str()),
        (Some("done"), Some("created")),
        "{done:?}"
    );
    let breeds = app.call("GET", "/api/pets/admin/breeds", None, Some(&editor)).await.body["breeds"].clone();
    let jindo = breeds.as_array().unwrap().iter().find(|breed| breed["id"] == "jindo").unwrap().clone();
    assert_eq!((jindo["status"].as_str(), jindo["source"].as_str()), (Some("draft"), Some("factory")));
    assert_eq!(jindo["sourceRef"], format!("animal:{DOG}:{}", &sha[..12]));
    assert_eq!(jindo["clips"], json!(["idle", "walk", "run", "sit_hold", "lie_hold", "bark", "jump"]));
    assert_eq!((jindo["emoji"].as_str(), jindo["sortOrder"].as_i64()), (Some("🐕"), Some(40)));
    let model_url = jindo["modelUrl"].as_str().unwrap();
    let picture_url = jindo["thumbnailUrl"].as_str().unwrap();
    assert!(model_url.starts_with("/models/") && model_url.ends_with(".glb"), "{model_url}");
    assert!(picture_url.starts_with("/models/") && picture_url.ends_with(".png"), "{picture_url}");
    assert_eq!(app.call("GET", model_url, None, None).await.status, StatusCode::OK);
    assert!(
        app.call("GET", "/api/pets/breeds", None, None).await.body["breeds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["id"] != "jindo")
    );

    // Imported again, it keeps what the editors changed.
    let changes = json!({"status": "published", "label": "백구"});
    app.call("PATCH", "/api/pets/admin/breeds/jindo", Some(changes), Some(&editor)).await;
    let again = imported(&app, &editor, body("jindo", DOG)).await;
    assert_eq!(again["report"]["outcome"], "unchanged", "{again:?}");
    let listed = app.call("GET", "/api/pets/breeds", None, None).await.body["breeds"].clone();
    let jindo = listed.as_array().unwrap().iter().find(|breed| breed["id"] == "jindo").unwrap().clone();
    assert_eq!((jindo["label"].as_str(), jindo["modelUrl"].as_str()), (Some("백구"), Some(model_url)));

    // A dog still being rigged fails; a built-in breed and an id that is not an animal's are refused at once.
    let unready = imported(&app, &editor, body("puppy", PUPPY)).await;
    assert_eq!((unready["status"].as_str(), unready["errorCode"].as_str()), (Some("failed"), Some("animal_not_ready")));
    let builtin = app.call("POST", "/api/catalog/admin/import", Some(body("shiba-inu", DOG)), Some(&editor)).await;
    assert_eq!((builtin.status, builtin.body["code"].as_str()), (StatusCode::CONFLICT, Some("builtin_item")));
    let not_animal = app.call("POST", "/api/catalog/admin/import", Some(body("other", "../jobs")), Some(&editor)).await;
    assert_eq!(
        (not_animal.status, not_animal.body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("animal_not_found"))
    );
    app.cleanup().await;
}

// ---- The game socket's relay

type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve(app: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = app.router.clone();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("ws://{address}")
}

async fn ticket(app: &TestApp, cookie: &str) -> String {
    app.call("POST", "/api/auth/realtime-ticket", None, Some(cookie)).await.body["ticket"].as_str().unwrap().to_owned()
}

async fn open(url: String) -> Stream {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn send(stream: &mut Stream, message: Value) {
    stream.send(Message::text(message.to_string())).await.unwrap();
}

/// The JSON messages that come before the next `Pong` (the reply to a ping sent now), in order.
async fn until_pong(stream: &mut Stream) -> Vec<Value> {
    send(stream, json!({"type": "Ping", "ts": 1})).await;
    let mut seen = Vec::new();
    loop {
        let message = tokio::time::timeout(Duration::from_secs(3), stream.next()).await.expect("a pong");
        if let Some(Ok(Message::Text(text))) = message {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["type"] == "Pong" {
                return seen;
            }
            seen.push(value);
        }
    }
}

/// The next pet frame, within three seconds.
async fn next_pet(stream: &mut Stream) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(3), stream.next()).await.expect("a pet frame");
        if let Some(Ok(Message::Text(text))) = message {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["type"] == "Pet" {
                return value["pet"].clone();
            }
        }
    }
}

/// The pet frames among `messages`.
fn pets(messages: &[Value]) -> Vec<Value> {
    messages.iter().filter(|message| message["type"] == "Pet").map(|message| message["pet"].clone()).collect()
}

fn errors(messages: &[Value]) -> Vec<&str> {
    messages
        .iter()
        .filter(|message| message["type"] == "Error")
        .map(|message| message["code"].as_str().unwrap())
        .collect()
}

/// A member in `island`'s live room and on its game socket.
async fn arrive(app: &TestApp, base: &str, island: &str, cookie: &str) -> (Stream, Stream) {
    let mut room = open(format!("{base}/api/rooms/{island}?ticket={}", ticket(app, cookie).await)).await;
    send(&mut room, json!({"type": "Join", "room_id": island, "color": "#ff7a59"})).await;
    let peer = loop {
        let message = tokio::time::timeout(Duration::from_secs(3), room.next()).await.expect("a welcome");
        match message {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == "Welcome" {
                    break value["client_id"].as_str().unwrap().to_owned();
                }
            }
            Some(Ok(Message::Close(frame))) => panic!("room closed: {frame:?}"),
            Some(Ok(_)) => {}
            other => panic!("no welcome: {other:?}"),
        }
    };
    let game = open(format!("{base}/api/games/{island}?ticket={}&peer={peer}", ticket(app, cookie).await)).await;
    (room, game)
}

fn frame(id: &str, x: f64) -> Value {
    json!({"id": id, "t": 1000.5, "at": [x, 0.1, -4.0], "ry": 1.57, "move": true, "speed": 3.0, "clip": "walk",
        "gesture": {"clip": "bark", "at": 990.0}, "ball": null, "extra": "dropped"})
}

fn relayed(id: &str, x: f64) -> Value {
    let mut relayed = frame(id, x);
    relayed.as_object_mut().unwrap().remove("extra");
    relayed
}

#[tokio::test]
async fn 주인의_펫_위치는_섬의_다른_게임_소켓에_중계된다() {
    let app = TestApp::new(None).await;
    let (owner, _, pet) = adopted(&app, "relay_owner", "초코").await;
    let id = pet["id"].as_str().unwrap().to_owned();
    let guest = app.register("relay_guest", "손님").await;
    let late = app.register("relay_late", "늦은 손님").await;
    let base = serve(&app).await;
    let (_room_o, mut game_o) = arrive(&app, &base, "relay_owner", &owner).await;
    let (_room_g, mut game_g) = arrive(&app, &base, "relay_owner", &guest).await;
    until_pong(&mut game_o).await;
    until_pong(&mut game_g).await;

    // The owner's frame reaches everyone else, its checked fields only; not its sender.
    send(&mut game_o, json!({"type": "Pet", "pet": frame(&id, 3.0)})).await;
    assert!(pets(&until_pong(&mut game_o).await).is_empty());
    assert_eq!(pets(&until_pong(&mut game_g).await), [relayed(&id, 3.0)]);

    // A visitor's is refused, and so is a frame that is not one.
    send(&mut game_g, json!({"type": "Pet", "pet": frame(&id, 9.0)})).await;
    assert_eq!(errors(&until_pong(&mut game_g).await), ["not_owner"]);
    let mut dancing = frame(&id, 9.0);
    dancing["clip"] = json!("dance");
    send(&mut game_o, json!({"type": "Pet", "pet": dancing})).await;
    assert_eq!(errors(&until_pong(&mut game_o).await), ["bad_pet"]);
    assert!(pets(&until_pong(&mut game_g).await).is_empty());

    // Whoever comes later is sent the last frame; another of the owner's pages may not relay it meanwhile.
    let (_room_l, mut game_l) = arrive(&app, &base, "relay_owner", &late).await;
    assert_eq!(pets(&until_pong(&mut game_l).await), [relayed(&id, 3.0)]);
    let (_room_o2, mut game_o2) = arrive(&app, &base, "relay_owner", &owner).await;
    assert_eq!(pets(&until_pong(&mut game_o2).await), [relayed(&id, 3.0)]);
    send(&mut game_o2, json!({"type": "Pet", "pet": frame(&id, 5.0)})).await;
    assert_eq!(errors(&until_pong(&mut game_o2).await), ["pet_busy"]);

    // `null` lets go of it: everyone is told it rests, and the other page may relay it.
    send(&mut game_o, json!({"type": "Pet", "pet": null})).await;
    assert!(pets(&until_pong(&mut game_o).await).is_empty());
    for socket in [&mut game_g, &mut game_l, &mut game_o2] {
        assert_eq!(pets(&until_pong(socket).await), [Value::Null]);
    }
    send(&mut game_o2, json!({"type": "Pet", "pet": frame(&id, 6.0)})).await;
    assert!(errors(&until_pong(&mut game_o2).await).is_empty());
    for socket in [&mut game_g, &mut game_l, &mut game_o] {
        assert_eq!(pets(&until_pong(socket).await), [relayed(&id, 6.0)]);
    }

    // Its socket closing does too.
    game_o2.close(None).await.unwrap();
    assert_eq!(next_pet(&mut game_g).await, Value::Null);
    assert_eq!(next_pet(&mut game_o).await, Value::Null);
    let (_room_g2, mut game_g2) = arrive(&app, &base, "relay_owner", &guest).await;
    assert!(pets(&until_pong(&mut game_g2).await).is_empty(), "nothing to show once it rests");
    app.cleanup().await;
}
