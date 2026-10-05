//! Island saves and loads under load: one save at a time per member, a few site-wide, loads sent from a compressed
//! copy per revision, and a listing whose pages stay put while islands autosave.

mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use common::{ORIGIN, TestApp};
use futures_util::future::join_all;
use mogaesup_server::security::rate_record;
use serde_json::{Value, json};
use std::io::Read;
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
