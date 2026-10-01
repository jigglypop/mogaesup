//! Relationship-based access (src/rebac.rs): the model's rewrites and usersets, the recursion bound, the last-admin
//! guard and the audit log, the migration of existing admins, and who may call each route that checks a permission.

mod common;

use axum::{Json, Router, http::StatusCode};
use common::{TestApp, TestDb};
use mogaesup_server::{
    MIGRATOR, auth,
    config::{Factory, FactoryAccess},
    rebac::{self, Actor, Checker, Object, PERMISSIONS, RevokeError, Subject, SubjectRef, Tuple},
};
use serde_json::{Value, json};
use uuid::Uuid;

const SYSTEM: &str = "system:mogaesup";
const CATALOG: &str = "catalog:mogaesup";

/// Stores `object#relation@subject` as the server itself.
async fn tuple(app: &TestApp, object: Object, relation: &str, subject: SubjectRef) {
    let tuple = Tuple::new(object, relation, subject).unwrap();
    rebac::grant(&app.state.db, &tuple, Actor::server("test"), "test").await.unwrap();
}

/// The names of the app's permissions `username` holds.
async fn held(app: &TestApp, username: &str) -> Vec<&'static str> {
    let id = app.user_id(username).await;
    let mut checker = Checker::new(&app.state.db);
    let mut names = Vec::new();
    for permission in PERMISSIONS {
        if checker.allows(Subject::User(id), &permission).await.unwrap() {
            names.push(permission.name);
        }
    }
    names
}

async fn is(app: &TestApp, username: &str, object: &Object, relation: &str) -> bool {
    let id = app.user_id(username).await;
    Checker::new(&app.state.db).check(Subject::User(id), object, relation).await.unwrap()
}

/// Whether some node of an explanation or expansion has `key` equal to `value`.
fn has(tree: &Value, key: &str, value: &str) -> bool {
    tree[key] == value
        || tree["children"].as_array().is_some_and(|children| children.iter().any(|c| has(c, key, value)))
}

fn change(object: &str, relation: &str, subject: &str, reason: &str) -> Option<Value> {
    Some(json!({"object": object, "relation": relation, "subject": subject, "reason": reason}))
}

#[tokio::test]
async fn 상위_역할은_하위_권한을_포함하고_로그인_정보에_실린다() {
    let app = TestApp::new(None).await;
    let mut cookies = Vec::new();
    for name in ["boss_r", "paid_r", "op_r", "mod_r", "cat_r", "member_r"] {
        cookies.push(app.register(name, name).await);
    }
    app.make_admin("boss_r").await;
    app.grant("paid_r", SYSTEM, "paid_operator").await;
    app.grant("op_r", SYSTEM, "operator").await;
    app.grant("mod_r", SYSTEM, "moderator").await;
    app.grant("cat_r", CATALOG, "editor").await;

    let all = ["admin", "paid_operator", "operator", "moderator", "catalog_editor", "studio_viewer"];
    assert_eq!(held(&app, "boss_r").await, all);
    assert_eq!(held(&app, "paid_r").await, ["paid_operator", "operator", "studio_viewer"]);
    assert_eq!(held(&app, "op_r").await, ["operator", "studio_viewer"]);
    assert_eq!(held(&app, "mod_r").await, ["moderator", "catalog_editor", "studio_viewer"]);
    assert_eq!(held(&app, "cat_r").await, ["catalog_editor", "studio_viewer"]);
    assert!(held(&app, "member_r").await.is_empty());

    let me = app.call("GET", "/api/auth/me", None, Some(&cookies[0])).await;
    assert_eq!((me.body["user"]["role"].as_str(), me.body["user"]["permissions"].clone()), (Some("admin"), json!(all)));
    let me = app.call("GET", "/api/auth/me", None, Some(&cookies[2])).await;
    assert_eq!(me.body["user"]["role"], "user");
    assert_eq!(me.body["user"]["permissions"], json!(["operator", "studio_viewer"]));
    let login = app
        .call("POST", "/api/auth/login", Some(json!({"username": "cat_r", "password": "correct horse battery"})), None)
        .await;
    assert_eq!(login.body["user"]["permissions"], json!(["catalog_editor", "studio_viewer"]));
    app.cleanup().await;
}

#[tokio::test]
async fn 그룹_구성원은_중첩되고_순환해도_권한을_받는다() {
    let app = TestApp::new(None).await;
    app.register("alice_g", "앨리스").await;
    app.register("bob_g", "밥").await;
    let alice = app.user_id("alice_g").await;
    tuple(&app, Object::group("crew"), "member", SubjectRef::user(alice)).await;
    tuple(&app, Object::group("staff"), "member", SubjectRef::members("crew")).await;
    tuple(&app, Object::system(), "operator", SubjectRef::members("staff")).await;
    assert!(is(&app, "alice_g", &Object::system(), "operator").await);
    assert!(is(&app, "alice_g", &Object::system(), "studio_viewer").await);
    assert!(!is(&app, "alice_g", &Object::system(), "paid_operator").await);
    assert!(!is(&app, "bob_g", &Object::system(), "operator").await);

    // staff ⊇ crew and crew ⊇ staff: the cycle ends the branch instead of the check.
    tuple(&app, Object::group("crew"), "member", SubjectRef::members("staff")).await;
    assert!(is(&app, "alice_g", &Object::system(), "operator").await);
    assert!(!is(&app, "bob_g", &Object::system(), "operator").await);

    let trace = serde_json::to_value(
        Checker::new(&app.state.db).explain(Subject::User(alice), &Object::system(), "operator").await.unwrap(),
    )
    .unwrap();
    assert_eq!(trace["allowed"], true);
    assert!(has(&trace, "subject", "group:staff#member") && has(&trace, "subject", "group:crew#member"), "{trace}");
    assert!(has(&trace, "subject", &format!("user:{alice}")));
    let bob = app.user_id("bob_g").await;
    let denied = serde_json::to_value(
        Checker::new(&app.state.db).explain(Subject::User(bob), &Object::system(), "operator").await.unwrap(),
    )
    .unwrap();
    assert_eq!(denied["allowed"], false);
    assert!(has(&denied, "limit", "cycle"), "{denied}");

    let removed = rebac::revoke(
        &app.state.db,
        &Tuple::new(Object::group("crew"), "member", SubjectRef::user(alice)).unwrap(),
        Actor::server("test"),
        "test",
    )
    .await
    .unwrap();
    assert!(removed);
    assert!(!is(&app, "alice_g", &Object::system(), "operator").await);
    app.cleanup().await;
}

#[tokio::test]
async fn 너무_깊은_그룹_사슬은_거절하고_이유를_보인다() {
    let app = TestApp::new(None).await;
    app.register("deep_d", "깊이").await;
    let user = app.user_id("deep_d").await;
    // Three groups deep is fine.
    tuple(&app, Object::group("near0"), "member", SubjectRef::user(user)).await;
    for step in 1..3 {
        tuple(&app, Object::group(&format!("near{step}")), "member", SubjectRef::members(&format!("near{}", step - 1)))
            .await;
    }
    tuple(&app, Object::system(), "moderator", SubjectRef::members("near2")).await;
    assert!(is(&app, "deep_d", &Object::system(), "moderator").await);
    assert!(is(&app, "deep_d", &Object::catalog(), "editor").await);

    // Twenty is past the depth limit: denied, and the explanation says where it stopped.
    tuple(&app, Object::group("far0"), "member", SubjectRef::user(user)).await;
    for step in 1..20 {
        tuple(&app, Object::group(&format!("far{step}")), "member", SubjectRef::members(&format!("far{}", step - 1)))
            .await;
    }
    tuple(&app, Object::system(), "paid_operator", SubjectRef::members("far19")).await;
    assert!(!is(&app, "deep_d", &Object::system(), "paid_operator").await);
    let trace = serde_json::to_value(
        Checker::new(&app.state.db).explain(Subject::User(user), &Object::system(), "paid_operator").await.unwrap(),
    )
    .unwrap();
    assert_eq!(trace["allowed"], false);
    assert!(has(&trace, "limit", "depth"), "{trace}");
    app.cleanup().await;
}

#[tokio::test]
async fn 섬_보기는_주인과_공개_범위와_명시적_부여를_따른다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_v", "주인").await;
    let guest = app.register("guest_v", "손님").await;
    let pal = app.register("pal_v", "그룹 친구").await;
    let boss = app.register("boss_v", "관리자").await;
    app.make_admin("boss_v").await;
    let home = "/api/homes/host_v";
    assert_eq!(app.call("GET", home, None, None).await.status, StatusCode::OK);
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "private"})), Some(&host)).await;
    assert_eq!(app.call("GET", home, None, Some(&host)).await.status, StatusCode::OK);
    for cookie in [None, Some(&guest), Some(&pal), Some(&boss)] {
        assert_eq!(app.call("GET", home, None, cookie.map(String::as_str)).await.status, StatusCode::FORBIDDEN);
    }

    let granted = app
        .call(
            "POST",
            "/api/admin/permissions/grant",
            change("home:host_v", "viewer", "user:guest_v", "초대"),
            Some(&boss),
        )
        .await;
    assert_eq!(granted.status, StatusCode::CREATED, "{:?}", granted.body);
    assert_eq!(app.call("GET", home, None, Some(&guest)).await.status, StatusCode::OK);
    app.call("POST", "/api/admin/permissions/grant", change("group:pals", "member", "user:pal_v", "모임"), Some(&boss))
        .await;
    app.call(
        "POST",
        "/api/admin/permissions/grant",
        change("home:host_v", "viewer", "group:pals", "모임 초대"),
        Some(&boss),
    )
    .await;
    assert_eq!(app.call("GET", home, None, Some(&pal)).await.status, StatusCode::OK);
    assert_eq!(app.call("GET", "/api/homes/host_v/guestbook", None, Some(&pal)).await.status, StatusCode::OK);
    assert_eq!(app.call("GET", home, None, None).await.status, StatusCode::FORBIDDEN);

    let explained = app
        .call(
            "GET",
            "/api/admin/permissions/check?subject=user:host_v&object=home:host_v&relation=viewer",
            None,
            Some(&boss),
        )
        .await;
    assert_eq!(explained.body["allowed"], true);
    assert!(has(&explained.body["trace"], "fact", "home_owner"), "{}", explained.body);
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "public"})), Some(&host)).await;
    let anonymous = app
        .call(
            "GET",
            "/api/admin/permissions/check?subject=anonymous&object=home:host_v&relation=viewer",
            None,
            Some(&boss),
        )
        .await;
    assert_eq!(anonymous.body["allowed"], true);
    assert!(has(&anonymous.body["trace"], "fact", "public_home"));
    app.cleanup().await;
}

#[tokio::test]
async fn 마지막_관리자는_남고_모든_변경은_사유와_함께_기록된다() {
    let app = TestApp::new(None).await;
    let boss = app.register("boss_a", "대장").await;
    let second = app.register("second_a", "둘째").await;
    let member = app.register("member_a", "회원").await;
    app.make_admin("boss_a").await;
    let grant = "/api/admin/permissions/grant";
    let revoke = "/api/admin/permissions/revoke";

    let refused = app.call("POST", grant, change(SYSTEM, "admin", "user:member_a", "셀프"), Some(&member)).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));
    let blank = app.call("POST", grant, change(SYSTEM, "admin", "user:second_a", "  "), Some(&boss)).await;
    assert_eq!(blank.body["code"], "invalid_reason");
    let group_admin = app.call("POST", grant, change(SYSTEM, "admin", "group:crew", "묶음"), Some(&boss)).await;
    assert_eq!(group_admin.body["code"], "subject_not_allowed");
    let computed = app.call("POST", grant, change(SYSTEM, "studio_viewer", "user:second_a", "x"), Some(&boss)).await;
    assert_eq!(computed.body["code"], "invalid_relation");
    let nobody = app.call("POST", grant, change(SYSTEM, "operator", "user:nobody_a", "x"), Some(&boss)).await;
    assert_eq!(nobody.status, StatusCode::NOT_FOUND);

    let promoted = app.call("POST", grant, change(SYSTEM, "admin", "user:second_a", "공동 운영"), Some(&boss)).await;
    assert_eq!((promoted.status, promoted.body["changed"].as_bool()), (StatusCode::CREATED, Some(true)));
    let again = app.call("POST", grant, change(SYSTEM, "admin", "user:second_a", "공동 운영"), Some(&boss)).await;
    assert_eq!((again.status, again.body["changed"].as_bool()), (StatusCode::OK, Some(false)));
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&second)).await.body["user"]["role"], "admin");

    let demoted = app.call("POST", revoke, change(SYSTEM, "admin", "user:second_a", "임기 끝"), Some(&boss)).await;
    assert_eq!(demoted.body["changed"], true);
    assert_eq!(app.call("GET", "/api/auth/me", None, Some(&second)).await.body["user"]["role"], "user");
    let last = app.call("POST", revoke, change(SYSTEM, "admin", "user:boss_a", "그만"), Some(&boss)).await;
    assert_eq!((last.status, last.body["code"].as_str()), (StatusCode::CONFLICT, Some("last_admin")));
    let absent = app.call("POST", revoke, change(SYSTEM, "operator", "user:member_a", "없음"), Some(&boss)).await;
    assert_eq!(absent.body["changed"], false);

    // Newest first, paged, with who, why and what; the rejected and repeated requests left nothing.
    let page = app.call("GET", "/api/admin/permissions/audit?limit=2", None, Some(&boss)).await;
    let entries = page.body["entries"].as_array().unwrap().clone();
    let second_id = app.user_id("second_a").await;
    assert_eq!(
        entries.iter().map(|e| (e["action"].as_str().unwrap(), e["reason"].as_str().unwrap())).collect::<Vec<_>>(),
        [("revoke", "임기 끝"), ("grant", "공동 운영")]
    );
    assert_eq!(entries[0]["actor"], "boss_a");
    assert_eq!(entries[0]["subject"], format!("user:{second_id}"));
    assert_eq!(page.body["users"][second_id.to_string()]["username"], "second_a");
    let before = page.body["nextBefore"].as_i64().unwrap();
    let rest =
        app.call("GET", &format!("/api/admin/permissions/audit?limit=2&before={before}"), None, Some(&boss)).await;
    let rest = rest.body["entries"].as_array().unwrap().clone();
    assert_eq!(rest.len(), 1);
    assert_eq!((rest[0]["actor"].as_str(), rest[0]["action"].as_str()), (Some("test"), Some("grant")));
    let mine = app.call("GET", "/api/admin/permissions/audit?subject=user:second_a", None, Some(&boss)).await;
    assert_eq!(mine.body["entries"].as_array().unwrap().len(), 2);

    // The log only grows.
    assert!(sqlx::query("DELETE FROM auth_audit").execute(&app.state.db).await.is_err());
    assert!(sqlx::query("UPDATE auth_audit SET reason = 'x'").execute(&app.state.db).await.is_err());

    // Two admins removing each other at once: one of them stays.
    app.make_admin("second_a").await;
    let (boss_id, db) = (app.user_id("boss_a").await, app.state.db.clone());
    let revoking = |id: Uuid| {
        let db = db.clone();
        tokio::spawn(async move { rebac::revoke(&db, &Tuple::admin(id), Actor::server("test"), "경합").await })
    };
    let results = [revoking(boss_id), revoking(second_id)];
    let mut outcomes = Vec::new();
    for result in results {
        outcomes.push(result.await.unwrap());
    }
    assert_eq!(outcomes.iter().filter(|o| matches!(o, Ok(true))).count(), 1, "{outcomes:?}");
    assert_eq!(outcomes.iter().filter(|o| matches!(o, Err(RevokeError::LastAdmin))).count(), 1, "{outcomes:?}");
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_tuples WHERE relation = 'admin'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(admins, 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 기존_관리자와_ydh2244는_마이그레이션으로_관리자가_된다() {
    use sqlx::migrate::Migrate;
    let test_db = TestDb::create().await;
    let db = &test_db.pool;
    // Found by name, so the check survives a renumbering of the file.
    let permissions = MIGRATOR.iter().find(|m| m.description == "permissions").unwrap();
    let mut conn = db.acquire().await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in MIGRATOR.iter().filter(|m| m.version < permissions.version) {
        conn.apply(migration).await.unwrap();
    }
    let mut ids = Vec::new();
    for (name, role) in [("old_admin", "admin"), ("ydh2244", "user"), ("plain_m", "user")] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, display_name, password_hash, role) VALUES ($1, $2, $2, 'x', $3)")
            .bind(id)
            .bind(name)
            .bind(role)
            .execute(&mut *conn)
            .await
            .unwrap();
        ids.push(id);
    }
    drop(conn);
    MIGRATOR.run(db).await.unwrap();

    let admins = || async {
        sqlx::query_scalar::<_, String>(
            "SELECT u.username FROM auth_tuples t JOIN users u ON u.id::text = t.subject_id
             WHERE t.object_type = 'system' AND t.object_id = 'mogaesup' AND t.relation = 'admin' ORDER BY 1",
        )
        .fetch_all(db)
        .await
        .unwrap()
    };
    let audited = || async {
        sqlx::query_as::<_, (String, String, String)>("SELECT action, actor, subject_id FROM auth_audit ORDER BY id")
            .fetch_all(db)
            .await
            .unwrap()
    };
    assert_eq!(admins().await, ["old_admin", "ydh2244"]);
    let expected = vec![
        ("grant".to_owned(), "migration".to_owned(), ids[0].to_string()),
        ("grant".to_owned(), "migration".to_owned(), ids[1].to_string()),
    ];
    assert_eq!(audited().await, expected);
    let mut checker = Checker::new(db);
    assert!(checker.check(Subject::User(ids[1]), &Object::system(), "paid_operator").await.unwrap());
    assert!(!checker.check(Subject::User(ids[2]), &Object::system(), "operator").await.unwrap());

    // Running it again changes nothing.
    sqlx::raw_sql(&permissions.sql).execute(db).await.unwrap();
    assert_eq!(admins().await, ["old_admin", "ydh2244"]);
    assert_eq!(audited().await, expected);

    // Releases before this one read users.role, which follows the tuples both ways.
    let role = |id: Uuid| async move {
        sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id = $1").bind(id).fetch_one(db).await.unwrap()
    };
    assert_eq!(role(ids[1]).await, "admin");
    assert!(rebac::revoke(db, &Tuple::admin(ids[0]), Actor::server("test"), "test").await.unwrap());
    assert_eq!(role(ids[0]).await, "user");
    test_db.remove().await;
}

#[tokio::test]
async fn 부트스트랩_관리자는_튜플로_관리자가_되고_기존_비밀번호를_지킨다() {
    let app = TestApp::new(None).await;
    auth::bootstrap_admin(&app.state, "Boot_Admin", "bootstrap password").await.unwrap();
    auth::bootstrap_admin(&app.state, "boot_admin", "bootstrap password").await.unwrap();
    let login = app
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "boot_admin", "password": "bootstrap password"})),
            None,
        )
        .await;
    assert_eq!(login.body["user"]["role"], "admin");

    app.register("existing_b", "원래 회원").await;
    auth::bootstrap_admin(&app.state, "existing_b", "some other password").await.unwrap();
    let login = app
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({"username": "existing_b", "password": "correct horse battery"})),
            None,
        )
        .await;
    assert_eq!(login.body["user"]["role"], "admin");
    let bootstrapped: Vec<(String, String)> =
        sqlx::query_as("SELECT actor, reason FROM auth_audit ORDER BY id").fetch_all(&app.state.db).await.unwrap();
    assert_eq!(bootstrapped.len(), 2, "a repeated bootstrap records nothing");
    assert!(bootstrapped.iter().all(|(actor, _)| actor == "bootstrap"));
    app.cleanup().await;
}

/// A character server that answers every request with `{"ok": true}`.
async fn fake_factory() -> String {
    let app = Router::new().fallback(|| async { Json(json!({"ok": true})) });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

async fn studio_app(access: FactoryAccess) -> TestApp {
    let url = fake_factory().await;
    TestApp::new(Some(Factory {
        url,
        api_key: None,
        token: None,
        access,
        paid_monthly: 10,
        gateway_key: None,
        instance: None,
    }))
    .await
}

#[tokio::test]
async fn 라우트마다_필요한_권한만_통과한다() {
    let app = studio_app(FactoryAccess::Paid).await;
    let mut who = std::collections::HashMap::new();
    for name in ["member_x", "op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"] {
        who.insert(name, app.register(name, name).await);
    }
    app.grant("op_x", SYSTEM, "operator").await;
    app.grant("paid_x", SYSTEM, "paid_operator").await;
    app.grant("mod_x", SYSTEM, "moderator").await;
    app.grant("cat_x", CATALOG, "editor").await;
    app.grant("crew_x", "group:crew", "member").await;
    tuple(&app, Object::system(), "operator", SubjectRef::members("crew")).await;
    app.make_admin("boss_x").await;

    let routes: [(&str, &str, Option<Value>, &[&str]); 12] = [
        ("GET", "/api/catalog/admin/items", None, &["mod_x", "cat_x", "boss_x"]),
        ("PATCH", "/api/catalog/admin/items/man", Some(json!({"sortOrder": 7})), &["mod_x", "cat_x", "boss_x"]),
        ("GET", "/api/catalog/admin/imports", None, &["mod_x", "cat_x", "boss_x"]),
        ("GET", "/api/catalog/admin/factory-usage", None, &["op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"]),
        ("GET", "/api/catalog/admin/studio-power", None, &["op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"]),
        (
            "GET",
            "/api/avatar-factory/wardrobe/bodies",
            None,
            &["member_x", "op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"],
        ),
        ("GET", "/api/studio/catalog", None, &["op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"]),
        ("PUT", "/api/avatar-factory/wardrobe/outfits/mine", Some(json!({})), &["op_x", "paid_x", "crew_x", "boss_x"]),
        ("POST", "/api/studio/generations", Some(json!({"kind": "prop"})), &["paid_x", "boss_x"]),
        (
            "GET",
            "/api/factory/avatar-factory/capabilities",
            None,
            &["op_x", "paid_x", "mod_x", "cat_x", "crew_x", "boss_x"],
        ),
        ("POST", "/api/factory/avatar-factory/anything", Some(json!({})), &["boss_x"]),
        ("GET", "/api/admin/permissions/users?granted=true", None, &["boss_x"]),
    ];
    for (method, path, body, allowed) in routes {
        assert_eq!(app.call(method, path, body.clone(), None).await.status, StatusCode::UNAUTHORIZED, "{path}");
        for (name, cookie) in &who {
            let reply = app.call(method, path, body.clone(), Some(cookie)).await;
            if allowed.contains(name) {
                assert!(reply.status.is_success(), "{name} {method} {path}: {} {:?}", reply.status, reply.body);
            } else {
                assert_eq!(reply.status, StatusCode::FORBIDDEN, "{name} {method} {path}: {:?}", reply.body);
            }
        }
    }
    let codes = [
        ("member_x", "GET", "/api/studio/catalog", "studio_viewer_only"),
        ("cat_x", "PUT", "/api/avatar-factory/wardrobe/outfits/mine", "operator_only"),
        ("op_x", "POST", "/api/studio/generations", "paid_operator_only"),
        ("op_x", "GET", "/api/catalog/admin/items", "catalog_editor_only"),
    ];
    for (name, method, path, code) in codes {
        assert_eq!(app.call(method, path, Some(json!({})), Some(&who[name])).await.body["code"], code, "{name} {path}");
    }
    // Studio changes are recorded under whoever made them.
    let recorded: Vec<(String, bool)> = sqlx::query_as(
        "SELECT u.username, r.paid FROM factory_requests r JOIN users u ON u.id = r.user_id ORDER BY r.id",
    )
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    assert!(recorded.contains(&("crew_x".to_owned(), false)) && recorded.contains(&("paid_x".to_owned(), true)));
    // The admins' proxy is recorded too: its POST started paid work (it is not one of the free ones).
    assert!(recorded.contains(&("boss_x".to_owned(), true)));
    app.cleanup().await;

    // FACTORY_ACCESS stays the upper bound, whoever asks.
    let app = studio_app(FactoryAccess::Read).await;
    let boss = app.register("boss_y", "관리자").await;
    app.make_admin("boss_y").await;
    let outfit = app.call("PUT", "/api/avatar-factory/wardrobe/outfits/mine", Some(json!({})), Some(&boss)).await;
    assert_eq!(outfit.body["code"], "factory_read_only");
    let paid = app.call("POST", "/api/studio/generations", Some(json!({})), Some(&boss)).await;
    assert_eq!(paid.body["code"], "factory_paid_off");
    // The admins' proxy answers to the same ceiling.
    let proxied =
        app.call("PUT", "/api/factory/avatar-factory/wardrobe/outfits/mine", Some(json!({})), Some(&boss)).await;
    assert_eq!(proxied.body["code"], "factory_read_only");
    let proxied_paid = app.call("POST", "/api/factory/studio/generations", Some(json!({})), Some(&boss)).await;
    assert_eq!(proxied_paid.body["code"], "factory_paid_off");
    app.cleanup().await;
}

#[tokio::test]
async fn 모더레이터는_남의_방명록_글을_지울_수_있다() {
    let app = TestApp::new(None).await;
    let host = app.register("host_m", "주인").await;
    let writer = app.register("writer_m", "글쓴이").await;
    let stranger = app.register("stranger_m", "낯선이").await;
    let moderator = app.register("mod_m", "모더레이터").await;
    app.grant("mod_m", SYSTEM, "moderator").await;
    let path = "/api/homes/host_m/guestbook";
    app.call("POST", path, Some(json!({"body": "광고 글"})), Some(&writer)).await;
    app.call("POST", path, Some(json!({"body": "비밀", "secret": true})), Some(&writer)).await;
    let entries = |cookie: String| {
        let app = &app;
        async move { app.call("GET", path, None, Some(&cookie)).await.body["entries"].as_array().unwrap().clone() }
    };
    let seen = entries(moderator.clone()).await;
    assert!(seen.iter().all(|entry| entry["canDelete"] == true));
    assert_eq!(seen.iter().find(|entry| entry["secret"] == true).unwrap()["body"], "");
    assert!(entries(stranger.clone()).await.iter().all(|entry| entry["canDelete"] == false));
    assert!(entries(host.clone()).await.iter().all(|entry| entry["canDelete"] == true));

    let id = seen[0]["id"].as_str().unwrap();
    let delete = format!("/api/guestbook/{id}");
    assert_eq!(app.call("DELETE", &delete, None, Some(&stranger)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.call("DELETE", &delete, None, Some(&moderator)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(entries(host).await.len(), 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 관리_화면은_사람과_그룹과_보유자와_판단_근거를_보여준다() {
    let app = TestApp::new(None).await;
    let boss = app.register("boss_s", "대장").await;
    app.make_admin("boss_s").await;
    app.register("op_s", "운영").await;
    app.register("alice_s", "앨리스").await;
    app.register("plain_s", "회원").await;
    let grant = |object: &'static str, relation: &'static str, subject: &'static str| {
        let (app, boss) = (&app, boss.clone());
        async move {
            let reply = app
                .call("POST", "/api/admin/permissions/grant", change(object, relation, subject, "설정"), Some(&boss))
                .await;
            assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
        }
    };
    grant(SYSTEM, "operator", "user:op_s").await;
    grant("group:crew", "member", "user:alice_s").await;
    grant(SYSTEM, "moderator", "group:crew#member").await;

    let found = app.call("GET", "/api/admin/permissions/users?q=op", None, Some(&boss)).await;
    assert_eq!(found.body["matches"][0]["username"], "op_s");
    assert_eq!(found.body["matches"][0]["grants"], json!([{"object": SYSTEM, "relation": "operator"}]));
    let granted = app.call("GET", "/api/admin/permissions/users?granted=true", None, Some(&boss)).await;
    let names: Vec<&str> =
        granted.body["matches"].as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["alice_s", "boss_s", "op_s"]);
    let escaped = app.call("GET", "/api/admin/permissions/users?q=%25", None, Some(&boss)).await;
    assert_eq!(escaped.body["matches"], json!([]));

    let alice = app.call("GET", "/api/admin/permissions/users/alice_s", None, Some(&boss)).await;
    assert_eq!(alice.body["grants"][0]["object"], "group:crew");
    assert_eq!(alice.body["permissions"]["moderator"], true);
    assert_eq!(alice.body["permissions"]["catalog_editor"], true);
    assert_eq!(alice.body["permissions"]["operator"], false);

    let groups = app.call("GET", "/api/admin/permissions/groups", None, Some(&boss)).await;
    assert_eq!(groups.body["groups"][0]["id"], "crew");
    assert_eq!(groups.body["groups"][0]["grants"][0]["relation"], "moderator");
    let alice_id = app.user_id("alice_s").await;
    assert_eq!(groups.body["groups"][0]["members"][0]["subject"], format!("user:{alice_id}"));
    assert_eq!(groups.body["users"][alice_id.to_string()]["username"], "alice_s");

    let expanded = app
        .call("GET", "/api/admin/permissions/expand?object=catalog:mogaesup&relation=editor", None, Some(&boss))
        .await;
    let holders: Vec<String> =
        expanded.body["holders"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().into()).collect();
    let mut expected = vec![app.user_id("boss_s").await.to_string(), alice_id.to_string()];
    expected.sort();
    assert_eq!(holders, expected);
    assert!(has(&expanded.body["tree"], "subject", "group:crew#member"));

    let explained = app
        .call(
            "GET",
            "/api/admin/permissions/check?subject=user:alice_s&object=catalog:mogaesup&relation=editor",
            None,
            Some(&boss),
        )
        .await;
    assert_eq!(explained.body["allowed"], true);
    assert!(has(&explained.body["trace"], "subject", "group:crew#member"));
    let unknown = app
        .call(
            "GET",
            "/api/admin/permissions/check?subject=user:alice_s&object=system:mogaesup&relation=owner",
            None,
            Some(&boss),
        )
        .await;
    assert_eq!(unknown.body["code"], "invalid_relation");

    let tuples = app.call("GET", "/api/admin/permissions/tuples?subject=group:crew", None, Some(&boss)).await;
    assert_eq!(tuples.body["tuples"][0]["relation"], "moderator");
    assert_eq!(tuples.body["tuples"][0]["createdBy"], "boss_s");
    let on_system = app.call("GET", "/api/admin/permissions/tuples?object=system:mogaesup", None, Some(&boss)).await;
    assert_eq!(on_system.body["tuples"].as_array().unwrap().len(), 3);
    let schema = app.call("GET", "/api/admin/permissions/schema", None, Some(&boss)).await;
    assert!(schema.body["types"].as_array().unwrap().iter().any(|t| t["type"] == "home"));
    assert_eq!(schema.body["permissions"].as_array().unwrap().len(), PERMISSIONS.len());
    app.cleanup().await;
}
