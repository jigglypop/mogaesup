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
    // A legacy/stale draft must not be attributed to whichever account is now signed in.
    let world = json!({"worldId": "older", "baseRevision": 0, "data": {"version": 1, "savedAt": 1, "domains": {}}});
    for (method, path, body) in [
        ("PATCH", "/api/homes/me", json!({"title": "older tab", "fieldFromANewerPage": true})),
        ("PATCH", "/api/homes/me", json!({"title": "null owner", "expectedOwnerId": null})),
        (
            "PUT",
            "/api/homes/me/world",
            json!({"worldId": "null-owner", "baseRevision": 0,
            "expectedOwnerId": null, "data": {"version": 1, "savedAt": 1, "domains": {}}}),
        ),
        ("PUT", "/api/homes/me/world", world),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &bob)
            .body(Body::from(body.to_string()))
            .unwrap();
        let reply = app.send(request).await;
        assert_eq!(reply.status, StatusCode::CONFLICT, "{method} {path}: {:?}", reply.body);
        assert_eq!(reply.body["code"], "owner_changed");
    }
    assert_eq!(app.call("GET", "/api/homes/edit_bob", None, None).await.body["profile"]["title"], "Bob의 섬");
    let saved = app.call("GET", "/api/homes/edit_bob/world?worldId=older", None, None).await;
    assert_eq!(saved.status, StatusCode::NO_CONTENT);
    app.cleanup().await;
}

fn login(username: &str, password: &str) -> Option<serde_json::Value> {
    Some(json!({"username": username, "password": password}))
}

#[tokio::test]
async fn a_burst_of_wrong_passwords_passes_the_accounts_budget_by_the_hashing_slots_at_most() {
    let app = TestApp::new(None).await;
    app.register("login_budget", "Member").await;
    for _ in 0..49 {
        rate_record(&app.state, "login-failed:login_budget".into());
    }
    // A right password costs nothing.
    let ok = app.call("POST", "/api/auth/login", login("login_budget", "correct horse battery"), None).await;
    assert_eq!(ok.status, StatusCode::OK);
    // One place was left. Checks hold nothing while they wait; the budget is looked at again once a hashing slot is
    // held, and two run at once, so at most two are checked.
    let replies =
        join_all((0..5).map(|_| app.call("POST", "/api/auth/login", login("login_budget", "wrong password"), None)))
            .await;
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    let checked = statuses.iter().filter(|status| **status == StatusCode::UNAUTHORIZED).count();
    assert!((1..=2).contains(&checked), "{statuses:?}");
    assert!(statuses.iter().all(|status| matches!(
        *status,
        StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
    )));
    let spent = app.call("POST", "/api/auth/login", login("login_budget", "correct horse battery"), None).await;
    assert_eq!(spent.status, StatusCode::TOO_MANY_REQUESTS);
    app.cleanup().await;
}

#[tokio::test]
async fn people_behind_one_address_do_not_lock_each_other_out() {
    let app = TestApp::new(None).await;
    let names: Vec<String> = (0..5).map(|at| format!("shared_{at}")).collect();
    let mut cookies = Vec::new();
    for name in &names {
        cookies.push(app.register(name, "Member").await);
    }
    // Sign-ins still running or that succeed never use the address's budget; only wrong passwords do.
    for _ in 0..29 {
        rate_record(&app.state, "login-failed-address:local".into());
    }
    let replies = join_all(
        names.iter().map(|name| app.call("POST", "/api/auth/login", login(name, "correct horse battery"), None)),
    )
    .await;
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    assert!(statuses.iter().all(|status| *status == StatusCode::OK), "{statuses:?}");
    let wrong = app.call("POST", "/api/auth/login", login("shared_0", "wrong password"), None).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let spent = app.call("POST", "/api/auth/login", login("shared_1", "correct horse battery"), None).await;
    assert_eq!(spent.status, StatusCode::TOO_MANY_REQUESTS);

    // Guestbook entries that could not be written cost the address nothing.
    for cookie in &cookies[..3] {
        for _ in 0..25 {
            let reply =
                app.call("POST", "/api/homes/shared_4/guestbook", Some(json!({"body": " "})), Some(cookie)).await;
            assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
    let written =
        app.call("POST", "/api/homes/shared_4/guestbook", Some(json!({"body": "안녕"})), Some(&cookies[3])).await;
    assert_eq!(written.status, StatusCode::CREATED);

    // Anonymous visits share the address's budget; members and the owner's own page loads do not use it.
    for _ in 0..120 {
        assert_eq!(app.call("POST", "/api/homes/shared_4/visits", Some(json!({})), None).await.status, StatusCode::OK);
    }
    let anonymous = app.call("POST", "/api/homes/shared_4/visits", Some(json!({})), None).await;
    assert_eq!(anonymous.status, StatusCode::TOO_MANY_REQUESTS);
    let member = app.call("POST", "/api/homes/shared_4/visits", Some(json!({})), Some(&cookies[0])).await;
    assert_eq!((member.status, member.body["today"].as_i64()), (StatusCode::OK, Some(2)));
    let owner = app.call("POST", "/api/homes/shared_4/visits", Some(json!({})), Some(&cookies[4])).await;
    assert_eq!((owner.status, owner.body["today"].as_i64()), (StatusCode::OK, Some(2)));
    app.cleanup().await;
}

#[tokio::test]
async fn a_burst_of_wrong_passwords_passes_the_address_budget_by_a_few_at_most() {
    let app = TestApp::new(None).await;
    app.register("burst_member", "Member").await;
    for _ in 0..25 {
        rate_record(&app.state, "login-failed-address:local".into());
    }
    let replies =
        join_all((0..14).map(|_| app.call("POST", "/api/auth/login", login("burst_member", "wrong password"), None)))
            .await;
    let statuses: Vec<StatusCode> = replies.iter().map(|reply| reply.status).collect();
    let checked = statuses.iter().filter(|status| **status == StatusCode::UNAUTHORIZED).count();
    // Five were left. All fourteen pass the first look at the budget together; the second, once a hashing slot is held,
    // lets through only the few still hashing or about to be counted.
    assert!((1..=9).contains(&checked), "{statuses:?}");
    assert!(statuses.iter().all(|status| matches!(
        *status,
        StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
    )));
    app.cleanup().await;
}

#[tokio::test]
async fn a_burst_of_password_checks_is_turned_away_instead_of_waiting_forever() {
    let app = TestApp::new(None).await;
    app.register("busy_member", "Member").await;
    let held = app.state.hashing.clone().acquire_many_owned(2).await.unwrap();
    let started = std::time::Instant::now();
    let reply = app.call("POST", "/api/auth/login", login("busy_member", "correct horse battery"), None).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("busy")));
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
    drop(held);
    // The refused attempt was not a wrong password: the account and the address keep their budgets.
    let again = app.call("POST", "/api/auth/login", login("busy_member", "correct horse battery"), None).await;
    assert_eq!(again.status, StatusCode::OK);
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
    assert_eq!([&a, &b].iter().filter(|reply| reply.body["code"] == "their_requests_full").count(), 1);
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
async fn a_few_writers_cannot_fill_someone_elses_guestbook_and_the_owner_clears_one_at_once() {
    let app = TestApp::new(None).await;
    let host = app.register("cap_host", "Host").await;
    let guest = app.register("cap_guest", "Guest").await;
    let friend = app.register("cap_friend", "Friend").await;
    let book = "/api/homes/cap_host/guestbook";
    let write = |cookie: &str| {
        let cookie = cookie.to_owned();
        let app = &app;
        async move { app.call("POST", book, Some(json!({"body": "hello"})), Some(&cookie)).await }
    };
    // Ten a day from one writer in one guestbook.
    for _ in 0..10 {
        assert_eq!(write(&guest).await.status, StatusCode::CREATED);
    }
    let refused = write(&guest).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::CONFLICT, Some("guestbook_author_full")));
    assert_eq!(write(&friend).await.status, StatusCode::CREATED, "other writers are not held back");
    // The owner is not limited in their own guestbook.
    for _ in 0..12 {
        assert_eq!(write(&host).await.status, StatusCode::CREATED);
    }

    // Only the owner (or a moderator) clears one writer's entries, all at once.
    let path = format!("{book}?author=cap_guest");
    assert_eq!(app.call("DELETE", &path, None, Some(&friend)).await.status, StatusCode::FORBIDDEN);
    let cleared = app.call("DELETE", &path, None, Some(&host)).await;
    assert_eq!((cleared.status, cleared.body["deleted"].as_u64()), (StatusCode::OK, Some(10)));
    let listing = app.call("GET", book, None, Some(&host)).await;
    assert_eq!(listing.body["total"], 13);
    assert!(listing.body["entries"].as_array().unwrap().iter().all(|entry| entry["author"]["username"] != "cap_guest"));
    // Deleted entries still count toward the day, so clearing does not hand the writer a new ten.
    assert_eq!(write(&guest).await.body["code"], "guestbook_author_full");
    let unknown = app.call("DELETE", &format!("{book}?author=nobody_at_all"), None, Some(&host)).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);

    // A hundred standing entries from one writer, written over earlier days, are as many as they may keep there.
    let (owner, writer) = (app.user_id("cap_host").await, app.user_id("cap_friend").await);
    sqlx::query(
        "INSERT INTO guestbook_entries (id, home_owner_id, author_id, body, created_at)
         SELECT gen_random_uuid(), $1, $2, 'earlier', now() - interval '2 days' FROM generate_series(1, 99)",
    )
    .bind(owner)
    .bind(writer)
    .execute(&app.state.db)
    .await
    .unwrap();
    assert_eq!(write(&friend).await.body["code"], "guestbook_author_full");
    app.cleanup().await;
}

#[tokio::test]
async fn requests_piling_up_from_others_do_not_stop_someone_asking_and_they_dismiss_them_at_once() {
    let app = TestApp::new(None).await;
    let target = app.register("inbox_full", "Target").await;
    let friend = app.register("inbox_friend", "Friend").await;
    let third = app.register("inbox_third", "Third").await;
    let id = app.user_id("inbox_full").await;
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash) SELECT gen_random_uuid(), 'piling_' || n, 'Piling', 'unused fixture' FROM generate_series(1, 100) AS n")
        .execute(&app.state.db).await.unwrap();
    sqlx::query("INSERT INTO ilchon_requests (id, from_id, to_id, name, their_name) SELECT gen_random_uuid(), id, $1, 'friend', 'friend' FROM users WHERE username LIKE 'piling_%'")
        .bind(id).execute(&app.state.db).await.unwrap();
    let body = json!({"name": "friend", "theirName": "friend"});
    let full = app.call("POST", "/api/ilchon/inbox_full/request", Some(body.clone()), Some(&friend)).await;
    assert_eq!((full.status, full.body["code"].as_str()), (StatusCode::CONFLICT, Some("their_requests_full")));
    // A full inbox does not stop its owner asking someone.
    let asked = app.call("POST", "/api/ilchon/inbox_friend/request", Some(body.clone()), Some(&target)).await;
    assert_eq!(asked.status, StatusCode::CREATED);
    // Every received request goes at once; the sent one stays.
    let dismissed = app.call("DELETE", "/api/ilchon-requests", None, Some(&target)).await;
    assert_eq!((dismissed.status, dismissed.body["dismissed"].as_u64()), (StatusCode::OK, Some(100)));
    let mine = app.call("GET", "/api/ilchon-requests", None, Some(&target)).await;
    assert_eq!(mine.body["received"].as_array().unwrap().len(), 0);
    assert_eq!(mine.body["sent"].as_array().unwrap().len(), 1);
    let again = app.call("POST", "/api/ilchon/inbox_full/request", Some(body), Some(&third)).await;
    assert_eq!(again.status, StatusCode::CREATED);
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
    // Another password grants nothing, and the server still starts: the account keeps its own password.
    auth::bootstrap_admin(&app.state, "claimed_admin", "another password").await.unwrap();
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

#[tokio::test]
async fn names_that_read_as_staff_are_kept_from_new_accounts() {
    let app = TestApp::new(None).await;
    for name in ["admin", "Administrator", "MOGAESUP", "root", "system", "support", "staff"] {
        let reply = app
            .call(
                "POST",
                "/api/auth/register",
                Some(json!({"username": name, "password": "correct horse battery"})),
                None,
            )
            .await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::CONFLICT, Some("username_taken")),
            "{name}"
        );
    }
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users").fetch_one(&app.state.db).await.unwrap(), 0);
    // The operator can still be given one of them, and names that only contain one are free.
    auth::bootstrap_admin(&app.state, "admin", "bootstrap password").await.unwrap();
    let signed_in = app.call("POST", "/api/auth/login", login("admin", "bootstrap password"), None).await;
    assert_eq!(signed_in.body["user"]["role"], "admin");
    app.register("admin_fan", "Member").await;
    app.cleanup().await;
}

#[tokio::test]
async fn text_is_refused_for_control_characters_and_line_breaks_go_only_into_text_areas() {
    let app = TestApp::new(None).await;
    let host = app.register("text_host", "Host").await;
    let guest = app.register("text_guest", "Guest").await;
    let book = "/api/homes/text_host/guestbook";
    let entry = |body: &str| Some(json!({"body": body}));
    assert_eq!(app.call("POST", book, entry("두 줄\n방명록"), Some(&guest)).await.status, StatusCode::CREATED);
    for body in ["벨\u{7}소리", "널\u{0}문자", "탈출\u{1b}[31m"] {
        let reply = app.call("POST", book, entry(body), Some(&guest)).await;
        assert_eq!(
            (reply.status, reply.body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_body")),
            "{body:?}"
        );
    }
    let ask = |name: &str, message: &str| Some(json!({"name": name, "theirName": "친구", "message": message}));
    for (body, code) in [(ask("탭\t이름", ""), "invalid_ilchon_name"), (ask("친구", "줄\n바꿈"), "invalid_message")]
    {
        let reply = app.call("POST", "/api/ilchon/text_host/request", body, Some(&guest)).await;
        assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some(code)));
    }
    // The status is a two-line text area; the title is one line.
    let status =
        app.call("PATCH", "/api/homes/me", Some(json!({"statusMessage": "오늘은\n느긋하게"})), Some(&host)).await;
    assert_eq!(status.body["profile"]["statusMessage"], "오늘은\n느긋하게");
    for changes in [json!({"statusMessage": "벨\u{7}"}), json!({"title": "두 줄\n제목"})] {
        let reply = app.call("PATCH", "/api/homes/me", Some(changes.clone()), Some(&host)).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{changes}");
    }
    // A NUL anywhere in an island save is refused as island data, not failed in the database.
    let world = json!({"worldId": "nul", "baseRevision": 0, "data": {"version": 1, "savedAt": 1,
        "domains": {"building": {"sign": "a\u{0}b"}}}});
    let reply = app.call("PUT", "/api/homes/me/world", Some(world), Some(&host)).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_world")));
    app.cleanup().await;
}

/// A save of an island envelope of about `bytes` bytes.
fn sized_world(world: &str, base: i64, bytes: usize) -> serde_json::Value {
    json!({"worldId": world, "baseRevision": base, "data": {"version": 1, "savedAt": 1,
        "domains": {"building": {"pad": "x".repeat(bytes)}}}})
}

#[tokio::test]
async fn a_members_islands_share_one_byte_budget_and_come_back_as_they_were_saved() {
    let app = TestApp::new(None).await;
    let owner = app.register("bytes_owner", "Owner").await;
    let kept = || async {
        sqlx::query_as::<_, (String, i64)>("SELECT world_id, byte_size::bigint FROM home_worlds ORDER BY updated_at")
            .fetch_all(&app.state.db)
            .await
            .unwrap()
    };
    let total = |worlds: &[(String, i64)]| worlds.iter().map(|(_, bytes)| bytes).sum::<i64>();
    let big = 1900 * 1024;
    for world in ["w1", "w2", "w3"] {
        let reply = app.call("PUT", "/api/homes/me/world", Some(sized_world(world, 0, big)), Some(&owner)).await;
        assert_eq!(reply.status, StatusCode::OK, "{world}: {:?}", reply.body);
    }
    assert_eq!(kept().await.len(), 3);
    let ids = |worlds: &[(String, i64)]| worlds.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    // A fourth would pass 6 MiB in all: the least recently updated other island makes room.
    let fourth = app.call("PUT", "/api/homes/me/world", Some(sized_world("w4", 0, big)), Some(&owner)).await;
    assert_eq!(fourth.status, StatusCode::OK);
    let worlds = kept().await;
    assert_eq!(ids(&worlds), ["w2", "w3", "w4"]);
    assert!(total(&worlds) <= 6 * 1024 * 1024);
    // A small fifth fits beside them; growing it later pushes out the oldest of the others, never the island saved.
    let fifth = app.call("PUT", "/api/homes/me/world", Some(sized_world("w5", 0, 10 * 1024)), Some(&owner)).await;
    assert_eq!(fifth.status, StatusCode::OK);
    assert_eq!(ids(&kept().await), ["w2", "w3", "w4", "w5"]);
    let grown = app.call("PUT", "/api/homes/me/world", Some(sized_world("w5", 1, big)), Some(&owner)).await;
    assert_eq!((grown.status, grown.body["revision"].as_i64()), (StatusCode::OK, Some(2)));
    let worlds = kept().await;
    assert_eq!(ids(&worlds), ["w3", "w4", "w5"]);
    assert!(total(&worlds) <= 6 * 1024 * 1024, "{worlds:?}");

    // The stored envelope is read back with the shape the app expects. A save answers without it: the page has what it
    // sent, and an autosave does not carry the island back.
    let small = json!({"worldId": "plain", "baseRevision": 0, "data": {"version": 2, "savedAt": 1.5,
        "domains": {"building": {"tiles": [1, 2.25, -3], "name": "꽃 \"섬\"\n", "deep": {"ok": true, "none": null}}}}});
    let saved = app.call("PUT", "/api/homes/me/world", Some(small.clone()), Some(&owner)).await;
    assert_eq!(saved.headers[header::CONTENT_TYPE], "application/json");
    let mut answered: Vec<&String> = saved.body.as_object().unwrap().keys().collect();
    answered.sort();
    assert_eq!(answered, ["revision", "updatedAt", "worldId"]);
    assert_eq!((saved.body["worldId"].as_str(), saved.body["revision"].as_i64()), (Some("plain"), Some(1)));
    let read = app.call("GET", "/api/homes/bytes_owner/world?worldId=plain", None, None).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!((read.body["worldId"].as_str(), read.body["revision"].as_i64()), (Some("plain"), Some(1)));
    assert_eq!(read.body["data"], small["data"]);
    assert_eq!(read.body["updatedAt"], saved.body["updatedAt"]);
    assert!(read.body["updatedAt"].as_str().is_some_and(|at| at.ends_with('Z')), "{}", read.body["updatedAt"]);
    // A body that is not a save at all is refused as island data the server cannot take.
    let request = Request::builder()
        .method("PUT")
        .uri("/api/homes/me/world")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &owner)
        .body(Body::from("{\"worldId\": \"x\", \"data\": "))
        .unwrap();
    assert_eq!(app.send(request).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    app.cleanup().await;
}

#[tokio::test]
async fn requests_the_server_cannot_read_are_refused_in_the_json_the_app_shows() {
    let app = TestApp::new(None).await;
    let login = |body: String| {
        Request::builder()
            .method("POST")
            .uri("/api/auth/login")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let unreadable = ("invalid_request", "요청 형식이 올바르지 않습니다.");
    // Not JSON, JSON of another shape, and more than the sign-in's 4 KB: each keeps its status.
    for (body, status, (code, message)) in [
        ("{\"username\": ".to_owned(), StatusCode::BAD_REQUEST, unreadable),
        (json!({"username": 1, "password": "x"}).to_string(), StatusCode::UNPROCESSABLE_ENTITY, unreadable),
        (
            json!({"username": "a".repeat(5000), "password": "x"}).to_string(),
            StatusCode::PAYLOAD_TOO_LARGE,
            ("too_large", "요청이 너무 큽니다."),
        ),
    ] {
        let reply = app.send(login(body)).await;
        assert_eq!(reply.status, status, "{}", String::from_utf8_lossy(&reply.bytes));
        assert_eq!(reply.headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(reply.body, json!({"code": code, "message": message}));
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
    }
    // A query its handler cannot read.
    let reply = app.call("GET", "/api/homes?limit=many", None, None).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_request")));
    app.cleanup().await;
}

#[tokio::test]
async fn an_island_save_cut_short_is_not_taken_for_a_large_one() {
    use axum::body::Bytes;
    let app = TestApp::new(None).await;
    let owner = app.register("cut_owner", "Owner").await;
    let owner_id = app.user_id("cut_owner").await;
    let put = |chunks: Vec<Result<Bytes, std::io::Error>>| {
        Request::builder()
            .method("PUT")
            .uri("/api/homes/me/world")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &owner)
            .body(Body::from_stream(futures_util::stream::iter(chunks)))
            .unwrap()
    };
    let save = json!({"expectedOwnerId": owner_id, "worldId": "cut", "baseRevision": 0,
        "data": {"version": 1, "savedAt": 1, "domains": {}}})
    .to_string();
    // The connection dropped halfway: nothing is stored, and the island is not called too large.
    let half = Bytes::from(save.as_bytes()[..save.len() / 2].to_vec());
    let reply = app.send(put(vec![Ok(half), Err(std::io::Error::other("connection reset"))])).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("incomplete_world")));
    // Past the limit a piece at a time is too large, as one piece is.
    let piece = Bytes::from(vec![b' '; 1024 * 1024]);
    let reply = app.send(put(vec![Ok(piece.clone()), Ok(piece.clone()), Ok(piece)])).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::PAYLOAD_TOO_LARGE, Some("world_too_large")));
    // Whole, in pieces, it is stored.
    let (head, tail) = save.as_bytes().split_at(save.len() / 2);
    let reply = app.send(put(vec![Ok(Bytes::from(head.to_vec())), Ok(Bytes::from(tail.to_vec()))])).await;
    assert_eq!((reply.status, reply.body["revision"].as_i64()), (StatusCode::OK, Some(1)), "{:?}", reply.body);
    app.cleanup().await;
}

#[tokio::test]
async fn database_refusals_are_the_requests_problem_and_outages_the_servers() {
    use mogaesup_server::error::ApiError;
    let app = TestApp::new(None).await;
    let insert = |username: &'static str, role: &'static str| {
        sqlx::query("INSERT INTO users (id, username, display_name, password_hash, role) VALUES ($1, $2, 'x', 'x', $3)")
            .bind(uuid::Uuid::new_v4())
            .bind(username)
            .bind(role)
            .execute(&app.state.db)
    };
    insert("twice", "user").await.unwrap();
    let unique = ApiError::from(insert("twice", "user").await.unwrap_err());
    assert_eq!((unique.status, unique.code), (StatusCode::CONFLICT, "conflict"));
    let checked = ApiError::from(insert("checked", "owner").await.unwrap_err());
    assert_eq!((checked.status, checked.code), (StatusCode::UNPROCESSABLE_ENTITY, "invalid_value"));
    let value = ApiError::from(sqlx::query("SELECT 'not a number'::int").execute(&app.state.db).await.unwrap_err());
    assert_eq!((value.status, value.code), (StatusCode::UNPROCESSABLE_ENTITY, "invalid_value"));
    app.state.db.close().await;
    let down = ApiError::from(sqlx::query("SELECT 1").execute(&app.state.db).await.unwrap_err());
    assert_eq!((down.status, down.code), (StatusCode::SERVICE_UNAVAILABLE, "database"));
    app.cleanup().await;
}

#[tokio::test]
async fn visitors_do_not_learn_which_studio_job_an_item_was_copied_from() {
    let app = TestApp::new(None).await;
    let admin = app.register("source_admin", "Admin").await;
    app.make_admin("source_admin").await;
    let member = app.register("source_member", "Member").await;
    sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, source, source_ref, status)
         VALUES ('copied', 'minime', '복사본', '🙂', '/models/copied.glb', 'factory', 'job_9/v2/smile', 'published')",
    )
    .execute(&app.state.db)
    .await
    .unwrap();
    let find = |items: &serde_json::Value| {
        items["items"].as_array().unwrap().iter().find(|item| item["id"] == "copied").unwrap().clone()
    };
    for cookie in [None, Some(member.as_str()), Some(admin.as_str())] {
        let item = find(&app.call("GET", "/api/catalog/items?kind=minime", None, cookie).await.body);
        assert_eq!(
            (item["sourceRef"].clone(), item["modelUrl"].as_str()),
            (serde_json::Value::Null, Some("/models/copied.glb"))
        );
    }
    let item = find(&app.call("GET", "/api/catalog/admin/items", None, Some(&admin)).await.body);
    assert_eq!(item["sourceRef"], "job_9/v2/smile");
    app.cleanup().await;
}

#[tokio::test]
async fn reading_where_two_people_stand_takes_no_row_locks() {
    let app = TestApp::new(None).await;
    let alice = app.register("lock_alice", "Alice").await;
    app.register("lock_bob", "Bob").await;
    let body = json!({"name": "friend", "theirName": "friend"});
    let asked = app.call("POST", "/api/ilchon/lock_bob/request", Some(body), Some(&alice)).await;
    assert_eq!(asked.status, StatusCode::CREATED);
    // Another transaction holds both accounts' rows, as a sign-in or a foreign key check can.
    let mut held = app.state.db.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE username IN ('lock_alice', 'lock_bob') FOR UPDATE")
        .execute(&mut *held)
        .await
        .unwrap();
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        app.call("GET", "/api/ilchon/lock_bob", None, Some(&alice)),
    )
    .await
    .expect("the status read must not wait for the rows");
    assert_eq!(status.body["relation"], "requested");
    held.rollback().await.unwrap();
    app.cleanup().await;
}
