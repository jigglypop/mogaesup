//! The studio gateway (src/factory.rs): which request paths reach the character server and as what, the server-wide
//! ceiling on changes (access level, monthly paid budget, the record in `factory_requests`), and what is read back.

mod common;

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::Request,
    http::{StatusCode, header},
    response::IntoResponse,
};
use common::TestApp;
use futures_util::{StreamExt, future::join_all, stream};
use mogaesup_server::{
    config::{Factory, FactoryAccess},
    factory,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

/// One request the fake character server received.
#[derive(Clone, Debug)]
struct Call {
    method: String,
    uri: String,
    /// Whether it came with a body's framing: a `Transfer-Encoding` or a `Content-Length`.
    framed: bool,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Call>>>);

impl Seen {
    fn record(&self, request: &Request) {
        let headers = request.headers();
        self.0.lock().unwrap().push(Call {
            method: request.method().to_string(),
            uri: request.uri().to_string(),
            framed: headers.contains_key(header::TRANSFER_ENCODING) || headers.contains_key(header::CONTENT_LENGTH),
        });
    }

    fn calls(&self) -> Vec<Call> {
        self.0.lock().unwrap().clone()
    }

    fn uris(&self) -> Vec<String> {
        self.calls().into_iter().map(|call| call.uri).collect()
    }
}

/// A character server that writes down what it is sent and answers `{"ok": true}`.
async fn fake_factory(seen: Seen) -> String {
    let app = Router::new().fallback(move |request: Request| {
        let seen = seen.clone();
        async move {
            seen.record(&request);
            Json(json!({"ok": true}))
        }
    });
    serve(app).await
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn settings(url: String, access: FactoryAccess, paid_monthly: i64) -> Factory {
    Factory { url, api_key: None, token: None, access, paid_monthly, gateway_key: None, instance: None }
}

async fn gateway(access: FactoryAccess, paid_monthly: i64) -> (TestApp, Seen) {
    let seen = Seen::default();
    let url = fake_factory(seen.clone()).await;
    (TestApp::new(Some(settings(url, access, paid_monthly))).await, seen)
}

async fn admin(app: &TestApp, name: &str) -> String {
    let cookie = app.register(name, name).await;
    app.make_admin(name).await;
    cookie
}

async fn requests(app: &TestApp) -> Vec<(String, String, bool, Option<i16>)> {
    sqlx::query_as("SELECT method, path, paid, status FROM factory_requests ORDER BY id")
        .fetch_all(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn authenticated_model_delivery_preserves_ranges_head_and_conditional_headers() {
    let upstream = Router::new().fallback(|request: Request| async move {
        assert_eq!(request.headers()[header::RANGE], "bytes=0-3");
        assert_eq!(request.headers()[header::IF_RANGE], "\"model-v1\"");
        if request.headers().contains_key(header::IF_NONE_MATCH) {
            assert_eq!(request.headers()[header::IF_NONE_MATCH], "\"model-v1\"");
            return (StatusCode::NOT_MODIFIED, [(header::ETAG, "\"model-v1\"")]).into_response();
        }
        (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, "model/gltf-binary"),
                (header::CONTENT_LENGTH, "4"),
                (header::CONTENT_RANGE, "bytes 0-3/8"),
                (header::ACCEPT_RANGES, "bytes"),
                (header::ETAG, "\"model-v1\""),
                (header::LAST_MODIFIED, "Thu, 01 Oct 2026 00:00:00 GMT"),
            ],
            "glTF",
        )
            .into_response()
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Read, 0))).await;
    let cookie = admin(&app, "delivery_admin").await;
    for (method, conditional) in [("GET", false), ("HEAD", false), ("GET", true)] {
        let mut request = axum::http::Request::builder()
            .method(method)
            .uri("/api/avatar-factory/jobs/j1/native-parts/v1/model.glb")
            .header(header::ORIGIN, common::ORIGIN)
            .header(header::COOKIE, &cookie)
            .header(header::RANGE, "bytes=0-3")
            .header(header::IF_RANGE, "\"model-v1\"");
        if conditional {
            request = request.header(header::IF_NONE_MATCH, "\"model-v1\"");
        }
        let reply = app.send(request.body(Body::empty()).unwrap()).await;
        assert_eq!(reply.headers[header::ETAG], "\"model-v1\"");
        if conditional {
            assert_eq!(reply.status, StatusCode::NOT_MODIFIED);
        } else {
            assert_eq!(reply.status, StatusCode::PARTIAL_CONTENT);
            assert_eq!(reply.headers[header::CONTENT_LENGTH], "4");
            assert_eq!(reply.headers[header::CONTENT_RANGE], "bytes 0-3/8");
            assert_eq!(reply.headers[header::ACCEPT_RANGES], "bytes");
            assert_eq!(reply.bytes, if method == "HEAD" { b"".as_slice() } else { b"glTF".as_slice() });
        }
    }
    app.cleanup().await;
}

#[tokio::test]
async fn 경로를_인코딩해_돌려_써도_회원은_옷장_밖으로_나가지_못한다() {
    let (app, seen) = gateway(FactoryAccess::Paid, 10).await;
    let member = app.register("member_t", "회원").await;
    let boss = admin(&app, "admin_t").await;
    for tail in [
        "wardrobe/%2e%2e/jobs",
        "wardrobe/.%2e/jobs",
        "wardrobe/%2e./jobs",
        "wardrobe/%2E%2E/jobs",
        "wardrobe/%252e%252e/jobs",
        "wardrobe/..%2fjobs",
        "wardrobe/..%2Fjobs",
        "wardrobe//x",
        "wardrobe/../jobs",
        "wardrobe/%2e/x",
        "wardrobe/a%5cb",
        "wardrobe/%00",
        "wardrobe/%ff",
        "jobs/j1/native-parts/v2/x.glb%2f..%2f..%2fjobs",
    ] {
        let studio = app.call("GET", &format!("/api/avatar-factory/{tail}"), None, Some(&member)).await;
        assert_eq!((studio.status, studio.body["code"].as_str()), (StatusCode::NOT_FOUND, Some("not_found")), "{tail}");
        // The admins' proxy reads the same path the same way, whatever the method.
        for method in ["GET", "POST", "DELETE"] {
            let proxied = app.call(method, &format!("/api/factory/avatar-factory/{tail}"), None, Some(&boss)).await;
            assert_eq!(
                (proxied.status, proxied.body["code"].as_str()),
                (StatusCode::NOT_FOUND, Some("not_found")),
                "{method} {tail}"
            );
        }
    }
    assert!(seen.calls().is_empty(), "nothing reached the character server: {:?}", seen.calls());
    assert_eq!(requests(&app).await, []);

    // What is allowed still reaches it, with a normal path: decoded once and written out again, the query as it came.
    for path in [
        "/api/avatar-factory/wardrobe/bodies",
        "/api/avatar-factory/jobs/j1/native-parts/v2/body.glb",
        "/api/avatar-factory/%77ardrobe/colors/j1/hat?version=v2",
        "/api/avatar-factory/jobs/j1/native-parts/v2/%62ody.glb",
        "/api/avatar-factory/wardrobe/previews/%ED%95%9C%20%EA%B8%80?x=%20&y",
    ] {
        let reply = app.call("GET", path, None, Some(&member)).await;
        assert_eq!((reply.status, reply.body["ok"].as_bool()), (StatusCode::OK, Some(true)), "{path}");
    }
    assert_eq!(
        seen.uris(),
        [
            "/api/avatar-factory/wardrobe/bodies",
            "/api/avatar-factory/jobs/j1/native-parts/v2/body.glb",
            "/api/avatar-factory/wardrobe/colors/j1/hat?version=v2",
            "/api/avatar-factory/jobs/j1/native-parts/v2/body.glb",
            "/api/avatar-factory/wardrobe/previews/%ED%95%9C%20%EA%B8%80?x=%20&y",
        ]
    );

    // A segment is judged as what it decodes to: an encoded `?` does not end the name early, so this is no `.glb`.
    let smuggled = "/api/avatar-factory/jobs/j1/native-parts/v2/body.glb%3Fx";
    assert_eq!(app.call("GET", smuggled, None, Some(&member)).await.body["code"], "studio_viewer_only");
    assert_eq!(
        app.call("GET", "/api/avatar-factory/jobs", None, Some(&member)).await.body["code"],
        "studio_viewer_only"
    );
    assert_eq!(seen.calls().len(), 5);
    app.cleanup().await;
}

#[tokio::test]
async fn 읽기는_본문_없이_보내고_바꾸는_요청만_본문을_흘려_보낸다() {
    let (app, seen) = gateway(FactoryAccess::Write, 0).await;
    let member = app.register("member_b", "회원").await;
    let boss = admin(&app, "admin_b").await;
    app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&member)).await;
    app.call("GET", "/api/factory/avatar-factory/capabilities", None, Some(&boss)).await;
    app.call("PUT", "/api/avatar-factory/wardrobe/outfits/mine", Some(json!({"name": "a"})), Some(&boss)).await;
    let calls = seen.calls();
    assert_eq!(calls.iter().map(|call| call.method.as_str()).collect::<Vec<_>>(), ["GET", "GET", "PUT"]);
    assert_eq!(calls.iter().map(|call| call.framed).collect::<Vec<_>>(), [false, false, true], "{calls:?}");
    app.cleanup().await;
}

#[tokio::test]
async fn 관리자_프록시의_변경도_서버_전체_상한과_기록을_따른다() {
    // Read only: nothing that changes anything gets through, and nothing is written down for it.
    let (app, seen) = gateway(FactoryAccess::Read, 5).await;
    let boss = admin(&app, "admin_r").await;
    let code = |reply: common::Reply| (reply.status, reply.body["code"].as_str().map(str::to_owned));
    let post = app.call("POST", "/api/factory/studio/generations", Some(json!({})), Some(&boss)).await;
    assert_eq!(code(post), (StatusCode::FORBIDDEN, Some("factory_paid_off".into())));
    for method in ["PUT", "PATCH", "DELETE"] {
        let write =
            app.call(method, "/api/factory/avatar-factory/wardrobe/outfits/mine", Some(json!({})), Some(&boss)).await;
        assert_eq!(code(write), (StatusCode::FORBIDDEN, Some("factory_read_only".into())), "{method}");
    }
    assert!(seen.calls().is_empty(), "{:?}", seen.calls());
    assert_eq!(requests(&app).await, []);
    // Reads still go through, and are not recorded.
    assert_eq!(app.call("GET", "/api/factory/avatar-factory/capabilities", None, Some(&boss)).await.body["ok"], true);
    assert_eq!((seen.calls().len(), requests(&app).await.len()), (1, 0));
    app.cleanup().await;

    // Write: records change, free uploads and the local sheet crop included; paid work stays refused.
    let (app, seen) = gateway(FactoryAccess::Write, 5).await;
    let boss = admin(&app, "admin_w").await;
    let outfit =
        app.call("PUT", "/api/factory/avatar-factory/wardrobe/outfits/mine", Some(json!({})), Some(&boss)).await;
    let crop =
        app.call("POST", "/api/factory/avatar-factory/part-batches/split-sheet", Some(json!({})), Some(&boss)).await;
    assert_eq!((outfit.status, crop.status), (StatusCode::OK, StatusCode::OK));
    let paid = app.call("POST", "/api/factory/studio/generations", Some(json!({})), Some(&boss)).await;
    assert_eq!(code(paid), (StatusCode::FORBIDDEN, Some("factory_paid_off".into())));
    assert_eq!(
        requests(&app).await,
        [
            ("PUT".to_owned(), "avatar-factory/wardrobe/outfits/mine".to_owned(), false, Some(200)),
            ("POST".to_owned(), "avatar-factory/part-batches/split-sheet".to_owned(), false, Some(200)),
        ]
    );
    assert_eq!(seen.calls().len(), 2);
    app.cleanup().await;

    // Paid, one request a month: the proxy spends it and the studio's own route cannot spend another.
    let (app, seen) = gateway(FactoryAccess::Paid, 1).await;
    let boss = admin(&app, "admin_p").await;
    let operator = app.register("operator_p", "운영자").await;
    app.grant("operator_p", "system:mogaesup", "paid_operator").await;
    let refused = app.call("POST", "/api/factory/studio/generations", Some(json!({})), Some(&operator)).await;
    assert_eq!(code(refused), (StatusCode::FORBIDDEN, Some("admin_only".into())), "the proxy is for admins");
    for _ in 0..3 {
        let crop = app.call("POST", "/api/avatar-factory/part-batches/split-sheet", Some(json!({})), Some(&boss)).await;
        assert_eq!(crop.status, StatusCode::OK);
    }
    let first = app.call("POST", "/api/factory/studio/generations", Some(json!({"kind": "prop"})), Some(&boss)).await;
    assert_eq!(first.status, StatusCode::OK);
    let second = app.call("POST", "/api/factory/studio/generations", Some(json!({"kind": "prop"})), Some(&boss)).await;
    assert_eq!(code(second), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget".into())));
    let own = app.call("POST", "/api/studio/generations", Some(json!({"kind": "prop"})), Some(&boss)).await;
    assert_eq!(code(own), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget".into())));
    let paid_rows: Vec<_> = requests(&app).await.into_iter().filter(|row| row.2).collect();
    assert_eq!(paid_rows, [("POST".to_owned(), "studio/generations".to_owned(), true, Some(200))]);
    assert_eq!(seen.calls().len(), 4, "three crops and the one paid request");
    app.cleanup().await;
}

#[tokio::test]
async fn 유료_작업은_동시에_보내도_한도만큼만_시작된다() {
    let (app, seen) = gateway(FactoryAccess::Paid, 3).await;
    let boss = admin(&app, "admin_c").await;
    let sends = (0..12).map(|at| {
        let (app, boss) = (&app, boss.clone());
        // Half through the studio's own route, half through the admins' proxy: one budget for both.
        async move {
            let path = if at % 2 == 0 { "/api/studio/generations" } else { "/api/factory/studio/generations" };
            app.call("POST", path, Some(json!({"kind": "prop"})), Some(&boss)).await
        }
    });
    let replies = join_all(sends).await;
    let started = replies.iter().filter(|reply| reply.status == StatusCode::OK).count();
    let refused = replies
        .iter()
        .filter(|reply| reply.status == StatusCode::TOO_MANY_REQUESTS && reply.body["code"] == "factory_budget")
        .count();
    assert_eq!((started, refused), (3, 9));
    let recorded = requests(&app).await;
    assert_eq!(recorded.iter().filter(|row| row.2).count(), 3, "{recorded:?}");
    assert_eq!(seen.calls().len(), 3);
    let usage = app.call("GET", "/api/catalog/admin/factory-usage", None, Some(&boss)).await;
    assert_eq!(usage.body["paidThisMonth"], 3);
    app.cleanup().await;
}

/// A character server whose JSON answers are as big as the path says, and whose `/gone` is a 404 and `/flat` a 422.
async fn json_factory() -> String {
    let app = Router::new().fallback(|request: Request| async move {
        let path = request.uri().path().to_owned();
        match path.as_str() {
            "/api/gone" => StatusCode::NOT_FOUND.into_response(),
            "/api/flat" => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"code": "no_texture"}))).into_response(),
            // Announced in full, and streamed with no length at all: both are stopped.
            "/api/big" => Json(json!({"pad": "x".repeat(9 * 1024 * 1024)})).into_response(),
            "/api/streamed" => {
                let chunk = Bytes::from(vec![b' '; 1024 * 1024]);
                let body = Body::from_stream(stream::iter(0..12).map(move |_| Ok::<_, std::io::Error>(chunk.clone())));
                ([(header::CONTENT_TYPE, "application/json")], body).into_response()
            }
            "/api/small" => Json(json!({"pad": "x".repeat(4 * 1024 * 1024)})).into_response(),
            _ => Json(json!({"ok": true})).into_response(),
        }
    });
    serve(app).await
}

#[tokio::test]
async fn 캐릭터_서버의_json_답은_정해진_크기까지만_읽는다() {
    let app = TestApp::new(Some(settings(json_factory().await, FactoryAccess::Read, 0))).await;
    let state = &app.state;
    let small = factory::fetch_json(state, "user", "small").await.unwrap().unwrap();
    assert_eq!(small["pad"].as_str().unwrap().len(), 4 * 1024 * 1024);
    for path in ["big", "streamed"] {
        let error = factory::fetch_json(state, "user", path).await.unwrap_err();
        assert_eq!((error.status, error.code), (StatusCode::BAD_GATEWAY, "factory_unavailable"), "{path}");
    }
    // A 404 is no answer; a 422 is one too only where the caller says the request may not apply.
    assert_eq!(factory::fetch_json(state, "user", "gone").await.unwrap(), None);
    assert_eq!(factory::fetch_json_if_applicable(state, "user", "gone").await.unwrap(), None);
    assert_eq!(factory::fetch_json(state, "user", "flat").await.unwrap_err().code, "factory_unavailable");
    assert_eq!(factory::fetch_json_if_applicable(state, "user", "flat").await.unwrap(), None);
    // The query of the callers' own paths arrives as a query, not as part of a segment.
    let probe = Seen::default();
    let url = fake_factory(probe.clone()).await;
    let probed = TestApp::new(Some(settings(url, FactoryAccess::Read, 0))).await;
    factory::fetch_json(&probed.state, "user", "avatar-factory/wardrobe/colors/j1/hat?version=v2").await.unwrap();
    assert_eq!(probe.uris(), ["/api/avatar-factory/wardrobe/colors/j1/hat?version=v2"]);
    assert!(factory::fetch_json(&probed.state, "user", "avatar-factory/../jobs").await.is_err());
    assert_eq!(probe.calls().len(), 1);
    probed.cleanup().await;
    app.cleanup().await;
}

/// A character server that answers `/api/file` with a redirect to `to(its own address)`, and `/api/near` with one to a
/// file it serves itself.
async fn redirecting_factory(to: impl Fn(&str) -> String + Clone + Send + Sync + 'static) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let location = to(&base);
    let app = Router::new().fallback(move |request: Request| {
        let location = location.clone();
        async move {
            match request.uri().path() {
                "/api/file" => (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, location)]).into_response(),
                "/api/near" => {
                    (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, "/signed/near.bin")]).into_response()
                }
                "/signed/near.bin" => "near bytes".into_response(),
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

#[tokio::test]
async fn 캐릭터_서버가_파일을_다른_곳으로_돌려보내도_믿을_수_있는_곳만_따라간다() {
    // Whatever the redirect names must not be asked: a server on another port stands for the network behind it.
    let elsewhere = Seen::default();
    let target = fake_factory(elsewhere.clone()).await;
    let url = redirecting_factory(move |_| format!("{target}/secret")).await;
    let app = TestApp::new(Some(settings(url, FactoryAccess::Read, 0))).await;
    let error = factory::fetch_file(&app.state, "user", "file", 1024, None).await.unwrap_err();
    assert_eq!((error.status, error.code), (StatusCode::BAD_GATEWAY, "factory_unavailable"));
    assert!(elsewhere.calls().is_empty(), "{:?}", elsewhere.calls());
    // With credentials in the address, even the character server's own address is refused.
    let url =
        redirecting_factory(|own| format!("{}/signed/near.bin", own.replace("http://", "http://user:secret@"))).await;
    let credentialed = TestApp::new(Some(settings(url, FactoryAccess::Read, 0))).await;
    assert!(factory::fetch_file(&credentialed.state, "user", "file", 1024, None).await.is_err());
    // A redirect back to the character server itself is how a local run serves its files.
    let bytes = factory::fetch_file(&app.state, "user", "near", 1024, None).await.unwrap();
    assert_eq!(bytes, b"near bytes");
    credentialed.cleanup().await;
    app.cleanup().await;
}

#[tokio::test]
async fn models_pass_through_uncompressed_with_their_length_and_json_is_still_compressed() {
    let upstream = Router::new().fallback(|request: Request| async move {
        let body = vec![b'a'; 4096];
        if request.uri().path().ends_with(".glb") {
            ([(header::CONTENT_TYPE, "model/gltf-binary"), (header::ACCEPT_RANGES, "bytes")], body).into_response()
        } else if request.uri().path().ends_with(".bin") {
            ([(header::CONTENT_TYPE, "application/octet-stream")], body).into_response()
        } else {
            Json(json!({"pad": "a".repeat(4096)})).into_response()
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Read, 0))).await;
    let member = app.register("member_z", "회원").await;
    let get = |path: &str| {
        axum::http::Request::builder()
            .uri(path)
            .header(header::COOKIE, &member)
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap()
    };
    for path in ["/api/avatar-factory/jobs/j1/native-parts/v1/body.glb", "/api/avatar-factory/wardrobe/previews/j1.bin"]
    {
        let reply = app.send(get(path)).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert!(!reply.headers.contains_key(header::CONTENT_ENCODING), "{path}: {:?}", reply.headers);
        assert_eq!(reply.headers[header::CONTENT_LENGTH], "4096", "{path}");
        assert_eq!(reply.bytes.len(), 4096, "{path}");
    }
    assert_eq!(
        app.send(get("/api/avatar-factory/jobs/j1/native-parts/v1/body.glb")).await.headers[header::ACCEPT_RANGES],
        "bytes"
    );
    let listing = app.send(get("/api/avatar-factory/wardrobe/bodies")).await;
    assert_eq!(listing.headers[header::CONTENT_ENCODING], "gzip");
    app.cleanup().await;
}

/// Sends `path` a POST from `cookie`, with `key` as its Idempotency-Key.
fn keyed_post(path: &str, cookie: &str, key: Option<&str>) -> axum::http::Request<Body> {
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header(header::ORIGIN, common::ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie);
    if let Some(key) = key {
        request = request.header("idempotency-key", key);
    }
    request.body(Body::from("{}")).unwrap()
}

async fn paid_this_month(app: &TestApp, cookie: &str) -> i64 {
    let usage = app.call("GET", "/api/catalog/admin/factory-usage", None, Some(cookie)).await;
    usage.body["paidThisMonth"].as_i64().unwrap()
}

#[tokio::test]
async fn paid_requests_that_started_nothing_or_were_sent_again_are_not_counted_twice() {
    // The provider behind `variants` is down: the character server answers 500 of its own.
    let upstream = Router::new().fallback(|request: Request| async move {
        match request.uri().path() {
            "/api/avatar-factory/variants" => (StatusCode::INTERNAL_SERVER_ERROR, "provider down").into_response(),
            _ => Json(json!({"ok": true})).into_response(),
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Paid, 2))).await;
    let boss = admin(&app, "admin_k").await;
    let failed = app.send(keyed_post("/api/avatar-factory/variants", &boss, Some("v1"))).await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(paid_this_month(&app, &boss).await, 0);

    // One Idempotency-Key at one path is one request; its replay passes even once the budget is spent.
    let generations = "/api/studio/generations";
    for key in ["k1", "k1"] {
        assert_eq!(app.send(keyed_post(generations, &boss, Some(key))).await.status, StatusCode::OK);
    }
    assert_eq!(paid_this_month(&app, &boss).await, 1);
    assert_eq!(app.send(keyed_post(generations, &boss, Some("k2"))).await.status, StatusCode::OK);
    assert_eq!(paid_this_month(&app, &boss).await, 2);
    assert_eq!(app.send(keyed_post(generations, &boss, Some("k1"))).await.status, StatusCode::OK);
    let spent = app.send(keyed_post(generations, &boss, Some("k3"))).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    // The same key at another path is another request.
    let elsewhere = app.send(keyed_post("/api/studio/animals", &boss, Some("k1"))).await;
    assert_eq!(elsewhere.body["code"], "factory_budget");
    assert_eq!(paid_this_month(&app, &boss).await, 2);
    let recorded: Vec<(String, Option<String>, Option<i16>)> =
        sqlx::query_as("SELECT path, idempotency_key, status FROM factory_requests WHERE paid ORDER BY id")
            .fetch_all(&app.state.db)
            .await
            .unwrap();
    assert_eq!(recorded.len(), 5, "{recorded:?}");
    assert_eq!(recorded[0], ("avatar-factory/variants".to_owned(), Some("v1".to_owned()), Some(500)));

    // A paid route that ignores the key starts its work again on every request, so each one counts.
    sqlx::query("DELETE FROM factory_requests").execute(&app.state.db).await.unwrap();
    let resume = "/api/studio/generations/g1/resume";
    for _ in 0..2 {
        assert_eq!(app.send(keyed_post(resume, &boss, Some("r1"))).await.status, StatusCode::OK);
    }
    assert_eq!(paid_this_month(&app, &boss).await, 2);
    let again = app.send(keyed_post(resume, &boss, Some("r1"))).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    let keys: Vec<Option<String>> =
        sqlx::query_scalar("SELECT idempotency_key FROM factory_requests").fetch_all(&app.state.db).await.unwrap();
    assert_eq!(keys, [None, None]);

    // Which answers count: in flight or unrecorded, any below 500, and a timeout, which may have started work.
    sqlx::query("DELETE FROM factory_requests").execute(&app.state.db).await.unwrap();
    for status in [None, Some(200i16), Some(202), Some(422), Some(500), Some(502), Some(503), Some(504)] {
        sqlx::query(
            "INSERT INTO factory_requests (method, path, paid, status) VALUES ('POST', 'studio/generations', true, $1)",
        )
        .bind(status)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    assert_eq!(paid_this_month(&app, &boss).await, 5);
    app.cleanup().await;

    // A studio that cannot be reached took nothing.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nowhere = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let app = TestApp::new(Some(settings(nowhere, FactoryAccess::Paid, 1))).await;
    let boss = admin(&app, "admin_n").await;
    for _ in 0..2 {
        let reply = app.send(keyed_post(generations, &boss, None)).await;
        assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("factory_unavailable")));
    }
    assert_eq!(paid_this_month(&app, &boss).await, 0);
    app.cleanup().await;
}

#[tokio::test]
async fn work_the_character_server_does_on_its_own_machine_is_not_paid() {
    let (app, seen) = gateway(FactoryAccess::Write, 0).await;
    let boss = admin(&app, "admin_l").await;
    let local = [
        "/api/avatar-factory/jobs/j1/native-parts",
        "/api/avatar-factory/jobs/j1/native-parts/refit",
        "/api/studio/textures",
        "/api/studio/generations/g1/vector",
        "/api/studio/generations/g1/rig",
        "/api/studio/generations/g1/motions",
        "/api/studio/bodies/j1/v1/expressions",
        "/api/studio/bodies/j1/v1/expressions/overlay",
        "/api/studio/bodies/j1/v1/expression-generations/e1/bake",
    ];
    for path in local {
        let reply = app.call("POST", path, Some(json!({})), Some(&boss)).await;
        assert_eq!(
            (reply.status, reply.body["ok"].as_bool()),
            (StatusCode::OK, Some(true)),
            "{path}: {:?}",
            reply.body
        );
    }
    // Generating anything is still paid work, which this server does not start; so is a rig transfer, whose assembly
    // can request the job's default faces.
    for paid in ["/api/studio/bodies/j1/v1/expression-generations", "/api/avatar-factory/jobs/j1/rig-transfer"] {
        let reply = app.call("POST", paid, Some(json!({})), Some(&boss)).await;
        assert_eq!(reply.body["code"], "factory_paid_off", "{paid}");
    }
    let recorded = requests(&app).await;
    assert_eq!(recorded.len(), local.len());
    assert!(recorded.iter().all(|(method, _, paid, status)| method == "POST" && !paid && *status == Some(200)));
    assert_eq!(seen.calls().len(), local.len());
    app.cleanup().await;
}
