mod common;

use axum::{
    Json, Router,
    body::Bytes,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{get, post, put},
};
use common::TestApp;
use mogaesup_server::{
    config::{Factory, FactoryAccess, StudioInstance},
    studio_power::{Credentials, Signable, authorization},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const INSTANCE: &str = "i-0123456789abcdef0";
const REGION: &str = "ap-northeast-2";
const IMDS_TOKEN: &str = "imds-session-token";
const ROLE: &str = "mogaesup-server-role";
const KEY_ID: &str = "ASIAEXAMPLEKEYID";
const SECRET: &str = "example/secret+key";
const SESSION: &str = "example-session-token";
const WARDROBE: &str = "/api/avatar-factory/wardrobe/bodies";
const POWER: &str = "/api/catalog/admin/studio-power";

#[derive(Default)]
struct Ec2 {
    state: String,
    /// EC2 actions in the order they arrived.
    actions: Vec<String>,
    /// Role credential reads from instance metadata.
    credential_reads: usize,
    /// Requests whose SigV4 signature did not match.
    bad_signatures: usize,
    /// StartInstances is refused, as for a role without the permission.
    refuse_start: bool,
}

#[derive(Clone)]
struct FakeAws(Arc<Mutex<Ec2>>);

impl FakeAws {
    fn new(state: &str) -> Self {
        Self(Arc::new(Mutex::new(Ec2 { state: state.into(), ..Ec2::default() })))
    }
    fn set(&self, state: &str) {
        self.0.lock().unwrap().state = state.into();
    }
    fn actions(&self) -> Vec<String> {
        self.0.lock().unwrap().actions.clone()
    }
}

fn ec2_error(code: &str) -> axum::response::Response {
    let body = format!("<Response><Errors><Error><Code>{code}</Code><Message>no</Message></Error></Errors></Response>");
    (StatusCode::UNAUTHORIZED, body).into_response()
}

/// Instance metadata (IMDSv2, one role) and the EC2 Query API for one instance, checking every signature.
async fn fake_aws(aws: FakeAws) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let host = base.trim_start_matches("http://").to_owned();
    let token_ok = |headers: &HeaderMap| headers.get("x-aws-ec2-metadata-token").is_some_and(|v| v == IMDS_TOKEN);
    let reads = aws.clone();
    let app = Router::new()
        .route(
            "/latest/api/token",
            put(|headers: HeaderMap| async move {
                if headers.contains_key("x-aws-ec2-metadata-token-ttl-seconds") {
                    IMDS_TOKEN.into_response()
                } else {
                    StatusCode::BAD_REQUEST.into_response()
                }
            }),
        )
        .route(
            "/latest/meta-data/iam/security-credentials/",
            get(move |headers: HeaderMap| async move {
                if token_ok(&headers) { format!("{ROLE}\n").into_response() } else { StatusCode::UNAUTHORIZED.into_response() }
            }),
        )
        .route(
            &format!("/latest/meta-data/iam/security-credentials/{ROLE}"),
            get(move |headers: HeaderMap| async move {
                if !token_ok(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                reads.0.lock().unwrap().credential_reads += 1;
                let expires = (chrono::Utc::now() + chrono::TimeDelta::hours(6)).to_rfc3339();
                Json(json!({"Code": "Success", "Type": "AWS-HMAC", "AccessKeyId": KEY_ID, "SecretAccessKey": SECRET,
                    "Token": SESSION, "Expiration": expires}))
                .into_response()
            }),
        )
        .route(
            "/",
            post(move |headers: HeaderMap, body: Bytes| {
                let (aws, host) = (aws.clone(), host.clone());
                async move {
                    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
                    let date = get("x-amz-date");
                    let signed = [
                        ("content-type", get("content-type")),
                        ("host", host.clone()),
                        ("x-amz-date", date.clone()),
                        ("x-amz-security-token", get("x-amz-security-token")),
                    ];
                    let signed: Vec<(&str, &str)> = signed.iter().map(|(name, value)| (*name, value.as_str())).collect();
                    let credentials = Credentials {
                        access_key_id: KEY_ID.into(),
                        secret_access_key: SECRET.into(),
                        session_token: Some(SESSION.into()),
                        expires: None,
                    };
                    let request = Signable { method: "POST", path: "/", query: "", headers: &signed, payload: &body };
                    let mut ec2 = aws.0.lock().unwrap();
                    if get("authorization") != authorization(&credentials, REGION, "ec2", &request, &date) {
                        ec2.bad_signatures += 1;
                        return ec2_error("AuthFailure");
                    }
                    let form = String::from_utf8_lossy(&body).into_owned();
                    let fields: Vec<&str> = form.split('&').collect();
                    if !fields.contains(&format!("InstanceId.1={INSTANCE}").as_str()) || !fields.contains(&"Version=2016-11-15") {
                        return ec2_error("InvalidParameterValue");
                    }
                    let action = fields.iter().find_map(|field| field.strip_prefix("Action=")).unwrap_or_default();
                    ec2.actions.push(action.to_owned());
                    match action {
                        "DescribeInstances" => format!(
                            "<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>{INSTANCE}\
                             </instanceId><instanceState><code>0</code><name>{}</name></instanceState></item>\
                             </instancesSet></item></reservationSet></DescribeInstancesResponse>",
                            ec2.state
                        )
                        .into_response(),
                        "StartInstances" if ec2.refuse_start => ec2_error("UnauthorizedOperation"),
                        "StartInstances" => {
                            let previous = ec2.state.clone();
                            if previous == "stopped" {
                                ec2.state = "pending".into();
                            }
                            format!(
                                "<StartInstancesResponse><instancesSet><item><instanceId>{INSTANCE}</instanceId>\
                                 <currentState><code>0</code><name>{}</name></currentState><previousState><code>80</code>\
                                 <name>{previous}</name></previousState></item></instancesSet></StartInstancesResponse>",
                                ec2.state
                            )
                            .into_response()
                        }
                        _ => ec2_error("InvalidAction"),
                    }
                }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A port nothing listens on: every request fails to connect, like a studio whose instance is off.
async fn unreachable() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    url
}

/// A character server behind CloudFront: while `down`, CloudFront answers 502 for it.
async fn flapping_factory(down: Arc<AtomicBool>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(move || {
        let down = down.clone();
        async move {
            if down.load(Ordering::SeqCst) {
                (StatusCode::BAD_GATEWAY, [(header::CONTENT_TYPE, "text/html")], "<h1>502 ERROR</h1> CloudFront")
                    .into_response()
            } else {
                Json(json!({"ok": true})).into_response()
            }
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn factory(url: String, aws: Option<&str>) -> Factory {
    Factory {
        url,
        api_key: None,
        token: None,
        access: FactoryAccess::Write,
        paid_monthly: 0,
        gateway_key: None,
        instance: aws.map(|aws| StudioInstance {
            ec2_endpoint: aws.into(),
            imds_url: aws.into(),
            ..StudioInstance::new(INSTANCE, REGION).unwrap()
        }),
    }
}

async fn app_with(url: String, aws: &FakeAws) -> TestApp {
    let endpoint = fake_aws(aws.clone()).await;
    TestApp::new(Some(factory(url, Some(&endpoint)))).await
}

fn checked(aws: &FakeAws) {
    let ec2 = aws.0.lock().unwrap();
    assert_eq!(ec2.bad_signatures, 0, "every EC2 call is signed as AWS checks it");
    assert_eq!(ec2.credential_reads, 1, "role credentials are read once and kept until they near expiry");
}

#[tokio::test]
async fn 꺼진_스튜디오는_요청이_깨우고_켜지는_동안_studio_waking으로_답한다() {
    let aws = FakeAws::new("stopped");
    let app = app_with(unreachable().await, &aws).await;
    let member = app.register("member_w", "회원").await;

    assert_eq!(app.call("GET", WARDROBE, None, None).await.status, StatusCode::UNAUTHORIZED);
    assert!(aws.actions().is_empty(), "a request that is refused anyway never touches EC2");

    let reply = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body, json!({"code": "studio_waking", "message": "스튜디오를 켜는 중이에요. 1~2분 걸려요."}));
    assert_eq!(aws.actions(), ["DescribeInstances", "StartInstances"]);

    // While it boots, requests are answered at once without starting it again.
    let again = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!((again.status, again.body["code"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("studio_waking")));
    assert_eq!(aws.actions().iter().filter(|action| *action == "StartInstances").count(), 1);
    checked(&aws);
    app.cleanup().await;
}

#[tokio::test]
async fn 꺼지는_중이면_studio_stopping으로_답하고_변경은_기록하지_않는다() {
    let aws = FakeAws::new("stopping");
    let app = app_with(unreachable().await, &aws).await;
    let admin = app.register("operator_w", "운영자").await;
    app.make_admin("operator_w").await;

    let reply = app.call("GET", WARDROBE, None, Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body["code"], "studio_stopping");
    let write = app.call("PUT", "/api/avatar-factory/wardrobe/outfits/mine", Some(json!({})), Some(&admin)).await;
    assert_eq!(write.body["code"], "studio_stopping");
    let recorded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM factory_requests").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(recorded, 0);
    assert!(!aws.actions().contains(&"StartInstances".to_owned()));
    checked(&aws);
    app.cleanup().await;
}

#[tokio::test]
async fn 켜져_있는데_닿지_않으면_원래_오류를_낸다() {
    let aws = FakeAws::new("running");
    let app = app_with(unreachable().await, &aws).await;
    let member = app.register("member_r", "회원").await;
    let reply = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("factory_unavailable")));
    assert!(!aws.actions().contains(&"StartInstances".to_owned()));
    checked(&aws);
    app.cleanup().await;
}

#[tokio::test]
async fn 켜지는_동안의_게이트웨이_오류는_studio_waking이고_답이_오면_평소대로_돌아간다() {
    let aws = FakeAws::new("stopped");
    let down = Arc::new(AtomicBool::new(true));
    let app = app_with(flapping_factory(down.clone()).await, &aws).await;
    let member = app.register("member_b", "회원").await;

    assert_eq!(app.call("GET", WARDROBE, None, Some(&member)).await.body["code"], "studio_waking");
    // The instance runs, but Docker and the API are not up yet: CloudFront still answers 502.
    aws.set("running");
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let booting = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!(
        (booting.status, booting.body["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("studio_waking"))
    );

    down.store(false, Ordering::SeqCst);
    let up = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!((up.status, up.body["ok"].as_bool()), (StatusCode::OK, Some(true)));
    let asked = aws.actions().len();
    assert_eq!(app.call("GET", WARDROBE, None, Some(&member)).await.status, StatusCode::OK);
    assert_eq!(aws.actions().len(), asked, "once it answers, requests go straight to it");

    // A later failure of a running studio is its own error, passed on as it came.
    down.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let broken = app.call("GET", WARDROBE, None, Some(&member)).await;
    assert_eq!(broken.status, StatusCode::BAD_GATEWAY);
    assert_eq!(broken.body, Value::Null);
    assert_eq!(aws.actions().iter().filter(|action| *action == "StartInstances").count(), 1);
    checked(&aws);
    app.cleanup().await;
}

#[tokio::test]
async fn 관리자만_스튜디오_전원을_보고_켠다() {
    let aws = FakeAws::new("stopped");
    let app = app_with(unreachable().await, &aws).await;
    let member = app.register("member_p", "회원").await;
    let admin = app.register("operator_p", "운영자").await;
    app.make_admin("operator_p").await;

    assert_eq!(app.call("GET", POWER, None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("GET", POWER, None, Some(&member)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.call("POST", POWER, None, Some(&member)).await.status, StatusCode::FORBIDDEN);
    assert!(aws.actions().is_empty());

    let read = app.call("GET", POWER, None, Some(&admin)).await;
    assert_eq!(read.body, json!({"configured": true, "instanceId": INSTANCE, "state": "stopped"}));
    let started = app.call("POST", POWER, None, Some(&admin)).await;
    assert_eq!(started.body, json!({"configured": true, "instanceId": INSTANCE, "state": "pending"}));
    assert_eq!(aws.actions(), ["DescribeInstances", "StartInstances"]);
    // Pressing again while it boots starts nothing new.
    assert_eq!(app.call("POST", POWER, None, Some(&admin)).await.body["state"], "pending");
    assert_eq!(aws.actions().len(), 2);

    aws.set("stopping");
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let refused = app.call("POST", POWER, None, Some(&admin)).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::CONFLICT, Some("studio_stopping")));
    checked(&aws);
    app.cleanup().await;

    // Without an instance (local runs) the studio is always on and there is nothing to start.
    let app = TestApp::new(Some(factory(unreachable().await, None))).await;
    let admin = app.register("operator_l", "운영자").await;
    app.make_admin("operator_l").await;
    assert_eq!(app.call("GET", POWER, None, Some(&admin)).await.body, json!({"configured": false}));
    assert_eq!(app.call("POST", POWER, None, Some(&admin)).await.body["code"], "studio_power_unconfigured");
    let member = app.register("member_l", "회원").await;
    assert_eq!(app.call("GET", WARDROBE, None, Some(&member)).await.body["code"], "factory_unavailable");
    app.cleanup().await;
}

#[tokio::test]
async fn 스튜디오를_켜는_것은_운영자만_하고_보기_권한은_상태만_본다() {
    let aws = FakeAws::new("stopped");
    let app = app_with(unreachable().await, &aws).await;
    let viewer = app.register("viewer_o", "보기").await;
    app.grant("viewer_o", "catalog:mogaesup", "editor").await;
    let operator = app.register("operator_o", "운영").await;
    app.grant("operator_o", "system:mogaesup", "operator").await;

    assert_eq!(app.call("GET", POWER, None, Some(&viewer)).await.body["state"], "stopped");
    let refused = app.call("POST", POWER, None, Some(&viewer)).await;
    assert_eq!((refused.status, refused.body["code"].as_str()), (StatusCode::FORBIDDEN, Some("operator_only")));
    assert!(!aws.actions().contains(&"StartInstances".to_owned()), "a refused press starts nothing");
    let started = app.call("POST", POWER, None, Some(&operator)).await;
    assert_eq!((started.status, started.body["state"].as_str()), (StatusCode::OK, Some("pending")));
    checked(&aws);
    app.cleanup().await;
}

#[tokio::test]
async fn 켜지_못한_스튜디오는_요청마다_다시_켜려_하지_않는다() {
    let aws = FakeAws::new("stopped");
    aws.0.lock().unwrap().refuse_start = true;
    let app = app_with(unreachable().await, &aws).await;
    let member = app.register("member_f", "회원").await;
    let starts = || aws.actions().iter().filter(|action| *action == "StartInstances").count();

    // A burst while the studio is off and cannot be started makes one StartInstances call, not one per request.
    let replies = futures_util::future::join_all((0..5).map(|_| app.call("GET", WARDROBE, None, Some(&member)))).await;
    for reply in &replies {
        assert_eq!((reply.status, reply.body["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("factory_unavailable")));
    }
    assert_eq!(starts(), 1);
    // Later requests, and the operators' button, wait out the retry instead of asking EC2 again.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(app.call("GET", WARDROBE, None, Some(&member)).await.body["code"], "factory_unavailable");
    let admin = app.register("operator_f", "운영자").await;
    app.make_admin("operator_f").await;
    let pressed = app.call("POST", POWER, None, Some(&admin)).await;
    assert_eq!((pressed.status, pressed.body["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("studio_start_failed")));
    assert_eq!(starts(), 1);
    assert_eq!(aws.0.lock().unwrap().bad_signatures, 0);
    app.cleanup().await;
}
