//! Island saves and loads under load: one save at a time per member, a few site-wide, loads sent from a compressed
//! copy per revision, and a listing whose pages stay put while islands autosave.

mod common;

use axum::{
    body::{Body, Bytes},
    http::{Request, StatusCode, header},
};
use common::{ORIGIN, TestApp};
use futures_util::{StreamExt, future::join_all};
use http_body_util::BodyExt;
use mogaesup_server::{
    homes::{self, Homes},
    security::rate_record,
};
use serde_json::{Value, json};
use std::{
    io::Read,
    time::{Duration, Instant},
};
use tower::ServiceExt;
use uuid::Uuid;

/// A save of about 1.9 MiB of numbers, as its request's text: read as values, each such save once took tens of
/// megabytes.
fn big_save(owner: Uuid, world: &str) -> String {
    format!(
        r#"{{"expectedOwnerId":"{owner}","worldId":"{world}","baseRevision":0,"data":{{"version":1,"savedAt":1,"domains":{{"building":{{"pad":[{}0]}}}}}}}}"#,
        "0,".repeat(950 * 1024)
    )
}

async fn put_world(app: &TestApp, cookie: &str, body: String) -> common::Reply {
    let request = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/world")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
        .body(Body::from(body))
        .unwrap();
    app.send(request).await
}

fn gunzip(bytes: &[u8]) -> Value {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).unwrap();
    serde_json::from_str(&text).unwrap()
}

async fn load(app: &TestApp, path: &str, cookie: Option<&str>, tag: Option<&str>) -> common::Reply {
    let mut request = Request::builder()
        .method("GET")
        .uri(path)
        .header(header::ORIGIN, ORIGIN)
        .header(header::ACCEPT_ENCODING, "gzip, deflate, br");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(tag) = tag {
        request = request.header(header::IF_NONE_MATCH, tag);
    }
    app.send(request.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn 한_회원의_저장은_한_번에_하나씩이고_여러_회원의_저장은_자리를_기다린다() {
    let app = TestApp::new(None).await;
    let owner = app.register("save_once", "Owner").await;
    let owner_id = app.user_id("save_once").await;
    // Saves sent at once by one member: one is read and stored, the others are turned away before their bodies are.
    let replies = join_all((0..10).map(|at| put_world(&app, &owner, big_save(owner_id, &format!("w{at}"))))).await;
    let codes: Vec<(StatusCode, Option<String>)> =
        replies.iter().map(|reply| (reply.status, reply.body["code"].as_str().map(str::to_owned))).collect();
    assert!(codes.iter().any(|(status, _)| *status == StatusCode::OK), "{codes:?}");
    assert!(
        codes.iter().all(|code| code.0 == StatusCode::OK
            || *code == (StatusCode::TOO_MANY_REQUESTS, Some("world_saving".to_owned()))),
        "{codes:?}"
    );
    assert!(codes.iter().any(|(status, _)| *status == StatusCode::TOO_MANY_REQUESTS), "{codes:?}");
    // Once it is done the member saves again.
    let again = put_world(&app, &owner, big_save(owner_id, "again")).await;
    assert_eq!(again.status, StatusCode::OK, "{:?}", again.body);

    // Many members at once: past the site's few slots they wait their turn, and every save is stored.
    let mut members = Vec::new();
    for at in 0..8 {
        let name = format!("save_many{at}");
        members.push((app.register(&name, "Member").await, app.user_id(&name).await));
    }
    let replies = join_all(members.iter().map(|(cookie, id)| put_world(&app, cookie, big_save(*id, "w")))).await;
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    assert!(statuses.iter().all(|status| *status == StatusCode::OK), "{statuses:?}");

    // A body that says it is past the limit is refused before it is read.
    let request = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/world")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, (3 * 1024 * 1024).to_string())
        .header(header::COOKIE, &owner)
        .body(Body::from("{}"))
        .unwrap();
    let refused = app.send(request).await;
    assert_eq!(
        (refused.status, refused.body["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("world_too_large"))
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 같은_판의_섬은_한_번_압축해_다시_보내고_저장하면_새로_보낸다() {
    let app = TestApp::new(None).await;
    let owner = app.register("load_owner", "Owner").await;
    let visitor = app.register("load_visitor", "Visitor").await;
    let world = json!({"worldId": "main", "baseRevision": 0, "data": {"version": 1, "savedAt": 1,
        "domains": {"building": {"name": "첫 판"}}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(&owner)).await.status, StatusCode::OK);
    let path = "/api/homes/load_owner/world?worldId=main";

    let first = load(&app, path, Some(&visitor), None).await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(first.headers[header::CONTENT_TYPE], "application/json");
    let sent = gunzip(&first.bytes);
    assert_eq!(sent["data"]["domains"]["building"]["name"], "첫 판");
    assert_eq!(sent["revision"], 1);
    let tag = first.headers[header::ETAG].to_str().unwrap().to_owned();

    // The stored text changes under the same revision (as nothing but this test can): a gzipped load is still the
    // copy made for that revision, while a load that takes no gzip reads the database.
    sqlx::query(
        "UPDATE home_worlds SET data = '{\"version\":1,\"savedAt\":1,\"domains\":{\"building\":{\"name\":\"몰래\"}}}'",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let again = load(&app, path, None, None).await;
    assert_eq!(gunzip(&again.bytes)["data"]["domains"]["building"]["name"], "첫 판");
    let plain = app.call("GET", path, None, None).await;
    assert!(plain.headers.get(header::CONTENT_ENCODING).is_none());
    assert_eq!(plain.body["data"]["domains"]["building"]["name"], "몰래");
    // A browser that holds this revision gets nothing again.
    assert_eq!(load(&app, path, Some(&visitor), Some(&tag)).await.status, StatusCode::NOT_MODIFIED);

    // A save is a new revision: the next load is made from it.
    let next = json!({"worldId": "main", "baseRevision": 1, "data": {"version": 1, "savedAt": 2,
        "domains": {"building": {"name": "둘째 판"}}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(next), Some(&owner)).await.status, StatusCode::OK);
    let fresh = load(&app, path, Some(&visitor), Some(&tag)).await;
    assert_eq!(fresh.status, StatusCode::OK);
    assert_eq!(gunzip(&fresh.bytes)["data"]["domains"]["building"]["name"], "둘째 판");

    // Members' loads are counted too.
    let visitor_id = app.user_id("load_visitor").await;
    for _ in 0..600 {
        rate_record(&app.state, format!("world-read-member:{visitor_id}"));
    }
    let limited = load(&app, path, Some(&visitor), None).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(load(&app, path, Some(&owner), None).await.status, StatusCode::OK);
    app.cleanup().await;
}

fn usernames(reply: &common::Reply) -> Vec<String> {
    reply.body["homes"].as_array().unwrap().iter().map(|home| home["username"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn 둘러보기의_쪽은_섬이_자동_저장해도_그대로다() {
    let app = TestApp::new(None).await;
    let mut cookies = Vec::new();
    for name in ["page_a", "page_b", "page_c", "page_d"] {
        let cookie = app.register(name, name).await;
        app.call("PATCH", "/api/homes/me", Some(json!({"title": format!("{name} 섬")})), Some(&cookie)).await;
        cookies.push(cookie);
    }
    let first = app.call("GET", "/api/homes?q=page&limit=2", None, None).await;
    assert_eq!(usernames(&first), ["page_d", "page_c"]);
    let before = first.body["homes"][1]["updatedAt"].as_str().unwrap().to_owned();
    // Islands further down autosave while the first page is read: they keep their places.
    for (at, cookie) in cookies.iter().enumerate().take(2) {
        let world = json!({"worldId": "main", "baseRevision": 0, "data": {"version": 1, "savedAt": at, "domains": {}}});
        assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(cookie)).await.status, StatusCode::OK);
    }
    let path = format!("/api/homes?q=page&limit=2&before={}", before.replace('+', "%2B").replace(':', "%3A"));
    let second = app.call("GET", &path, None, None).await;
    assert_eq!(usernames(&second), ["page_b", "page_a"]);
    // An island edited a while ago moves up with its next save.
    sqlx::query(
        "UPDATE homes SET updated_at = now() - interval '11 minutes'
         WHERE owner_id = (SELECT id FROM users WHERE username = 'page_a')",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let world = json!({"worldId": "main", "baseRevision": 1, "data": {"version": 1, "savedAt": 9, "domains": {}}});
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(&cookies[0])).await.status, StatusCode::OK);
    assert_eq!(usernames(&app.call("GET", "/api/homes?limit=1", None, None).await), ["page_a"]);
    // The listing's order has an index; the search's trigram indexes come with pg_trgm where the database has it.
    let indexes: Vec<String> =
        sqlx::query_scalar("SELECT indexname::text FROM pg_indexes WHERE tablename IN ('homes', 'users')")
            .fetch_all(&app.state.db)
            .await
            .unwrap();
    assert!(indexes.iter().any(|index| index == "homes_listing"), "{indexes:?}");
    let trigrams: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    if trigrams {
        for index in ["users_username_trgm", "users_display_name_trgm", "homes_title_trgm"] {
            assert!(indexes.iter().any(|name| name == index), "{index} in {indexes:?}");
        }
    }
    app.cleanup().await;
}

#[tokio::test]
async fn 같은_때에_바뀐_섬들도_쪽을_넘기면_하나도_빠지거나_겹치지_않는다() {
    let app = TestApp::new(None).await;
    for name in ["tie_a", "tie_b", "tie_c"] {
        app.register(name, name).await;
    }
    // Saved at the very same time, as a bulk change leaves them.
    sqlx::query("UPDATE homes SET updated_at = '2026-10-01T00:00:00Z'").execute(&app.state.db).await.unwrap();
    let first = app.call("GET", "/api/homes?limit=2", None, None).await;
    let last = &first.body["homes"][1];
    let before = last["updatedAt"].as_str().unwrap().replace('+', "%2B").replace(':', "%3A");
    let owner = last["ownerId"].as_str().unwrap();
    let second = app.call("GET", &format!("/api/homes?limit=2&before={before}&beforeId={owner}"), None, None).await;
    let mut listed = [usernames(&first), usernames(&second)].concat();
    listed.sort();
    assert_eq!(listed, ["tie_a", "tie_b", "tie_c"]);
    // Without the owner the cursor stands before every island of its time, as it did: none is shown twice.
    let older = app.call("GET", &format!("/api/homes?limit=2&before={before}"), None, None).await;
    assert_eq!(usernames(&older), Vec::<String>::new());
    // The search has its indexes in this database (pg_trgm), and says so once one is gone.
    let trigrams: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(homes::search_indexed(&app.state.db).await.unwrap(), trigrams);
    sqlx::query("DROP INDEX IF EXISTS homes_title_trgm").execute(&app.state.db).await.unwrap();
    assert!(!homes::search_indexed(&app.state.db).await.unwrap());
    app.cleanup().await;
}

/// A save request whose body stops coming after its first bytes, from `address`.
fn stalled_save(cookie: &str, address: &str) -> Request<Body> {
    let body = futures_util::stream::once(async { Ok::<_, std::io::Error>(Bytes::from_static(b"{\"worldId\":")) })
        .chain(futures_util::stream::pending());
    Request::builder()
        .method("PUT")
        .uri("/api/homes/me/world")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
        .header("x-forwarded-for", address)
        .body(Body::from_stream(body))
        .unwrap()
}

#[tokio::test]
async fn 천천히_오는_저장_본문은_다른_회원의_저장을_막지_않는다() {
    let app = TestApp::new(None).await;
    // More members than the site has save slots start saves whose bodies stop coming.
    let mut stalled = Vec::new();
    for at in 0..6 {
        let cookie = app.register(&format!("slow_{at}"), "Slow").await;
        let router = app.router.clone();
        let request = stalled_save(&cookie, &format!("203.0.113.{at}"));
        stalled.push(tokio::spawn(async move { router.oneshot(request).await }));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Another member's save is read, checked and stored at once.
    let quick = app.register("quick_saver", "Quick").await;
    let started = Instant::now();
    let world = json!({"worldId": "main", "baseRevision": 0, "data": {"version": 1, "savedAt": 1, "domains": {}}});
    let reply = app.call("PUT", "/api/homes/me/world", Some(world), Some(&quick)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    for task in stalled {
        task.abort();
    }
    app.cleanup().await;
}

/// What `router` answers `request` with: its status and its error code, if any.
async fn answer(router: &axum::Router, request: Request<Body>) -> (StatusCode, Option<String>) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)["code"].as_str().map(str::to_owned))
}

/// A small save of `world` from `address`, its text gzipped when `packed`.
fn small_save(cookie: &str, owner: Uuid, world: &str, address: &str, packed: bool) -> Request<Body> {
    let text = format!(
        r#"{{"expectedOwnerId":"{owner}","worldId":"{world}","baseRevision":0,"data":{{"version":1,"savedAt":1,"domains":{{"building":{{"name":"압축"}}}}}}}}"#
    );
    let mut request = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/world")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
        .header("x-forwarded-for", address);
    let body = if packed {
        request = request.header(header::CONTENT_ENCODING, "gzip");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    } else {
        text.into_bytes()
    };
    request.body(Body::from(body)).unwrap()
}

#[tokio::test]
async fn 저장은_정해진_시간_안에_답하고_본문이_늦으면_incomplete_world_자리를_못_잡으면_world_busy다() {
    let app = TestApp::new(None).await;
    // The production budget is 24 s; this site's is 2.4 s, its parts in the same shares.
    let budget = Duration::from_millis(2_400);
    let mut state = app.state.clone();
    state.homes = Homes::default().within(budget);
    let router = mogaesup_server::router(state);
    // A body that stops coming is answered once it is due (three quarters of the budget): sent again as it is.
    let slow = app.register("budget_slow", "Slow").await;
    let started = Instant::now();
    let reply = answer(&router, stalled_save(&slow, "198.51.100.1")).await;
    assert_eq!(reply, (StatusCode::BAD_REQUEST, Some("incomplete_world".to_owned())));
    assert!(started.elapsed() >= budget * 3 / 4 - Duration::from_millis(50) && started.elapsed() < budget * 2);
    // An address whose four places are held by bodies that stop coming: one more save from there is turned away once
    // its wait for a place (a sixth of the budget) is over.
    let mut cookies = Vec::new();
    for at in 0..4 {
        cookies.push(app.register(&format!("budget_held{at}"), "Held").await);
    }
    let late = app.register("budget_late", "Late").await;
    let late_id = app.user_id("budget_late").await;
    let held: Vec<_> = cookies
        .into_iter()
        .map(|cookie| {
            let router = router.clone();
            tokio::spawn(async move { answer(&router, stalled_save(&cookie, "198.51.100.2")).await })
        })
        .collect();
    // Their places taken, their bodies not due for a while yet.
    tokio::time::sleep(budget / 5).await;
    let started = Instant::now();
    let reply = answer(&router, small_save(&late, late_id, "w", "198.51.100.2", false)).await;
    assert_eq!(reply, (StatusCode::TOO_MANY_REQUESTS, Some("world_busy".to_owned())));
    assert!(started.elapsed() >= budget / 6 - Duration::from_millis(50) && started.elapsed() < budget);
    for task in held {
        assert_eq!(task.await.unwrap(), (StatusCode::BAD_REQUEST, Some("incomplete_world".to_owned())));
    }
    app.cleanup().await;
}

#[tokio::test]
async fn 압축해서_보낸_섬도_저장하고_다른_방식은_받지_않는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("packed_save", "Packed").await;
    let owner_id = app.user_id("packed_save").await;
    let reply = answer(&app.router, small_save(&owner, owner_id, "main", "198.51.100.3", true)).await;
    assert_eq!(reply, (StatusCode::OK, None));
    let loaded = app.call("GET", "/api/homes/packed_save/world?worldId=main", None, Some(&owner)).await;
    assert_eq!(loaded.body["data"]["domains"]["building"]["name"], "압축");
    let mut other = small_save(&owner, owner_id, "other", "198.51.100.3", false);
    other.headers_mut().insert(header::CONTENT_ENCODING, "br".parse().unwrap());
    assert_eq!(
        answer(&app.router, other).await,
        (StatusCode::UNSUPPORTED_MEDIA_TYPE, Some("unsupported_encoding".into()))
    );
    app.cleanup().await;
}

#[tokio::test]
async fn 사이트의_섬이_가득_차면_섬을_키우는_저장만_막는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("full_site", "Full").await;
    let owner_id = app.user_id("full_site").await;
    let small = r#"{"version":1,"savedAt":1,"domains":{}}"#;
    // A site that keeps about two small islands.
    let mut state = app.state.clone();
    state.homes = Homes::with_site_limit(2 * small.len() as i64 - 1);
    let router = mogaesup_server::router(state);
    let save = |world: &str, base: i64, data: &str| {
        let body =
            format!(r#"{{"expectedOwnerId":"{owner_id}","worldId":"{world}","baseRevision":{base},"data":{data}}}"#);
        let request = Request::builder()
            .method("PUT")
            .uri("/api/homes/me/world")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &owner)
            .body(Body::from(body))
            .unwrap();
        let router = router.clone();
        async move {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)["code"].as_str().map(str::to_owned))
        }
    };
    assert_eq!(save("a", 0, small).await.0, StatusCode::OK);
    assert_eq!(save("b", 0, small).await.0, StatusCode::OK);
    // Full: a new world, or a larger one, is refused; one that keeps its size still saves.
    assert_eq!(save("c", 0, small).await, (StatusCode::INSUFFICIENT_STORAGE, Some("site_storage_full".into())));
    let larger = r#"{"version":1,"savedAt":1,"domains":{"building":{}}}"#;
    assert_eq!(save("a", 1, larger).await, (StatusCode::INSUFFICIENT_STORAGE, Some("site_storage_full".into())));
    assert_eq!(save("a", 1, r#"{"version":1,"savedAt":2,"domains":{}}"#).await.0, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn 한_회원의_사진은_하나씩_받고_작은_요청의_본문은_작게만_읽는다() {
    let app = TestApp::new(None).await;
    let owner = app.register("one_picture", "Picture").await;
    let body = futures_util::stream::once(async { Ok::<_, std::io::Error>(Bytes::from_static(b"{\"image\":")) })
        .chain(futures_util::stream::pending());
    let request = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/thumbnail")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &owner)
        .body(Body::from_stream(body))
        .unwrap();
    let router = app.router.clone();
    let first = tokio::spawn(async move { router.oneshot(request).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let second = app.call("PUT", "/api/homes/me/thumbnail", Some(json!({"image": ""})), Some(&owner)).await;
    assert_eq!((second.status, second.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("picture_saving")));
    first.abort();
    // Once the first is gone the next is read.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let id = app.user_id("one_picture").await;
    let third = app
        .call("PUT", "/api/homes/me/thumbnail", Some(json!({"expectedOwnerId": id, "image": ""})), Some(&owner))
        .await;
    assert_eq!(third.body["code"], "invalid_picture");

    // A visit, a profile change or a guestbook entry is a few hundred bytes: a body past a few kilobytes is refused
    // without being read on.
    let padded = json!({"body": "안녕", "pad": "x".repeat(16 * 1024)});
    for (method, path) in [("POST", "/api/homes/one_picture/visits"), ("POST", "/api/homes/one_picture/guestbook")] {
        let reply = app.call(method, path, Some(padded.clone()), Some(&owner)).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::PAYLOAD_TOO_LARGE, Some("too_large")),
            "{path}"
        );
    }
    // A look takes more, up to what a full wardrobe sends.
    let look = app
        .call(
            "PUT",
            "/api/looks/me",
            Some(json!({"body": {"jobId": "j", "version": "v"}, "pad": "x".repeat(16 * 1024)})),
            Some(&owner),
        )
        .await;
    assert_ne!(look.status, StatusCode::PAYLOAD_TOO_LARGE);
    app.cleanup().await;
}
