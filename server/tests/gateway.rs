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
    security::rate_record,
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
    /// The roles of the bearer token it came with; None without one.
    roles: Option<serde_json::Value>,
}

/// The `roles` claim of a request's bearer token, unchecked.
fn roles(headers: &axum::http::HeaderMap) -> Option<serde_json::Value> {
    use base64::Engine;
    let token = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    Some(serde_json::from_slice::<serde_json::Value>(&payload).ok()?["roles"].clone())
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
            roles: roles(headers),
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
    Factory {
        url,
        api_key: None,
        token: common::factory_token(),
        access,
        paid_monthly,
        gateway_key: None,
        instance: None,
    }
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
    let operator = app.register("operator_p", "스튜디오 담당").await;
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

/// A paid request as `factory_requests` keeps it: path, key, status, and whether the status is the character server's.
type Recorded = (String, Option<String>, Option<i16>, Option<bool>);

async fn paid_this_month(app: &TestApp, cookie: &str) -> i64 {
    let usage = app.call("GET", "/api/catalog/admin/factory-usage", None, Some(cookie)).await;
    usage.body["paidThisMonth"].as_i64().unwrap()
}

#[tokio::test]
async fn paid_requests_that_started_nothing_or_were_sent_again_are_not_counted_twice() {
    // The character server refuses `variants` as it came (422), which started nothing. `image-jobs` fails with a 500
    // of its own once its provider was asked, which may have cost money.
    let upstream = Router::new().fallback(|request: Request| async move {
        match request.uri().path() {
            "/api/avatar-factory/variants" => {
                (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"code": "invalid_variant"}))).into_response()
            }
            "/api/avatar-factory/image-jobs" => (StatusCode::INTERNAL_SERVER_ERROR, "provider failed").into_response(),
            "/api/avatar-factory/jobs/j1/stages/meshy/resume" => {
                (StatusCode::CONFLICT, Json(json!({"code": "stage_running"}))).into_response()
            }
            "/api/studio/generations/big" => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            _ => Json(json!({"ok": true})).into_response(),
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Paid, 3))).await;
    let boss = admin(&app, "admin_k").await;
    let refused = app.send(keyed_post("/api/avatar-factory/variants", &boss, Some("v1"))).await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(paid_this_month(&app, &boss).await, 0);
    // A stage already running refuses a resume (409), however often it is pressed and with whatever key, and a body too
    // large is refused as it came (413): none of them started anything.
    for key in ["r1", "r2", "r3", "r4"] {
        let running = app.send(keyed_post("/api/avatar-factory/jobs/j1/stages/meshy/resume", &boss, Some(key))).await;
        assert_eq!(running.status, StatusCode::CONFLICT);
    }
    let big = app.send(keyed_post("/api/studio/generations/big", &boss, None)).await;
    assert_eq!(big.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(paid_this_month(&app, &boss).await, 0);
    sqlx::query("DELETE FROM factory_requests WHERE status IN (409, 413)").execute(&app.state.db).await.unwrap();
    let failed = app.send(keyed_post("/api/avatar-factory/image-jobs", &boss, Some("i1"))).await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(paid_this_month(&app, &boss).await, 1);

    // One Idempotency-Key at one path is one request; its replay passes even once the budget is spent.
    let generations = "/api/studio/generations";
    for key in ["k1", "k1"] {
        assert_eq!(app.send(keyed_post(generations, &boss, Some(key))).await.status, StatusCode::OK);
    }
    assert_eq!(paid_this_month(&app, &boss).await, 2);
    assert_eq!(app.send(keyed_post(generations, &boss, Some("k2"))).await.status, StatusCode::OK);
    assert_eq!(paid_this_month(&app, &boss).await, 3);
    assert_eq!(app.send(keyed_post(generations, &boss, Some("k1"))).await.status, StatusCode::OK);
    let spent = app.send(keyed_post(generations, &boss, Some("k3"))).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    // The same key at another path is another request.
    let elsewhere = app.send(keyed_post("/api/studio/animals", &boss, Some("k1"))).await;
    assert_eq!(elsewhere.body["code"], "factory_budget");
    assert_eq!(paid_this_month(&app, &boss).await, 3);
    let recorded: Vec<Recorded> =
        sqlx::query_as("SELECT path, idempotency_key, status, upstream FROM factory_requests WHERE paid ORDER BY id")
            .fetch_all(&app.state.db)
            .await
            .unwrap();
    assert_eq!(recorded.len(), 6, "{recorded:?}");
    assert_eq!(recorded[0], ("avatar-factory/variants".to_owned(), Some("v1".to_owned()), Some(422), Some(true)));
    assert_eq!(recorded[1], ("avatar-factory/image-jobs".to_owned(), Some("i1".to_owned()), Some(500), Some(true)));

    // A paid route that ignores the key starts its work again on every request, so each one counts.
    sqlx::query("DELETE FROM factory_requests").execute(&app.state.db).await.unwrap();
    let resume = "/api/studio/generations/g1/resume";
    for _ in 0..3 {
        assert_eq!(app.send(keyed_post(resume, &boss, Some("r1"))).await.status, StatusCode::OK);
    }
    assert_eq!(paid_this_month(&app, &boss).await, 3);
    let again = app.send(keyed_post(resume, &boss, Some("r1"))).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    let keys: Vec<Option<String>> =
        sqlx::query_scalar("SELECT idempotency_key FROM factory_requests").fetch_all(&app.state.db).await.unwrap();
    assert_eq!(keys, [None, None, None]);

    // Which answers count: in flight or unrecorded, a timeout, which may have started work, and the character server's
    // own answers but its refusals before it started anything: of the request as it came (400, 404, 405, 413, 422,
    // 429), of the state it found (409: a stage already running, a job or transfer changed, a key reused) and its 503.
    // This server's own errors (`upstream` false) never reached it; rows from before `upstream` was kept count every
    // answer below 500 but those refusals, as they did. (A 409 counted once: the app drops its key on one, so every press
    // of a button a running stage refused spent the month's budget.)
    sqlx::query("DELETE FROM factory_requests").execute(&app.state.db).await.unwrap();
    let rows: [(Option<i16>, Option<bool>, bool); 25] = [
        (None, None, true),
        (Some(200), None, true),
        (Some(202), None, true),
        (Some(409), None, false),
        (Some(422), None, false),
        (Some(500), None, false),
        (Some(502), None, false),
        (Some(503), None, false),
        (Some(504), None, true),
        (Some(200), Some(true), true),
        (Some(400), Some(true), false),
        (Some(404), Some(true), false),
        (Some(405), Some(true), false),
        (Some(409), Some(true), false),
        (Some(413), Some(true), false),
        (Some(422), Some(true), false),
        (Some(429), Some(true), false),
        (Some(410), Some(true), true),
        (Some(500), Some(true), true),
        (Some(502), Some(true), true),
        (Some(503), Some(true), false),
        (Some(504), Some(true), true),
        (Some(502), Some(false), false),
        (Some(503), Some(false), false),
        (Some(504), Some(false), true),
    ];
    for (status, upstream, _) in rows {
        sqlx::query(
            "INSERT INTO factory_requests (method, path, paid, status, upstream)
             VALUES ('POST', 'studio/generations', true, $1, $2)",
        )
        .bind(status)
        .bind(upstream)
        .execute(&app.state.db)
        .await
        .unwrap();
    }
    let counted = rows.iter().filter(|(.., counted)| *counted).count() as i64;
    assert_eq!(paid_this_month(&app, &boss).await, counted);
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
async fn 회원_옷장_읽기는_회원용_토큰이_있으면_좁혀_보내고_없으면_예전처럼_보내며_한도_안에서만_보낸다() {
    // Without FACTORY_JWT_SECRET (production's state): a member's read goes out as it did before member scoping came,
    // with the server's keys alone, and the admin's usage answer says it is not scoped.
    let seen = Seen::default();
    let url = fake_factory(seen.clone()).await;
    let unscoped = TestApp::new(Some(Factory { token: None, ..settings(url, FactoryAccess::Read, 0) })).await;
    let member = unscoped.register("member_u", "회원").await;
    let boss = admin(&unscoped, "admin_u").await;
    for path in ["/api/avatar-factory/wardrobe/bodies", "/api/avatar-factory/jobs/j1/native-parts/v1/body.glb"] {
        let read = unscoped.call("GET", path, None, Some(&member)).await;
        assert_eq!((read.status, read.body["ok"].as_bool()), (StatusCode::OK, Some(true)), "{path}");
    }
    assert_eq!(unscoped.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&boss)).await.body["ok"], true);
    assert_eq!(seen.calls().len(), 3);
    assert!(seen.calls().iter().all(|call| call.roles.is_none()), "{:?}", seen.calls());
    let usage = unscoped.call("GET", "/api/catalog/admin/factory-usage", None, Some(&boss)).await;
    assert_eq!(usage.body["memberScope"], false);
    unscoped.cleanup().await;

    // With it, a member's read is marked MEMBER and the studio's staff keep the operator's full view.
    let (app, seen) = gateway(FactoryAccess::Read, 0).await;
    let member = app.register("member_v", "회원").await;
    let boss = admin(&app, "admin_v").await;
    assert_eq!(app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&member)).await.body["ok"], true);
    assert_eq!(app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&boss)).await.body["ok"], true);
    let roles: Vec<_> = seen.calls().into_iter().map(|call| call.roles).collect();
    assert_eq!(roles, [Some(json!(["ADMIN", "MEMBER"])), Some(json!(["ADMIN"]))]);
    let usage = app.call("GET", "/api/catalog/admin/factory-usage", None, Some(&boss)).await;
    assert_eq!(usage.body["memberScope"], true);

    // A member's reads are counted, per member and per address.
    let id = app.user_id("member_v").await;
    for _ in 0..1500 {
        rate_record(&app.state, format!("wardrobe:{id}"));
    }
    let spent = app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&member)).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many")));
    assert_eq!(seen.calls().len(), 2);
    // Their places go back once each answer started: none is held after.
    assert_eq!(app.state.wardrobe.members_reading(), 0);
    app.cleanup().await;
}

#[tokio::test]
async fn 한_회원의_옷장_읽기는_몇_개씩만_가고_나머지는_차례를_기다린다() {
    // A character server that holds every answer until the test lets it go.
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let seen = Seen::default();
    let upstream = Router::new().fallback({
        let (gate, seen) = (gate.clone(), seen.clone());
        move |request: Request| {
            let (gate, seen) = (gate.clone(), seen.clone());
            async move {
                seen.record(&request);
                drop(gate.acquire().await.unwrap());
                Json(json!({"ok": true}))
            }
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Read, 0))).await;
    let member = app.register("member_q", "회원").await;
    let paths: Vec<String> = (0..7).map(|at| format!("/api/avatar-factory/wardrobe/previews/p{at}")).collect();
    let reads = join_all(paths.iter().map(|path| app.call("GET", path, None, Some(&member))));
    let watch = async {
        let started = std::time::Instant::now();
        while seen.calls().len() < 6 && started.elapsed() < std::time::Duration::from_secs(15) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // The seventh would have reached it by now, had it not waited its turn.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let reached = seen.calls().len();
        gate.add_permits(7);
        reached
    };
    let (replies, reached) = tokio::join!(reads, watch);
    assert_eq!(reached, 6, "six reads of one member go at once; the seventh waits its turn");
    assert!(replies.iter().all(|reply| reply.status == StatusCode::OK), "every read is answered");
    assert_eq!(seen.calls().len(), 7);
    assert_eq!(app.state.wardrobe.members_reading(), 0);
    app.cleanup().await;
}

#[tokio::test]
async fn 회원_옷장_읽기는_답이_시작되면_자리를_놓고_자리나_답이_늦으면_오래_붙잡지_않는다() {
    use http_body_util::BodyExt;
    use std::time::{Duration, Instant};
    use tower::ServiceExt;
    // A character server that holds `held` until the test lets it go, never answers `silent`, and starts `slow.glb` at
    // once but sends the rest of its body only when let go.
    let (gate, rest) = (Arc::new(tokio::sync::Semaphore::new(0)), Arc::new(tokio::sync::Semaphore::new(0)));
    let seen = Seen::default();
    let upstream = Router::new().fallback({
        let (gate, rest, seen) = (gate.clone(), rest.clone(), seen.clone());
        move |request: Request| {
            let (gate, rest, seen) = (gate.clone(), rest.clone(), seen.clone());
            async move {
                seen.record(&request);
                let path = request.uri().path().to_owned();
                if path.ends_with("/held") {
                    drop(gate.acquire().await.unwrap());
                } else if path.ends_with("/silent") {
                    std::future::pending::<()>().await;
                } else if path.ends_with("/slow.glb") {
                    let first = stream::once(async { Ok::<_, std::io::Error>(Bytes::from_static(b"glTF")) });
                    let later = stream::once(async move {
                        drop(rest.acquire_owned().await.unwrap());
                        Ok(Bytes::from_static(b" rest"))
                    });
                    let body = Body::from_stream(first.chain(later));
                    return ([(header::CONTENT_TYPE, "model/gltf-binary")], body).into_response();
                }
                Json(json!({"ok": true})).into_response()
            }
        }
    });
    let factory = settings(serve(upstream).await, FactoryAccess::Read, 0);
    // Two places for the whole site, waited for at most 300 ms; an answer must start within a second.
    let wardrobe = factory::Wardrobe::new(6, 2, Duration::from_millis(300), Duration::from_secs(1));
    let app = TestApp::tuned(Some(factory), |state| state.wardrobe = wardrobe).await;
    let mut members = Vec::new();
    for name in ["slot_a", "slot_b", "slot_c"] {
        members.push(app.register(name, "회원").await);
    }
    let get = |path: &str, cookie: &str| {
        axum::http::Request::get(path).header(header::COOKIE, cookie).body(Body::empty()).unwrap()
    };

    // The site's places are taken by reads the character server has not started to answer: a third waits the wardrobe's
    // wait, then hears that the wardrobe is busy, without reaching the character server.
    let held: Vec<_> = members[..2]
        .iter()
        .map(|cookie| tokio::spawn(app.router.clone().oneshot(get("/api/avatar-factory/wardrobe/held", cookie))))
        .collect();
    let started = Instant::now();
    while seen.calls().len() < 2 && started.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let asked = Instant::now();
    let busy = app.send(get("/api/avatar-factory/wardrobe/bodies", &members[2])).await;
    assert_eq!((busy.status, busy.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("wardrobe_busy")));
    assert!((Duration::from_millis(300)..Duration::from_secs(3)).contains(&asked.elapsed()), "{:?}", asked.elapsed());
    assert_eq!(seen.calls().len(), 2);
    gate.add_permits(2);
    for read in held {
        assert_eq!(read.await.unwrap().unwrap().status(), StatusCode::OK);
    }

    // An answer that does not start in time is the character server's timeout, and its places go back.
    let asked = Instant::now();
    let silent = app.send(get("/api/avatar-factory/wardrobe/silent", &members[0])).await;
    assert_eq!((silent.status, silent.body["code"].as_str()), (StatusCode::GATEWAY_TIMEOUT, Some("factory_timeout")));
    assert!(asked.elapsed() < Duration::from_secs(5), "{:?}", asked.elapsed());
    assert_eq!(app.state.wardrobe.members_reading(), 0);

    // Places go back as soon as an answer starts: two parts still coming down slow networks hold none of them, so
    // another read goes through at once.
    let mut slow = Vec::new();
    for cookie in &members[..2] {
        let answer = app.router.clone().oneshot(get("/api/avatar-factory/jobs/j1/native-parts/v1/slow.glb", cookie));
        slow.push(answer.await.unwrap());
    }
    assert!(slow.iter().all(|answer| answer.status() == StatusCode::OK));
    assert_eq!(app.state.wardrobe.members_reading(), 0);
    let quick = app.send(get("/api/avatar-factory/wardrobe/bodies", &members[2])).await;
    assert_eq!(quick.status, StatusCode::OK, "{:?}", quick.body);
    rest.add_permits(2);
    for answer in slow {
        assert_eq!(&answer.into_body().collect().await.unwrap().to_bytes()[..], b"glTF rest");
    }
    app.cleanup().await;
}

#[tokio::test]
async fn 실제_라우터의_기한은_보통의_api에만_걸고_스튜디오_경로는_제_기한을_따른다() {
    use std::time::Duration;
    // A character server that takes 600 ms to start any answer, under an API deadline of 300 ms.
    let upstream = Router::new().fallback(|| async {
        tokio::time::sleep(Duration::from_millis(600)).await;
        Json(json!({"bodies": [], "parts": [], "ok": true}))
    });
    let factory = settings(serve(upstream).await, FactoryAccess::Read, 0);
    let app = TestApp::tuned(Some(factory), |state| state.request_deadline = Duration::from_millis(300)).await;
    let member = app.quick_member("deadline_member").await;
    // The studio's routes are outside it: a member's wardrobe read waits for its answer (within the wardrobe's own).
    let read = app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&member)).await;
    assert_eq!((read.status, read.body["ok"].as_bool()), (StatusCode::OK, Some(true)));
    // An API route that asks the character server something is not.
    let look = json!({"body": {"jobId": "body", "version": "v1"}, "parts": {}, "hairColor": null, "colors": {}});
    let saved = app.call("PUT", "/api/looks/me", Some(look), Some(&member)).await;
    assert_eq!((saved.status, saved.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("timeout")));
    app.cleanup().await;
}

#[tokio::test]
async fn 봉인된_파일과_미리보기의_캐시_헤더는_그대로_전하고_없는_답은_저장하지_않게_한다() {
    // The character server marks a sealed version's files, previews and masks immutable (and the rest no-store): the
    // member's browser keeps them, and opening the wardrobe again asks for none of them.
    let upstream = Router::new().fallback(|request: Request| async move {
        let path = request.uri().path().to_owned();
        if path.contains("/previews/") || path.ends_with(".glb") {
            let headers =
                [(header::CACHE_CONTROL, "private, max-age=31536000, immutable"), (header::CONTENT_TYPE, "image/png")];
            (headers, "bytes").into_response()
        } else {
            Json(json!({"ok": true})).into_response()
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Read, 0))).await;
    let member = app.register("cache_member", "회원").await;
    for path in [
        "/api/avatar-factory/wardrobe/previews/j1/hat?version=v1",
        "/api/avatar-factory/jobs/j1/native-parts/v1/hat.glb",
    ] {
        let kept = app.call("GET", path, None, Some(&member)).await;
        assert_eq!(kept.headers[header::CACHE_CONTROL], "private, max-age=31536000, immutable", "{path}");
    }
    let listing = app.call("GET", "/api/avatar-factory/wardrobe/bodies", None, Some(&member)).await;
    assert_eq!(listing.headers[header::CACHE_CONTROL], "no-store");
    app.cleanup().await;
}

#[tokio::test]
async fn 골격_복구는_캐릭터_서버가_비용이_든다고_할_때만_유료로_센다() {
    // The character server's transfer state says whether the assembly after it will make paid default faces.
    let seen = Seen::default();
    let upstream = Router::new().fallback({
        let seen = seen.clone();
        move |request: Request| {
            let seen = seen.clone();
            async move {
                seen.record(&request);
                let state = match request.uri().path() {
                    "/api/avatar-factory/jobs/free/rig-transfer" => json!({"status": "not_started", "paid": false}),
                    "/api/avatar-factory/jobs/costly/rig-transfer" => json!({"status": "not_started", "paid": true}),
                    _ => json!({"status": "not_started"}),
                };
                if request.method() == axum::http::Method::GET {
                    Json(state).into_response()
                } else {
                    (StatusCode::ACCEPTED, Json(json!({"status": "accepted"}))).into_response()
                }
            }
        }
    });
    let url = serve(upstream).await;
    let transfer = |job: &str, cookie: &str, key: &str| {
        keyed_post(&format!("/api/avatar-factory/jobs/{job}/rig-transfer"), cookie, Some(key))
    };

    // Changes but no paid work: an operator's free transfer goes, recorded unpaid; one that costs money, or whose cost
    // the state does not make clear, takes a paid operator and is never sent.
    let app = TestApp::new(Some(settings(url.clone(), FactoryAccess::Write, 0))).await;
    let operator = app.register("rig_operator", "운영").await;
    app.grant("rig_operator", "system:mogaesup", "operator").await;
    assert_eq!(app.send(transfer("free", &operator, "t1")).await.status, StatusCode::ACCEPTED);
    for job in ["costly", "unclear"] {
        let refused = app.send(transfer(job, &operator, "t2")).await;
        assert_eq!(
            (refused.status, refused.body["code"].as_str()),
            (StatusCode::FORBIDDEN, Some("paid_operator_only")),
            "{job}"
        );
    }
    let boss = admin(&app, "rig_writer").await;
    assert_eq!(app.send(transfer("costly", &boss, "t3")).await.body["code"], "factory_paid_off");
    assert_eq!(
        requests(&app).await,
        [("POST".to_owned(), "avatar-factory/jobs/free/rig-transfer".to_owned(), false, Some(202))]
    );
    let posts = seen.calls().into_iter().filter(|call| call.method == "POST").count();
    assert_eq!(posts, 1);
    app.cleanup().await;

    // Paid work allowed but the month's budget spent: the free transfer still goes, through the admins' proxy too, and
    // the costly one is refused for the budget.
    let app = TestApp::new(Some(settings(url, FactoryAccess::Paid, 0))).await;
    let boss = admin(&app, "rig_admin").await;
    assert_eq!(app.send(transfer("free", &boss, "t4")).await.status, StatusCode::ACCEPTED);
    let proxied = keyed_post("/api/factory/avatar-factory/jobs/free/rig-transfer", &boss, Some("t5"));
    assert_eq!(app.send(proxied).await.status, StatusCode::ACCEPTED);
    let spent = app.send(transfer("costly", &boss, "t6")).await;
    assert_eq!((spent.status, spent.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("factory_budget")));
    let paid: Vec<bool> = requests(&app).await.into_iter().map(|row| row.2).collect();
    assert_eq!(paid, [false, false]);
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
    // Generating anything is still paid work, which this server does not start; so is a rig transfer whose state does
    // not say it is free (its assembly can request the job's default faces): that state is read, the transfer not sent.
    for paid in ["/api/studio/bodies/j1/v1/expression-generations", "/api/avatar-factory/jobs/j1/rig-transfer"] {
        let reply = app.call("POST", paid, Some(json!({})), Some(&boss)).await;
        assert_eq!(reply.body["code"], "factory_paid_off", "{paid}");
    }
    let recorded = requests(&app).await;
    assert_eq!(recorded.len(), local.len());
    assert!(recorded.iter().all(|(method, _, paid, status)| method == "POST" && !paid && *status == Some(200)));
    let posts = seen.calls().into_iter().filter(|call| call.method == "POST").count();
    assert_eq!(posts, local.len());
    let reads: Vec<String> =
        seen.calls().into_iter().filter(|call| call.method == "GET").map(|call| call.uri).collect();
    assert_eq!(reads, ["/api/avatar-factory/jobs/j1/rig-transfer"]);
    app.cleanup().await;
}

#[tokio::test]
async fn 캐릭터_서버가_이_서버의_인증을_거절하면_앱_로그인과_다른_502로_알린다() {
    // A character server whose token, API key or gateway key check refuses this server: 401 or 403 by path.
    let upstream = Router::new().fallback(|request: Request| async move {
        let path = request.uri().path().to_owned();
        if path.ends_with("/locked") {
            (StatusCode::UNAUTHORIZED, Json(json!({"detail": "JWT expired"}))).into_response()
        } else if path.ends_with("/closed") {
            (StatusCode::FORBIDDEN, Json(json!({"detail": "Studio operator access required"}))).into_response()
        } else if path.ends_with("/missing") {
            (StatusCode::NOT_FOUND, Json(json!({"detail": "no such part"}))).into_response()
        } else {
            Json(json!({"ok": true})).into_response()
        }
    });
    let app = TestApp::new(Some(settings(serve(upstream).await, FactoryAccess::Write, 0))).await;
    let member = app.register("member_auth", "회원").await;
    let boss = admin(&app, "admin_auth").await;
    let code = |reply: common::Reply| (reply.status, reply.body["code"].as_str().map(str::to_owned));
    let refused = || (StatusCode::BAD_GATEWAY, Some("factory_auth".to_owned()));
    for (path, cookie) in [
        ("/api/avatar-factory/wardrobe/locked", &member),
        ("/api/avatar-factory/wardrobe/closed", &member),
        ("/api/factory/avatar-factory/closed", &boss),
        ("/api/studio/locked", &boss),
    ] {
        assert_eq!(code(app.call("GET", path, None, Some(cookie)).await), refused(), "{path}");
    }
    // A change refused that way is recorded as the gateway's failure, which started nothing.
    let write = app.call("PUT", "/api/avatar-factory/wardrobe/outfits/locked", Some(json!({})), Some(&boss)).await;
    assert_eq!(code(write), refused());
    assert_eq!(
        requests(&app).await,
        [("PUT".to_owned(), "avatar-factory/wardrobe/outfits/locked".to_owned(), false, Some(502))]
    );
    // The character server's other answers still pass as they came; the member stays signed in throughout.
    let missing = app.call("GET", "/api/avatar-factory/wardrobe/missing", None, Some(&member)).await;
    assert_eq!((missing.status, missing.body["detail"].as_str()), (StatusCode::NOT_FOUND, Some("no such part")));
    let me = app.call("GET", "/api/auth/me", None, Some(&member)).await;
    assert_eq!(me.body["user"]["username"], "member_auth");
    app.cleanup().await;
}
