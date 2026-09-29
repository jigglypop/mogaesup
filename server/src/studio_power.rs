//! The character server's EC2 instance powers itself off after two idle hours (backend/infra/idle-stop.sh). This server
//! starts it again when a studio request cannot reach it, and admins can start it by hand. EC2 is called through its
//! Query API, signed with SigV4 using the instance role's credentials from IMDSv2.

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use chrono::{DateTime, TimeDelta, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    AppState,
    auth::require_admin,
    config::StudioInstance,
    error::{ApiError, ApiResult, conflict, not_found},
    security::hmac_sha256,
};

pub const WAKING: ApiError =
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "studio_waking", "스튜디오를 켜는 중이에요. 1~2분 걸려요.");
pub const STOPPING: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "studio_stopping",
    "스튜디오가 꺼지는 중이에요. 다 꺼지면 다시 켜요.",
);
const STOPPING_NOW: ApiError = conflict("studio_stopping", "스튜디오가 꺼지는 중이에요. 다 꺼진 뒤에 켤 수 있어요.");
const UNCONFIGURED: ApiError = not_found("studio_power_unconfigured", "이 서버에는 스튜디오 전원 설정이 없습니다.");
const UNREADABLE: ApiError =
    ApiError::new(StatusCode::BAD_GATEWAY, "studio_power_unavailable", "스튜디오 전원 상태를 읽지 못했습니다.");

/// How long after a start (or after seeing the instance off) a request that cannot reach the studio still means
/// "waking": boot, Docker and the API take one to two minutes.
const WAKE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// The studio powers off only after two idle hours, so it is still on this long after it last answered; past this,
/// requests ask EC2 first instead of waiting out CloudFront's origin timeouts.
const TRUST_ANSWER: Duration = Duration::from_secs(90 * 60);
/// A described state is reused this long, so one page's burst of requests asks EC2 once.
const STATE_TTL: Duration = Duration::from_secs(2);
const EC2_TIMEOUT: Duration = Duration::from_secs(10);
const IMDS_TIMEOUT: Duration = Duration::from_secs(3);
/// Role credentials are fetched again this long before they expire.
const CREDENTIAL_MARGIN: TimeDelta = TimeDelta::minutes(5);
/// Keys without an expiry (never from a role) are still read again after this long.
const CREDENTIAL_FALLBACK: TimeDelta = TimeDelta::minutes(10);
const EC2_VERSION: &str = "2016-11-15";
const FORM: &str = "application/x-www-form-urlencoded; charset=utf-8";

/// AWS access keys: an instance role's temporary ones in production.
#[derive(Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub expires: Option<DateTime<Utc>>,
}

/// One request to sign. `query` must already be canonical (sorted, percent-encoded); every header in `headers` is
/// signed, and they must include `host` and `x-amz-date`.
pub struct Signable<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub payload: &'a [u8],
}

/// SigV4's derived key for one day, region and service.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let key = hmac_sha256(&key, region.as_bytes());
    let key = hmac_sha256(&key, service.as_bytes());
    hmac_sha256(&key, b"aws4_request")
}

/// The `Authorization` header for `request`, signed with AWS Signature Version 4 at `amz_date` (`YYYYMMDDTHHMMSSZ`).
pub fn authorization(
    credentials: &Credentials,
    region: &str,
    service: &str,
    request: &Signable,
    amz_date: &str,
) -> String {
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    headers.sort();
    let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();
    let signed_headers = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        request.method,
        request.path,
        request.query,
        hex::encode(Sha256::digest(request.payload))
    );
    let date = amz_date.get(..8).unwrap_or_default();
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex::encode(Sha256::digest(canonical_request.as_bytes())));
    let signature = hex::encode(hmac_sha256(
        &signing_key(&credentials.secret_access_key, date, region, service),
        string_to_sign.as_bytes(),
    ));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id
    )
}

/// The text between the first `open` and the `close` after it.
fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// The state name inside `block` (`instanceState` in DescribeInstances, `currentState` in StartInstances).
fn state_in(xml: &str, block: &str) -> Option<String> {
    let inner = between(xml, &format!("<{block}>"), &format!("</{block}>"))?;
    between(inner, "<name>", "</name>").map(|name| name.trim().to_owned())
}

#[derive(Debug)]
pub struct PowerError(String);

impl std::fmt::Display for PowerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<reqwest::Error> for PowerError {
    fn from(error: reqwest::Error) -> Self {
        Self(error.to_string())
    }
}

/// What IMDS answers for a role's credentials.
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RoleCredentials {
    code: Option<String>,
    access_key_id: String,
    secret_access_key: String,
    token: Option<String>,
    expiration: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct Marks {
    /// When the instance was last started here or seen off or on its way up.
    woken: Option<Instant>,
    /// When the character server last answered.
    answered: Option<Instant>,
}

struct Inner {
    instance: StudioInstance,
    http: reqwest::Client,
    credentials: tokio::sync::Mutex<Option<Credentials>>,
    /// The last described state; the lock also makes concurrent lookups wait for one call.
    state: tokio::sync::Mutex<Option<(Instant, String)>>,
    marks: Mutex<Marks>,
}

/// The character server's instance as this server sees it; does nothing when `STUDIO_INSTANCE_ID` is unset.
#[derive(Clone, Default)]
pub struct StudioPower(Option<Arc<Inner>>);

impl StudioPower {
    pub fn new(instance: Option<StudioInstance>) -> Self {
        Self(instance.map(|instance| {
            let http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(IMDS_TIMEOUT)
                .build()
                .expect("HTTP client");
            Arc::new(Inner {
                instance,
                http,
                credentials: Default::default(),
                state: Default::default(),
                marks: Default::default(),
            })
        }))
    }

    /// Before a request to the character server: the answer to give instead when it is known to be off (starting it
    /// when stopped), else None to send the request. EC2 is asked only while the studio is waking or has not answered
    /// for a long time, so an ordinary request costs nothing.
    pub async fn before(&self) -> Option<ApiError> {
        let inner = self.0.as_ref()?;
        if !inner.doubtful() {
            return None;
        }
        inner.asleep(false).await
    }

    /// After a request could not reach the character server (no connection, or a 502/504 from its CloudFront): the
    /// answer to give instead when its instance is off or still coming up, else None to report the failure as it is.
    pub async fn after_failure(&self) -> Option<ApiError> {
        self.0.as_ref()?.asleep(true).await
    }

    /// The character server answered.
    pub fn answered(&self) {
        if let Some(inner) = &self.0 {
            let mut marks = inner.marks.lock().unwrap();
            marks.answered = Some(Instant::now());
            marks.woken = None;
        }
    }
}

impl Inner {
    fn waking(marks: &Marks) -> bool {
        marks.woken.is_some_and(|at| at.elapsed() < WAKE_WINDOW)
    }

    fn doubtful(&self) -> bool {
        let marks = self.marks.lock().unwrap();
        Self::waking(&marks) || marks.answered.is_none_or(|at| at.elapsed() >= TRUST_ANSWER)
    }

    fn mark_woken(&self) {
        self.marks.lock().unwrap().woken.get_or_insert_with(Instant::now);
    }

    /// Whether the character server is off or still coming up, starting its instance when stopped. `failed`: a request
    /// just could not reach it, so a running instance started within [`WAKE_WINDOW`] is taken to be still booting.
    async fn asleep(&self, failed: bool) -> Option<ApiError> {
        let state = match self.describe().await {
            Ok(state) => state,
            Err(error) => {
                tracing::warn!(%error, "Could not read the studio instance's state");
                return None;
            }
        };
        match state.as_str() {
            "running" => {
                let mut marks = self.marks.lock().unwrap();
                let waking = Self::waking(&marks);
                if !waking {
                    marks.woken = None;
                }
                (failed && waking).then_some(WAKING)
            }
            "pending" => {
                self.mark_woken();
                Some(WAKING)
            }
            "stopping" => {
                self.mark_woken();
                Some(STOPPING)
            }
            "stopped" => match self.start().await {
                Ok(_) => Some(WAKING),
                Err(error) => {
                    tracing::error!(%error, "Could not start the studio instance");
                    None
                }
            },
            // shutting-down, terminated: nothing here can bring it back.
            _ => None,
        }
    }

    /// The instance's state (`pending`, `running`, `stopping`, `stopped`, …), at most [`STATE_TTL`] old.
    async fn describe(&self) -> Result<String, PowerError> {
        let mut cached = self.state.lock().await;
        if let Some((at, state)) = cached.as_ref()
            && at.elapsed() < STATE_TTL
        {
            return Ok(state.clone());
        }
        let xml = self.call("DescribeInstances").await?;
        let state = state_in(&xml, "instanceState")
            .ok_or_else(|| PowerError(format!("DescribeInstances did not list {}", self.instance.id)))?;
        *cached = Some((Instant::now(), state.clone()));
        Ok(state)
    }

    /// Starts the instance and returns its state after the call (`pending` for a stopped one).
    async fn start(&self) -> Result<String, PowerError> {
        let xml = self.call("StartInstances").await?;
        let state = state_in(&xml, "currentState").unwrap_or_else(|| "pending".into());
        *self.state.lock().await = Some((Instant::now(), state.clone()));
        self.mark_woken();
        tracing::warn!(instance = %self.instance.id, %state, "Started the studio instance");
        Ok(state)
    }

    /// One EC2 Query API action on this instance; the XML answer.
    async fn call(&self, action: &str) -> Result<String, PowerError> {
        let credentials = self.credentials().await?;
        let url = reqwest::Url::parse(&self.instance.ec2_endpoint)
            .map_err(|error| PowerError(format!("STUDIO_EC2_ENDPOINT: {error}")))?;
        let host = url.host_str().ok_or_else(|| PowerError("STUDIO_EC2_ENDPOINT has no host".into()))?;
        let host = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let body = format!("Action={action}&InstanceId.1={}&Version={EC2_VERSION}", self.instance.id);
        let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut headers = vec![("content-type", FORM), ("host", host.as_str()), ("x-amz-date", amz_date.as_str())];
        if let Some(token) = &credentials.session_token {
            headers.push(("x-amz-security-token", token));
        }
        let signable =
            Signable { method: "POST", path: url.path(), query: "", headers: &headers, payload: body.as_bytes() };
        let signature = authorization(&credentials, &self.instance.region, "ec2", &signable, &amz_date);
        let mut request = self.http.post(url.clone()).timeout(EC2_TIMEOUT).header(header::AUTHORIZATION, signature);
        for (name, value) in headers.iter().filter(|(name, _)| *name != "host") {
            request = request.header(*name, *value);
        }
        let response = request.body(body).send().await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            // Expired or revoked keys answer AuthFailure; the next call reads fresh ones.
            *self.credentials.lock().await = None;
            let code = between(&text, "<Code>", "</Code>").unwrap_or("unknown");
            return Err(PowerError(format!("EC2 {action} answered {status}: {code}")));
        }
        Ok(text)
    }

    /// The instance role's credentials from IMDSv2, kept until shortly before they expire.
    async fn credentials(&self) -> Result<Credentials, PowerError> {
        let mut cached = self.credentials.lock().await;
        if let Some(credentials) =
            cached.as_ref().filter(|found| found.expires.is_some_and(|at| at - CREDENTIAL_MARGIN > Utc::now()))
        {
            return Ok(credentials.clone());
        }
        let base = self.instance.imds_url.trim_end_matches('/');
        let session = self
            .http
            .put(format!("{base}/latest/api/token"))
            .header("x-aws-ec2-metadata-token-ttl-seconds", "300")
            .timeout(IMDS_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        let token = session.trim();
        let read = |path: String| async move {
            self.http
                .get(format!("{base}/latest/meta-data/iam/security-credentials/{path}"))
                .header("x-aws-ec2-metadata-token", token)
                .timeout(IMDS_TIMEOUT)
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await
        };
        let roles = read(String::new()).await?;
        let role = String::from_utf8_lossy(&roles).lines().next().map(str::trim).unwrap_or_default().to_owned();
        if role.is_empty() || role.contains('/') {
            return Err(PowerError("the instance has no IAM role".into()));
        }
        let found: RoleCredentials = serde_json::from_slice(&read(role).await?)
            .map_err(|error| PowerError(format!("unreadable role credentials: {error}")))?;
        if found.code.as_deref().is_some_and(|code| code != "Success") {
            return Err(PowerError(format!("role credentials unavailable: {}", found.code.unwrap_or_default())));
        }
        let credentials = Credentials {
            access_key_id: found.access_key_id,
            secret_access_key: found.secret_access_key,
            session_token: found.token.filter(|token| !token.is_empty()),
            expires: Some(found.expiration.unwrap_or_else(|| Utc::now() + CREDENTIAL_FALLBACK + CREDENTIAL_MARGIN)),
        };
        *cached = Some(credentials.clone());
        Ok(credentials)
    }
}

fn unreadable(error: PowerError) -> ApiError {
    tracing::warn!(%error, "Studio power request failed");
    UNREADABLE
}

/// `GET /api/catalog/admin/studio-power`: whether this server can start the studio, and its instance's state.
pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&state, &headers).await?;
    let Some(inner) = state.power.0.as_ref() else {
        return Ok(Json(json!({"configured": false})));
    };
    let current = inner.describe().await.map_err(unreadable)?;
    Ok(Json(json!({"configured": true, "instanceId": inner.instance.id, "state": current})))
}

/// `POST /api/catalog/admin/studio-power`: starts the studio's instance when it is stopped.
pub async fn start(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let admin = require_admin(&state, &headers).await?;
    let inner = state.power.0.as_ref().ok_or(UNCONFIGURED)?;
    let current = inner.describe().await.map_err(unreadable)?;
    let current = match current.as_str() {
        "stopped" => {
            tracing::warn!(user = %admin.username, "Studio start requested");
            inner.start().await.map_err(unreadable)?
        }
        "stopping" => return Err(STOPPING_NOW),
        _ => current,
    };
    Ok(Json(json!({"configured": true, "instanceId": inner.instance.id, "state": current})))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATE: &str = "20150830T123600Z";

    fn example() -> Credentials {
        Credentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
            expires: None,
        }
    }

    fn signature(header: &str) -> &str {
        header.rsplit_once("Signature=").unwrap().1
    }

    /// `get-vanilla` from AWS's SigV4 test suite.
    #[test]
    fn signs_the_get_vanilla_test_vector() {
        let headers = [("Host", "example.amazonaws.com"), ("X-Amz-Date", DATE)];
        let request = Signable { method: "GET", path: "/", query: "", headers: &headers, payload: b"" };
        assert_eq!(
            authorization(&example(), "us-east-1", "service", &request, DATE),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    /// `post-x-www-form-urlencoded` from AWS's SigV4 test suite: a form body like the EC2 Query API's.
    #[test]
    fn signs_the_form_post_test_vector() {
        let headers = [
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Host", "example.amazonaws.com"),
            ("X-Amz-Date", DATE),
        ];
        let request = Signable { method: "POST", path: "/", query: "", headers: &headers, payload: b"Param1=value1" };
        let header = authorization(&example(), "us-east-1", "service", &request, DATE);
        assert!(header.contains("SignedHeaders=content-type;host;x-amz-date,"), "{header}");
        assert_eq!(signature(&header), "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
    }

    /// The IAM `ListUsers` example of AWS's signing documentation, including its derived key.
    #[test]
    fn signs_the_documented_iam_example() {
        assert_eq!(
            hex::encode(signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam")),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
        let headers = [
            ("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"),
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", DATE),
        ];
        let request = Signable {
            method: "GET",
            path: "/",
            query: "Action=ListUsers&Version=2010-05-08",
            headers: &headers,
            payload: b"",
        };
        let header = authorization(&example(), "us-east-1", "iam", &request, DATE);
        assert_eq!(signature(&header), "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    }

    /// An EC2 call with a role's session token signed in, as this module sends it; the signature is botocore's
    /// (1.43) `SigV4Auth` for the same request.
    #[test]
    fn signs_an_ec2_call_with_a_session_token_like_botocore() {
        let credentials = Credentials { session_token: Some("SESSIONTOKEN/EXAMPLE+==".into()), ..example() };
        let headers = [
            ("content-type", FORM),
            ("host", "ec2.ap-northeast-2.amazonaws.com"),
            ("x-amz-date", DATE),
            ("x-amz-security-token", "SESSIONTOKEN/EXAMPLE+=="),
        ];
        let body = b"Action=DescribeInstances&InstanceId.1=i-00381416eff810818&Version=2016-11-15";
        let request = Signable { method: "POST", path: "/", query: "", headers: &headers, payload: body };
        let header = authorization(&credentials, "ap-northeast-2", "ec2", &request, DATE);
        assert!(header.contains("/20150830/ap-northeast-2/ec2/aws4_request, "), "{header}");
        assert!(header.contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,"), "{header}");
        assert_eq!(signature(&header), "e6464188ce6f749bf36da718ba40b7e2dd03931d1eae5f1f9a75534a24373158");
    }

    #[test]
    fn reads_the_state_from_ec2_answers() {
        let described = r#"<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
            <reservationSet><item><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId>
            <keyName>none</keyName><instanceState><code>80</code><name>stopped</name></instanceState>
            <tagSet><item><key>Name</key><value>studio</value></item></tagSet></item></instancesSet></item>
            </reservationSet></DescribeInstancesResponse>"#;
        assert_eq!(state_in(described, "instanceState").as_deref(), Some("stopped"));
        let started = "<StartInstancesResponse><instancesSet><item><currentState><code>0</code><name>pending</name>\
            </currentState><previousState><code>80</code><name>stopped</name></previousState></item></instancesSet>\
            </StartInstancesResponse>";
        assert_eq!(state_in(started, "currentState").as_deref(), Some("pending"));
        assert_eq!(state_in("<Response><Errors/></Response>", "instanceState"), None);
    }
}
