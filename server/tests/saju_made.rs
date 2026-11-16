//! A 사주 home's reading and its 미연시 picture, made by the OpenAI API: here a stand-in served in the test, which
//! answers as the API does (a reading, a refusal, broken JSON, an error, no answer in time) and keeps what it was sent.

mod common;

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use common::{ORIGIN, Reply, TestApp};
use image::{ImageEncoder, codecs::png::PngEncoder};
use mogaesup_server::{config::OpenAi, models::SWEEP_AGE, saju_made};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tokio::sync::Semaphore;

const FIXTURE: &str = include_str!("fixtures/saju-chart.json");
const FIXTURE_NO_HOUR: &str = include_str!("fixtures/saju-chart-no-hour.json");

/// How the stand-in answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Write,
    Refuse,
    BadJson,
    Fail,
    Slow,
}

/// One request the stand-in was sent.
struct Call {
    path: String,
    authorization: Option<String>,
    content_type: String,
    body: Vec<u8>,
}

struct Fake {
    mode: Mode,
    calls: Vec<Call>,
    /// Held answers wait for a permit here.
    gate: Option<Arc<Semaphore>>,
}

type Shared = Arc<Mutex<Fake>>;

/// A WebP's header as far as its size, 1024×1024, then `tail` so that each picture is a file of its own.
fn webp(tail: &[u8]) -> Vec<u8> {
    let mut bytes = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\xff\x03\0\xff\x03\0".to_vec();
    bytes.extend_from_slice(tail);
    bytes
}

/// A reading of the shape asked for: with a 명반 part when the request's schema asks for one.
fn written(request: &Value) -> Value {
    let body = "갑목 일간이 인월에 뿌리를 내려 곧게 자라는 힘이 커요. 비견이 둘이라 스스로 길을 내는 편이에요. \
                금이 없어 다듬는 손길이 아쉬우니 마무리를 함께 봐 줄 사람을 곁에 두면 좋아요.";
    let part = |titles: &[&str]| {
        json!({"summary": "곧은 나무가 봄볕을 받은 사주예요. 스스로 자라는 힘이 크고 따뜻한 화가 곁에 있어요.",
               "sections": titles.iter().map(|title| json!({"title": title, "body": body})).collect::<Vec<_>>()})
    };
    let mut reading = json!({"saju": part(&["타고난 기질", "일과 재물", "관계", "지금의 대운", "생활의 결"])});
    let required = &request["text"]["format"]["schema"]["required"];
    if required.as_array().is_some_and(|parts| parts.contains(&json!("ziwei"))) {
        reading["ziwei"] = part(&["명궁", "재백과 관록", "부처와 형제", "지금의 대한"]);
    }
    reading
}

async fn answer(fake: &Shared, path: &str, headers: &HeaderMap, body: Bytes) -> (Mode, usize) {
    let (mode, count, gate) = {
        let mut fake = fake.lock().unwrap();
        fake.calls.push(Call {
            path: path.into(),
            authorization: headers.get(header::AUTHORIZATION).map(|value| value.to_str().unwrap().to_owned()),
            content_type: headers
                .get(header::CONTENT_TYPE)
                .map(|value| value.to_str().unwrap().to_owned())
                .unwrap_or_default(),
            body: body.to_vec(),
        });
        (fake.mode, fake.calls.len(), fake.gate.clone())
    };
    if let Some(gate) = gate {
        gate.acquire().await.unwrap().forget();
    }
    if mode == Mode::Slow {
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    (mode, count)
}

async fn responses(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap();
    let message = |content: Value| {
        Json(json!({"id": "resp_1", "object": "response", "status": "completed", "model": request["model"],
            "output": [{"type": "reasoning", "summary": []}, {"type": "message", "role": "assistant", "content": [content]}],
            "usage": {"input_tokens": 1200, "output_tokens": 3400}}))
        .into_response()
    };
    match answer(&fake, "/v1/responses", &headers, body).await.0 {
        Mode::Write => {
            message(json!({"type": "output_text", "text": written(&request).to_string(), "annotations": []}))
        }
        Mode::Refuse => message(json!({"type": "refusal", "refusal": "I'm sorry, I can't help with that."})),
        Mode::BadJson => message(json!({"type": "output_text", "text": "{\"saju\": {\"summary\": \"끊긴"})),
        Mode::Fail | Mode::Slow => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                json!({"error": {"code": "server_error", "type": "server_error", "message": "boom sk-test-****abcd"}}),
            ),
        )
            .into_response(),
    }
}

async fn edits(State(fake): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    match answer(&fake, "/v1/images/edits", &headers, body).await {
        (Mode::Write, count) => {
            let picture = STANDARD.encode(webp(format!("picture {count}").as_bytes()));
            Json(json!({"created": 1, "data": [{"b64_json": picture}], "usage": {"total_tokens": 5000}}))
                .into_response()
        }
        (Mode::Refuse, _) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {"code": "moderation_blocked", "type": "image_generation_user_error",
                "message": "Your request was rejected by the safety system."}})),
        )
            .into_response(),
        (Mode::BadJson, _) => Json(json!({"created": 1, "data": []})).into_response(),
        (Mode::Fail | Mode::Slow, _) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": {"code": null, "type": "server_error"}})))
                .into_response()
        }
    }
}

/// The stand-in, listening; its base URL and what it keeps.
async fn stand_in() -> (String, Shared) {
    let fake = Arc::new(Mutex::new(Fake { mode: Mode::Write, calls: Vec::new(), gate: None }));
    let app = Router::new()
        .route("/v1/responses", post(responses))
        .route("/v1/images/edits", post(edits))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, fake)
}

fn settings(url: &str) -> OpenAi {
    OpenAi {
        api_key: Some("sk-test-key".into()),
        base_url: url.into(),
        reading_timeout: Duration::from_secs(2),
        picture_timeout: Duration::from_secs(2),
        ..OpenAi::default()
    }
}

async fn app_with(change: impl FnOnce(&mut OpenAi)) -> (TestApp, Shared) {
    let (url, fake) = stand_in().await;
    let mut openai = settings(&url);
    change(&mut openai);
    (TestApp::with_openai(openai).await, fake)
}

fn mode(fake: &Shared, mode: Mode) {
    fake.lock().unwrap().mode = mode;
}

fn calls(fake: &Shared) -> usize {
    fake.lock().unwrap().calls.len()
}

fn chart() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

/// Signs `name` up and builds their home from `birth`; their cookie and id.
async fn member(app: &TestApp, name: &str, birth: &Value) -> (String, uuid::Uuid) {
    let cookie = app.register(name, "주민").await;
    let id = app.user_id(name).await;
    build(app, &cookie, id, birth).await;
    (cookie, id)
}

async fn build(app: &TestApp, cookie: &str, id: uuid::Uuid, birth: &Value) {
    let body = json!({"expectedOwnerId": id, "name": "솔", "birth": birth});
    let built = app.call("PUT", "/api/homes/me/saju", Some(body), Some(cookie)).await;
    assert_eq!(built.status, StatusCode::OK, "{:?}", built.body);
}

async fn ask(app: &TestApp, cookie: &str, id: uuid::Uuid, chart: &Value, again: bool) -> Reply {
    let body = json!({"expectedOwnerId": id, "chart": chart, "again": again});
    app.call("POST", "/api/homes/me/saju/reading", Some(body), Some(cookie)).await
}

async fn draw(app: &TestApp, cookie: &str, id: uuid::Uuid, image: &str, again: bool) -> Reply {
    let body = json!({"expectedOwnerId": id, "image": image, "again": again});
    app.call("POST", "/api/homes/me/saju/picture", Some(body), Some(cookie)).await
}

/// What `username`'s home shows of `kind` once it is no longer pending.
async fn settled(app: &TestApp, username: &str, kind: &str, cookie: Option<&str>) -> Value {
    let path = format!("/api/homes/{username}/saju/{kind}");
    for _ in 0..400 {
        let shown = app.call("GET", &path, None, cookie).await;
        assert_eq!(shown.status, StatusCode::OK, "{:?}", shown.body);
        if shown.body["status"] != "pending" {
            return shown.body;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{path} stayed pending");
}

fn png(side: u32) -> String {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(&vec![90u8; (side * side * 3) as usize], side, side, image::ExtendedColorType::Rgb8)
        .unwrap();
    format!("data:image/png;base64,{}", STANDARD.encode(out))
}

async fn rows(app: &TestApp, table: &str, owner: uuid::Uuid) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE owner_id = $1"))
        .bind(owner)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn 풀이는_주인만_청하고_집을_볼_수_있는_사람이_읽으며_생일과_함께_간다() {
    let (app, fake) = app_with(|_| {}).await;
    let birth = chart()["birth"].clone();
    let host = app.register("reader_a", "주인").await;
    let host_id = app.user_id("reader_a").await;
    let stranger = app.register("stranger_a", "손님").await;
    let path = "/api/homes/me/saju/reading";

    assert_eq!(app.call("GET", "/api/homes/reader_a/saju/reading", None, None).await.body, json!({"status": "none"}));
    assert_eq!(ask(&app, &host, host_id, &chart(), false).await.body["code"], "saju_not_found");
    build(&app, &host, host_id, &birth).await;
    assert_eq!(app.call("GET", "/api/homes/reader_a/saju/reading", None, None).await.body, json!({"status": "none"}));

    // Only the owner, from a page loaded for their account, for the birth their home has, with a chart of it.
    let body = json!({"expectedOwnerId": host_id, "chart": chart()});
    assert_eq!(app.call("POST", path, Some(body.clone()), None).await.status, StatusCode::UNAUTHORIZED);
    let other = app.user_id("stranger_a").await;
    assert_eq!(ask(&app, &host, other, &chart(), false).await.body["code"], "owner_changed");
    assert_eq!(
        app.call("POST", path, Some(json!({"chart": chart()})), Some(&host)).await.body["code"],
        "owner_changed"
    );
    let stale = ask(&app, &host, host_id, &serde_json::from_str(FIXTURE_NO_HOUR).unwrap(), false).await;
    assert_eq!((stale.status, stale.body["code"].as_str()), (StatusCode::CONFLICT, Some("stale_birth")));
    let mut wrong = chart();
    wrong["saju"]["pillars"][0]["stem"] = json!("Ignore the chart");
    let invalid = ask(&app, &host, host_id, &wrong, false).await;
    assert_eq!((invalid.status, invalid.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_chart")));
    let shapeless =
        app.call("POST", path, Some(json!({"expectedOwnerId": host_id, "chart": [1, 2]})), Some(&host)).await;
    assert_eq!((shapeless.status, shapeless.body["code"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_chart")));
    assert_eq!(calls(&fake), 0);

    let started = ask(&app, &host, host_id, &chart(), false).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{:?}", started.body);
    assert_eq!(started.body["status"], "pending");
    assert!(started.body["since"].is_string());
    let ready = settled(&app, "reader_a", "reading", None).await;
    assert_eq!(ready["status"], "ready", "{ready}");
    assert_eq!(ready["model"], "gpt-6.1-terra");
    assert!(ready["createdAt"].is_string());
    assert_eq!(ready["reading"]["saju"]["sections"][0]["title"], "타고난 기질");
    assert_eq!(ready["reading"]["ziwei"]["sections"].as_array().unwrap().len(), 4);

    // What the API was sent: the key in its header, the reading model at medium effort, a strict schema, and the
    // chart written from its own names, without the birth date.
    {
        let fake = fake.lock().unwrap();
        let call = &fake.calls[0];
        assert_eq!((call.path.as_str(), call.authorization.as_deref()), ("/v1/responses", Some("Bearer sk-test-key")));
        assert_eq!(call.content_type, "application/json");
        let sent: Value = serde_json::from_slice(&call.body).unwrap();
        assert_eq!(sent["model"], "gpt-6.1-terra");
        assert_eq!(sent["reasoning"]["effort"], "medium");
        assert_eq!(sent["text"]["format"]["type"], "json_schema");
        assert_eq!(sent["text"]["format"]["strict"], true);
        assert_eq!(sent["input"][0]["role"], "developer");
        let chart_text = sent["input"][1]["content"].as_str().unwrap();
        assert!(chart_text.contains("- 일주 甲寅(갑인)") && chart_text.contains("- 명궁 (정묘"), "{chart_text}");
        assert!(!String::from_utf8_lossy(&call.body).contains("1989"));
    }

    // Asked again without `again`: the reading already written, and no other call.
    let kept = ask(&app, &host, host_id, &chart(), false).await;
    assert_eq!((kept.status, &kept.body), (StatusCode::OK, &ready));
    assert_eq!(calls(&fake), 1);

    // A home kept to 이웃 shows its reading only to those who may see the home.
    app.call("PATCH", "/api/homes/me", Some(json!({"visibility": "ilchon"})), Some(&host)).await;
    assert_eq!(app.call("GET", "/api/homes/reader_a/saju/reading", None, None).await.status, StatusCode::FORBIDDEN);
    let closed = app.call("GET", "/api/homes/reader_a/saju/reading", None, Some(&stranger)).await;
    assert_eq!(closed.status, StatusCode::FORBIDDEN);
    assert_eq!(app.call("GET", "/api/homes/nobody_here/saju/reading", None, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(settled(&app, "reader_a", "reading", Some(&host)).await["status"], "ready");

    // Three readings again within a day, then the member waits.
    for round in 0..3 {
        let again = ask(&app, &host, host_id, &chart(), true).await;
        assert_eq!(again.status, StatusCode::ACCEPTED, "{round}: {:?}", again.body);
        assert_eq!(settled(&app, "reader_a", "reading", Some(&host)).await["status"], "ready");
    }
    let limited = ask(&app, &host, host_id, &chart(), true).await;
    assert_eq!((limited.status, limited.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("reading_limit")));
    assert_eq!(calls(&fake), 4);

    // Built again under another name it keeps its reading; from another birth it has none, and none is kept.
    let body = json!({"expectedOwnerId": host_id, "name": "새 이름", "birth": birth});
    app.call("PUT", "/api/homes/me/saju", Some(body), Some(&host)).await;
    assert_eq!(settled(&app, "reader_a", "reading", Some(&host)).await["status"], "ready");
    let no_hour: Value = serde_json::from_str(FIXTURE_NO_HOUR).unwrap();
    build(&app, &host, host_id, &no_hour["birth"]).await;
    assert_eq!(settled(&app, "reader_a", "reading", Some(&host)).await, json!({"status": "none"}));
    assert_eq!(rows(&app, "saju_readings", host_id).await, 0);

    // A chart without a 명반 gets a reading without one; taking the home down takes the reading with it.
    let started = ask(&app, &host, host_id, &no_hour, true).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{:?}", started.body);
    let ready = settled(&app, "reader_a", "reading", Some(&host)).await;
    assert_eq!(ready["reading"]["ziwei"], Value::Null, "{ready}");
    let removal = json!({"expectedOwnerId": host_id});
    assert_eq!(
        app.call("DELETE", "/api/homes/me/saju", Some(removal), Some(&host)).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(settled(&app, "reader_a", "reading", Some(&host)).await, json!({"status": "none"}));
    assert_eq!(rows(&app, "saju_readings", host_id).await, 0);
    app.cleanup().await;
}

#[tokio::test]
async fn 풀이가_실패하면_서버의_말로_까닭을_알리고_다시_청할_수_있다() {
    let (app, fake) = app_with(|_| {}).await;
    let (host, host_id) = member(&app, "reader_b", &chart()["birth"]).await;
    for (answer, code) in [
        (Mode::Refuse, "refused"),
        (Mode::BadJson, "bad_output"),
        (Mode::Fail, "provider_unavailable"),
        (Mode::Slow, "timeout"),
    ] {
        mode(&fake, answer);
        let started = ask(&app, &host, host_id, &chart(), false).await;
        assert_eq!(started.status, StatusCode::ACCEPTED, "{answer:?}: {:?}", started.body);
        let failed = settled(&app, "reader_b", "reading", None).await;
        assert_eq!((failed["status"].as_str(), failed["code"].as_str()), (Some("failed"), Some(code)), "{failed}");
        let message = failed["message"].as_str().unwrap();
        assert!(message.contains("풀이") && !message.contains("sorry") && !message.contains("boom"), "{message}");
    }
    // None of those was a reading made, so asking once more is no `again`.
    mode(&fake, Mode::Write);
    assert_eq!(ask(&app, &host, host_id, &chart(), false).await.status, StatusCode::ACCEPTED);
    assert_eq!(settled(&app, "reader_b", "reading", None).await["status"], "ready");
    let agains: i64 = sqlx::query_scalar("SELECT count(*) FROM saju_paid_calls WHERE owner_id = $1 AND again")
        .bind(host_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!((agains, calls(&fake)), (0, 5));
    app.cleanup().await;
}

#[tokio::test]
async fn 하나가_만들어지는_동안에는_다시_청해도_그것을_기다린다() {
    let (app, fake) = app_with(|_| {}).await;
    let (host, host_id) = member(&app, "reader_c", &chart()["birth"]).await;
    let gate = Arc::new(Semaphore::new(0));
    fake.lock().unwrap().gate = Some(gate.clone());
    let started = ask(&app, &host, host_id, &chart(), false).await;
    assert_eq!(started.status, StatusCode::ACCEPTED);
    for again in [false, true] {
        let waiting = ask(&app, &host, host_id, &chart(), again).await;
        assert_eq!((waiting.status, &waiting.body), (StatusCode::OK, &started.body));
    }
    gate.add_permits(1);
    assert_eq!(settled(&app, "reader_c", "reading", None).await["status"], "ready");
    assert_eq!(calls(&fake), 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 서버가_다시_시작되어_끊긴_것은_실패로_읽히고_다시_청할_수_있다() {
    let (app, fake) = app_with(|_| {}).await;
    let (host, host_id) = member(&app, "reader_d", &chart()["birth"]).await;
    // The fixture's birth, as the server keys what it makes for a home.
    let key = "solar:1989-02-23:plain:22:10:female";
    let pending = |minutes: i32| {
        let db = app.state.db.clone();
        async move {
            sqlx::query(
                "INSERT INTO saju_readings (owner_id, birth_key, attempt, status, model, started_at)
                 VALUES ($1, $2, gen_random_uuid(), 'pending', 'gpt-6.1-terra', now() - make_interval(mins => $3))
                 ON CONFLICT (owner_id) DO UPDATE SET status = 'pending', attempt = excluded.attempt,
                 started_at = excluded.started_at",
            )
            .bind(host_id)
            .bind(key)
            .bind(minutes)
            .execute(&db)
            .await
            .unwrap();
        }
    };
    // Left pending for longer than any work takes: it was cut short.
    pending(11).await;
    let shown = app.call("GET", "/api/homes/reader_d/saju/reading", None, None).await.body;
    assert_eq!((shown["status"].as_str(), shown["code"].as_str()), (Some("failed"), Some("interrupted")), "{shown}");
    assert!(shown["message"].as_str().unwrap().contains("다시 시작"));
    // Still pending a minute in, it is taken to be under way.
    pending(1).await;
    assert_eq!(app.call("GET", "/api/homes/reader_d/saju/reading", None, None).await.body["status"], "pending");
    assert_eq!(ask(&app, &host, host_id, &chart(), false).await.status, StatusCode::OK);
    // A server that starts marks what the last one left pending as failed.
    assert_eq!(saju_made::interrupt_unfinished(&app.state.db).await.unwrap(), 1);
    assert_eq!(settled(&app, "reader_d", "reading", None).await["code"], "interrupted");
    assert_eq!(ask(&app, &host, host_id, &chart(), false).await.status, StatusCode::ACCEPTED);
    assert_eq!(settled(&app, "reader_d", "reading", None).await["status"], "ready");
    assert_eq!(calls(&fake), 1);
    app.cleanup().await;
}

#[tokio::test]
async fn 키가_없거나_한_달_예산을_다_쓰면_풀이도_그림도_받을_수_없다() {
    let (app, fake) = app_with(|openai| openai.api_key = None).await;
    let (host, host_id) = member(&app, "reader_e", &chart()["birth"]).await;
    let refused = ask(&app, &host, host_id, &chart(), false).await;
    assert_eq!(
        (refused.status, refused.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("reading_unavailable"))
    );
    let refused = draw(&app, &host, host_id, &png(1024), false).await;
    assert_eq!(
        (refused.status, refused.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("picture_unavailable"))
    );
    // The page is told nothing can be made, so it asks for none and does not draw the island to send it.
    assert_eq!(
        app.call("GET", "/api/homes/reader_e/saju/reading", None, None).await.body,
        json!({"status": "none", "off": true})
    );
    assert_eq!(
        app.call("GET", "/api/homes/reader_e/saju/picture", None, None).await.body,
        json!({"status": "none", "off": true})
    );
    assert_eq!(calls(&fake), 0);
    app.cleanup().await;

    let (app, fake) = app_with(|openai| {
        openai.readings_monthly = 1;
        openai.pictures_monthly = 1;
    })
    .await;
    let (first, first_id) = member(&app, "reader_f", &chart()["birth"]).await;
    let (second, second_id) = member(&app, "reader_g", &chart()["birth"]).await;
    assert_eq!(ask(&app, &first, first_id, &chart(), false).await.status, StatusCode::ACCEPTED);
    assert_eq!(draw(&app, &first, first_id, &png(1024), false).await.status, StatusCode::ACCEPTED);
    // The month's budget is the site's: another member is turned away too.
    let spent = ask(&app, &second, second_id, &chart(), false).await;
    assert_eq!(
        (spent.status, spent.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("reading_unavailable"))
    );
    let spent = draw(&app, &second, second_id, &png(1024), false).await;
    assert_eq!(
        (spent.status, spent.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("picture_unavailable"))
    );
    assert_eq!(settled(&app, "reader_f", "reading", None).await["status"], "ready");
    assert_eq!(settled(&app, "reader_f", "picture", None).await["status"], "ready");
    // With the budget spent, a home that has nothing yet is told so; what is made is shown as ever.
    assert_eq!(
        app.call("GET", "/api/homes/reader_g/saju/picture", None, None).await.body,
        json!({"status": "none", "off": true})
    );
    assert_eq!(app.call("GET", "/api/homes/reader_f/saju/picture", None, None).await.body.get("off"), None);
    // What is made stays answerable after the budget is spent.
    assert_eq!(ask(&app, &first, first_id, &chart(), false).await.status, StatusCode::OK);
    let counted: Vec<(String, i32)> = sqlx::query_as("SELECT kind, calls FROM saju_paid_months ORDER BY kind")
        .fetch_all(&app.state.db)
        .await
        .unwrap();
    assert_eq!(counted, [("picture".to_owned(), 1), ("reading".to_owned(), 1)]);
    assert_eq!(calls(&fake), 2);
    app.cleanup().await;

    // A budget of none (a local server's) never calls, key or not.
    let (app, fake) = app_with(|openai| {
        openai.readings_monthly = 0;
        openai.pictures_monthly = 0;
    })
    .await;
    let (host, host_id) = member(&app, "reader_h", &chart()["birth"]).await;
    assert_eq!(app.call("GET", "/api/homes/reader_h/saju/picture", None, None).await.body["off"], true);
    assert_eq!(ask(&app, &host, host_id, &chart(), false).await.body["code"], "reading_unavailable");
    assert_eq!(draw(&app, &host, host_id, &png(1024), false).await.body["code"], "picture_unavailable");
    let counted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM saju_paid_calls").fetch_one(&app.state.db).await.unwrap();
    assert_eq!((counted, calls(&fake)), (0, 0));
    app.cleanup().await;
}

fn stored(app: &TestApp, url: &str) -> std::path::PathBuf {
    app.model_dir.join(url.strip_prefix("/models/").unwrap())
}

fn age(app: &TestApp, url: &str) {
    let file = std::fs::File::options().write(true).open(stored(app, url)).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60)).unwrap();
}

#[tokio::test]
async fn 섬_그림은_1024_섬만_받아_다시_그리고_그린_그림은_치우지_않는다() {
    let (app, fake) = app_with(|_| {}).await;
    let (host, host_id) = member(&app, "painter_a", &chart()["birth"]).await;
    let path = "/api/homes/me/saju/picture";
    assert_eq!(app.call("GET", "/api/homes/painter_a/saju/picture", None, None).await.body, json!({"status": "none"}));

    // Exactly 1024 on a side, of the kind it says, base64 in a data URL, at most 3 MB.
    let invalid = Some((StatusCode::BAD_REQUEST, "invalid_image"));
    let refusal = |reply: Reply| Some((reply.status, reply.body["code"].as_str().unwrap_or_default().to_owned()));
    let code = |expected: Option<(StatusCode, &str)>| expected.map(|(status, code)| (status, code.to_owned()));
    assert_eq!(refusal(draw(&app, &host, host_id, &png(512), false).await), code(invalid));
    assert_eq!(
        refusal(draw(&app, &host, host_id, &png(1024).replace("image/png", "image/webp"), false).await),
        code(invalid)
    );
    assert_eq!(
        refusal(draw(&app, &host, host_id, &png(1024).replace("image/png", "image/gif"), false).await),
        code(invalid)
    );
    assert_eq!(refusal(draw(&app, &host, host_id, "data:image/png;base64,@@@@", false).await), code(invalid));
    let shapeless = app.call("POST", path, Some(json!({"expectedOwnerId": host_id, "image": 5})), Some(&host)).await;
    assert_eq!(refusal(shapeless), code(invalid));
    let huge = format!("data:image/png;base64,{}", STANDARD.encode(vec![0u8; 3 * 1024 * 1024 + 3]));
    assert_eq!(
        refusal(draw(&app, &host, host_id, &huge, false).await),
        code(Some((StatusCode::PAYLOAD_TOO_LARGE, "image_too_large")))
    );
    let other = app.register("painter_x", "손님").await;
    assert_eq!(draw(&app, &other, host_id, &png(1024), false).await.body["code"], "owner_changed");
    assert_eq!(
        draw(&app, &other, app.user_id("painter_x").await, &png(1024), false).await.body["code"],
        "saju_not_found"
    );
    assert_eq!(calls(&fake), 0);

    let started = draw(&app, &host, host_id, &png(1024), false).await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{:?}", started.body);
    let ready = settled(&app, "painter_a", "picture", None).await;
    assert_eq!(ready["status"], "ready", "{ready}");
    assert_eq!(
        (ready["model"].as_str(), ready["width"].as_u64(), ready["height"].as_u64()),
        (Some("gpt-image-2.6-sunburst"), Some(1024), Some(1024))
    );
    let first = ready["url"].as_str().unwrap().to_owned();
    assert!(first.starts_with("/models/") && first.ends_with(".webp"), "{first}");
    let served =
        app.send(Request::builder().uri(&first).header(header::ORIGIN, ORIGIN).body(Body::empty()).unwrap()).await;
    assert_eq!((served.status, served.headers[header::CONTENT_TYPE].to_str().unwrap()), (StatusCode::OK, "image/webp"));
    assert_eq!(served.bytes, webp(b"picture 1"));
    // What the API was sent: a multipart edit of the island with the picture model, size, quality and format.
    {
        let fake = fake.lock().unwrap();
        let call = &fake.calls[0];
        assert_eq!(
            (call.path.as_str(), call.authorization.as_deref()),
            ("/v1/images/edits", Some("Bearer sk-test-key"))
        );
        assert!(call.content_type.starts_with("multipart/form-data; boundary="));
        let body = String::from_utf8_lossy(&call.body);
        for field in [
            "name=\"model\"\r\n\r\ngpt-image-2.6-sunburst\r\n",
            "name=\"size\"\r\n\r\n1024x1024\r\n",
            "name=\"quality\"\r\n\r\nhigh\r\n",
            "name=\"output_format\"\r\n\r\nwebp\r\n",
            "name=\"image\"; filename=\"island.png\"\r\nContent-Type: image/png\r\n\r\n\u{fffd}PNG",
        ] {
            assert!(body.contains(field), "{field}");
        }
        assert!(body.contains("visual novel") && body.contains("No people"));
    }

    // Asked without `again`: the picture already drawn. Drawn again, the earlier file is no longer kept by the home.
    assert_eq!(draw(&app, &host, host_id, &png(1024), false).await.body, ready);
    assert_eq!(draw(&app, &host, host_id, &png(1024), true).await.status, StatusCode::ACCEPTED);
    let again = settled(&app, "painter_a", "picture", None).await;
    let second = again["url"].as_str().unwrap().to_owned();
    assert_ne!(first, second);
    age(&app, &first);
    age(&app, &second);
    let models = &app.state.config.models;
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 1);
    assert!(!stored(&app, &first).exists() && stored(&app, &second).exists(), "the sweep keeps the home's picture");
    // Two pictures again within a month.
    assert_eq!(draw(&app, &host, host_id, &png(1024), true).await.status, StatusCode::ACCEPTED);
    assert_eq!(settled(&app, "painter_a", "picture", None).await["status"], "ready");
    let limited = draw(&app, &host, host_id, &png(1024), true).await;
    assert_eq!((limited.status, limited.body["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("picture_limit")));

    // Taking the home down takes its picture, and the sweep its file.
    let third = settled(&app, "painter_a", "picture", None).await["url"].as_str().unwrap().to_owned();
    let removal = json!({"expectedOwnerId": host_id});
    assert_eq!(
        app.call("DELETE", "/api/homes/me/saju", Some(removal), Some(&host)).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(rows(&app, "saju_pictures", host_id).await, 0);
    age(&app, &third);
    assert_eq!(models.sweep(&app.state.db, SWEEP_AGE).await.unwrap(), 2);
    app.cleanup().await;
}

#[tokio::test]
async fn 그림이_실패하면_서버의_말로_까닭을_알린다() {
    let (app, fake) = app_with(|_| {}).await;
    let (host, host_id) = member(&app, "painter_b", &chart()["birth"]).await;
    for (answer, code) in [
        (Mode::Refuse, "refused"),
        (Mode::BadJson, "bad_output"),
        (Mode::Fail, "provider_unavailable"),
        (Mode::Slow, "timeout"),
    ] {
        mode(&fake, answer);
        assert_eq!(draw(&app, &host, host_id, &png(1024), false).await.status, StatusCode::ACCEPTED, "{answer:?}");
        let failed = settled(&app, "painter_b", "picture", None).await;
        assert_eq!((failed["status"].as_str(), failed["code"].as_str()), (Some("failed"), Some(code)), "{failed}");
        let message = failed["message"].as_str().unwrap();
        assert!(message.contains("그림") && !message.contains("safety"), "{message}");
    }
    app.cleanup().await;
}
