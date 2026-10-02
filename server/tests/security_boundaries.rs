mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use common::{ORIGIN, TestApp, TestDb};
use futures_util::future::join_all;
use mogaesup_server::{
    auth,
    rebac::{Checker, Object, Subject},
    security::rate_record,
};
use serde_json::json;

#[tokio::test]
async fn edits_remain_bound_to_the_account_that_loaded_the_page() {
    let app = TestApp::new(None).await;
    let alice = app.register("edit_alice", "Alice").await;
    let bob = app.register("edit_bob", "Bob").await;
    let alice_id = app.user_id("edit_alice").await;
    let world = json!({"expectedOwnerId": alice_id, "worldId": "shared", "baseRevision": 0,
        "data": {"version": 1, "savedAt": 1, "domains": {}}});
    let reply = app.call("PUT", "/api/homes/me/world", Some(world.clone()), Some(&bob)).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::CONFLICT, Some("owner_changed")));
    assert_eq!(app.call("PUT", "/api/homes/me/world", Some(world), Some(&alice)).await.status, StatusCode::OK);
    let profile = app
        .call("PATCH", "/api/homes/me", Some(json!({"expectedOwnerId": alice_id, "title": "Alice edit"})), Some(&bob))
        .await;
    assert_eq!(profile.body["code"], "owner_changed");
    assert_eq!(app.call("GET", "/api/homes/edit_bob", None, None).await.body["profile"]["title"], "Bob의 섬");
    assert_eq!(
        app.call("GET", "/api/homes/edit_bob/world?worldId=shared", None, None).await.status,
        StatusCode::NO_CONTENT
    );
    for (method, path, body) in [
        ("PATCH", "/api/homes/me", json!({"title": "missing owner"})),
        ("PUT", "/api/homes/me/world", json!({"worldId": "x", "baseRevision": 0, "data": {}})),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &bob)
            .body(Body::from(body.to_string()))
            .unwrap();
        assert_eq!(app.send(request).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    app.cleanup().await;
}

#[tokio::test]
async fn concurrent_logins_reserve_the_remaining_failure_budget_and_success_refunds_it() {
    let app = TestApp::new(None).await;
    app.register("login_budget", "Member").await;
    for _ in 0..29 {
        rate_record(&app.state, "login-failed-address:local".into());
    }
    let login = app
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "login_budget", "password": "correct horse battery"})),
            None,
        )
        .await;
    assert_eq!(login.status, StatusCode::OK);
    let replies = join_all((0..5).map(|_| {
        app.call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "login_budget", "password": "wrong password"})),
            None,
        )
    }))
    .await;
    assert_eq!(replies.iter().filter(|reply| reply.status == StatusCode::UNAUTHORIZED).count(), 1);
    assert_eq!(replies.iter().filter(|reply| reply.status == StatusCode::TOO_MANY_REQUESTS).count(), 4);
    app.cleanup().await;
}

#[tokio::test]
async fn direct_group_membership_survives_more_than_five_hundred_usersets() {
    let app = TestApp::new(None).await;
    app.register("large_group", "Member").await;
    let id = app.user_id("large_group").await;
    app.grant("large_group", "group:root", "member").await;
    sqlx::query(
        "INSERT INTO auth_tuples (object_type, object_id, relation, subject_type, subject_id, subject_relation)
        SELECT 'group', 'root', 'member', 'group', 'nested_' || at, 'member' FROM generate_series(1, 501) at",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    assert!(
        Checker::new(&app.state.db)
            .check(Subject::User(id), &Object::parse("group:root").unwrap(), "member")
            .await
            .unwrap()
    );
    app.cleanup().await;
}

#[tokio::test]
async fn anonymous_visits_ignore_client_chosen_uuids_and_have_an_address_limit() {
    let app = TestApp::new(None).await;
    app.register("visit_target", "Host").await;
    for _ in 0..120 {
        let reply = app
            .call("POST", "/api/homes/visit_target/visits", Some(json!({"visitorId": uuid::Uuid::new_v4()})), None)
            .await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.body["today"], 1);
    }
    assert_eq!(
        app.call("POST", "/api/homes/visit_target/visits", Some(json!({})), None).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM home_visits").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(rows, 1);
    app.cleanup().await;
}

#[tokio::test]
async fn concurrent_visitors_share_the_daily_storage_cap() {
    let app = TestApp::new(None).await;
    app.register("visit_cap", "Host").await;
    let left = app.register("visit_left", "Left").await;
    let right = app.register("visit_right", "Right").await;
    let owner = app.user_id("visit_cap").await;
    sqlx::query("INSERT INTO home_visits (owner_id, day, visitor) SELECT $1, (now() AT TIME ZONE 'Asia/Seoul')::date, 'fixture:' || n FROM generate_series(1, 9999) AS n")
        .bind(owner).execute(&app.state.db).await.unwrap();
    sqlx::query("UPDATE homes SET visits_total = 9999 WHERE owner_id = $1")
        .bind(owner)
        .execute(&app.state.db)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        app.call("POST", "/api/homes/visit_cap/visits", Some(json!({})), Some(&left)),
        app.call("POST", "/api/homes/visit_cap/visits", Some(json!({})), Some(&right))
    );
    assert_eq!((a.status, b.status), (StatusCode::OK, StatusCode::OK));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM home_visits").fetch_one(&app.state.db).await.unwrap(),
        10_000
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT visits_total FROM homes WHERE owner_id = $1")
            .bind(owner)
            .fetch_one(&app.state.db)
            .await
            .unwrap(),
        10_000
    );
    app.cleanup().await;
}

#[tokio::test]
async fn guestbook_spam_and_concurrent_storage_growth_are_bounded() {
    let app = TestApp::new(None).await;
    let host = app.register("book_host", "Host").await;
    let guest = app.register("book_guest", "Guest").await;
    let owner = app.user_id("book_host").await;
    for _ in 0..30 {
        assert_eq!(
            app.call("POST", "/api/homes/book_host/guestbook", Some(json!({"body": "hello"})), Some(&host))
                .await
                .status,
            StatusCode::CREATED
        );
    }
    assert_eq!(
        app.call("POST", "/api/homes/book_host/guestbook", Some(json!({"body": "spam"})), Some(&host)).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query(
        "INSERT INTO guestbook_entries (id, home_owner_id, author_id, body)
        SELECT gen_random_uuid(), $1, $1, 'kept entry' FROM generate_series(1, 1969)",
    )
    .bind(owner)
    .execute(&app.state.db)
    .await
    .unwrap();
    // Exactly one place remains. Two concurrent writes must never make 2001 rows.
    let replies = join_all((0..2).map(|_| {
        app.call("POST", "/api/homes/book_host/guestbook", Some(json!({"body": "last place"})), Some(&guest))
    }))
    .await;
    assert_eq!(replies.iter().filter(|reply| reply.status == StatusCode::CREATED).count(), 1);
    assert_eq!(replies.iter().filter(|reply| reply.body["code"] == "guestbook_full").count(), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM guestbook_entries WHERE deleted_at IS NULL")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(count, 2000);
    app.cleanup().await;
}

#[tokio::test]
async fn opposite_ilchon_requests_and_accept_unlink_share_one_atomic_pair() {
    let app = TestApp::new(None).await;
    let alice = app.register("pair_alice", "Alice").await;
    let bob = app.register("pair_bob", "Bob").await;
    let body = json!({"name": "friend", "theirName": "friend"});
    let (left, right) = tokio::join!(
        app.call("POST", "/api/ilchon/pair_bob/request", Some(body.clone()), Some(&alice)),
        app.call("POST", "/api/ilchon/pair_alice/request", Some(body), Some(&bob))
    );
    assert_eq!([left.status, right.status].iter().filter(|status| **status == StatusCode::CREATED).count(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ilchon_requests").fetch_one(&app.state.db).await.unwrap(),
        1
    );
    let (id, from): (uuid::Uuid, uuid::Uuid) =
        sqlx::query_as("SELECT id, from_id FROM ilchon_requests").fetch_one(&app.state.db).await.unwrap();
    let (recipient, unlink, target) =
        if from == app.user_id("pair_alice").await { (&bob, &alice, "pair_bob") } else { (&alice, &bob, "pair_alice") };
    let path = format!("/api/ilchon-requests/{id}/accept");
    let unlink_path = format!("/api/ilchon/{target}");
    let (accepted, removed) = tokio::join!(
        app.call("POST", &path, Some(json!({})), Some(recipient)),
        app.call("DELETE", &unlink_path, None, Some(unlink))
    );
    assert!(matches!(accepted.status, StatusCode::OK | StatusCode::NOT_FOUND));
    if accepted.status == StatusCode::OK {
        assert_eq!(accepted.body["relation"], "ilchon");
        assert!(accepted.body["ilchon"].is_object());
    }
    assert_eq!(removed.status, StatusCode::NO_CONTENT);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ilchons").fetch_one(&app.state.db).await.unwrap(), 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ilchon_requests").fetch_one(&app.state.db).await.unwrap(),
        0
    );
    app.cleanup().await;
}

#[tokio::test]
async fn concurrent_ilchon_requests_share_the_recipients_pending_cap() {
    let app = TestApp::new(None).await;
    app.register("request_cap", "Recipient").await;
    let left = app.register("request_left", "Left").await;
    let right = app.register("request_right", "Right").await;
    let target = app.user_id("request_cap").await;
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash) SELECT gen_random_uuid(), 'pending_' || n, 'Pending', 'unused fixture' FROM generate_series(1, 99) AS n")
        .execute(&app.state.db).await.unwrap();
    sqlx::query("INSERT INTO ilchon_requests (id, from_id, to_id, name, their_name) SELECT gen_random_uuid(), id, $1, 'friend', 'friend' FROM users WHERE username LIKE 'pending_%'")
        .bind(target).execute(&app.state.db).await.unwrap();
    let body = json!({"name": "friend", "theirName": "friend"});
    let (a, b) = tokio::join!(
        app.call("POST", "/api/ilchon/request_cap/request", Some(body.clone()), Some(&left)),
        app.call("POST", "/api/ilchon/request_cap/request", Some(body), Some(&right))
    );
    assert_eq!([&a, &b].iter().filter(|reply| reply.status == StatusCode::CREATED).count(), 1);
    assert_eq!([&a, &b].iter().filter(|reply| reply.body["code"] == "requests_full").count(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ilchon_requests WHERE to_id = $1")
            .bind(target)
            .fetch_one(&app.state.db)
            .await
            .unwrap(),
        100
    );
    app.cleanup().await;
}

#[tokio::test]
async fn bootstrap_requires_existing_account_ownership_and_reserved_names_cannot_be_registered() {
    let app = TestApp::new(None).await;
    let reserved = app
        .call(
            "POST",
            "/api/auth/register",
            Some(json!({"username": "ydh2244", "password": "correct horse battery"})),
            None,
        )
        .await;
    assert_eq!(reserved.status, StatusCode::CONFLICT);
    let member = app.register("claimed_admin", "Member").await;
    assert!(auth::bootstrap_admin(&app.state, "claimed_admin", "another password").await.is_err());
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&member)).await.body["user"]["role"], "user");
    auth::bootstrap_admin(&app.state, "claimed_admin", "correct horse battery").await.unwrap();
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&member)).await.body["user"]["role"], "admin");
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'claimed_admin'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let old = TestDb::create().await;
    sqlx::raw_sql(include_str!("../migrations/0001_accounts.sql")).execute(&old.pool).await.unwrap();
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, 'ydh2244', 'legacy', $2)")
        .bind(uuid::Uuid::new_v4())
        .bind(hash)
        .execute(&old.pool)
        .await
        .unwrap();
    assert!(auth::verify_legacy_admin_before_migration(&old.pool, None).await.is_err());
    assert!(auth::verify_legacy_admin_before_migration(&old.pool, Some(("ydh2244", "wrong password"))).await.is_err());
    auth::verify_legacy_admin_before_migration(&old.pool, Some(("ydh2244", "correct horse battery"))).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/20260930120000_permissions.sql")).execute(&old.pool).await.unwrap();
    // Existing legacy administrators are preserved rather than automatically stripped of access.
    auth::verify_legacy_admin_before_migration(&old.pool, None).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE username = 'ydh2244'")
            .fetch_one(&old.pool)
            .await
            .unwrap(),
        "admin"
    );
    old.remove().await;
    app.cleanup().await;
}
