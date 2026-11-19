#![allow(dead_code)]

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use mogaesup_server::{
    AppState, MIGRATOR,
    config::{Config, Factory, FactoryToken, OpenAi},
    models::Models,
    rebac, router,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::path::PathBuf;
use tower::ServiceExt;

pub const ORIGIN: &str = "http://test.local";
pub const TICKET_SECRET: &[u8] = b"test-realtime-ticket-secret-of-32-bytes";

/// Operator token settings for a fake character server: with them, a member's wardrobe read carries a `MEMBER` token
/// as well as its `x-studio-scope` mark.
pub fn factory_token() -> Option<FactoryToken> {
    Some(FactoryToken { key: vec![7; 32], issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 1 })
}

fn admin_url() -> String {
    std::env::var("TEST_ADMIN_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres-dev@127.0.0.1:55432/postgres".into())
}

/// An empty throwaway database on the test PostgreSQL; `remove` drops it.
pub struct TestDb {
    pub name: String,
    pub pool: PgPool,
    admin: PgPool,
}

impl TestDb {
    pub async fn create() -> Self {
        let admin =
            PgPoolOptions::new().max_connections(2).connect(&admin_url()).await.expect("test Postgres on 55432");
        let name = format!("test_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&admin).await.unwrap();
        let url = admin_url().rsplit_once('/').map(|(base, _)| format!("{base}/{name}")).unwrap();
        let pool = PgPoolOptions::new().max_connections(5).connect(&url).await.unwrap();
        Self { name, pool, admin }
    }

    pub async fn remove(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name)).execute(&self.admin).await.unwrap();
    }
}

/// The server on a throwaway database with every migration applied; `cleanup` drops it.
pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub model_dir: PathBuf,
    db: TestDb,
}

pub struct Reply {
    pub status: StatusCode,
    pub cookie: Option<String>,
    pub body: Value,
    pub bytes: Vec<u8>,
    pub headers: axum::http::HeaderMap,
}

impl TestApp {
    pub async fn new(factory: Option<Factory>) -> Self {
        Self::with(factory, OpenAi::default(), |_| {}).await
    }

    /// The server with `tune` applied to its state before its router is made: shorter waits or fewer places, so a
    /// test sees them run out in moments.
    pub async fn tuned(factory: Option<Factory>, tune: impl FnOnce(&mut AppState)) -> Self {
        Self::with(factory, OpenAi::default(), tune).await
    }

    /// The server with `openai` as its OpenAI API settings (a stand-in served in the test, see tests/saju_made.rs).
    pub async fn with_openai(openai: OpenAi) -> Self {
        Self::with(None, openai, |_| {}).await
    }

    async fn with(factory: Option<Factory>, openai: OpenAi, tune: impl FnOnce(&mut AppState)) -> Self {
        let db = TestDb::create().await;
        MIGRATOR.run(&db.pool).await.unwrap();
        let model_dir = std::env::temp_dir().join(&db.name);
        let config = Config {
            origins: vec![ORIGIN.into()],
            cookie_secure: false,
            ticket_secret: TICKET_SECRET.to_vec(),
            models: Models::open(model_dir.to_str().unwrap()).unwrap(),
            model_sweep: false,
            factory,
            openai,
        };
        let mut state = AppState::new(db.pool.clone(), config);
        tune(&mut state);
        Self { router: router(state.clone()), state, model_dir, db }
    }

    pub async fn cleanup(self) {
        self.db.remove().await;
        let _ = std::fs::remove_dir_all(&self.model_dir);
    }

    pub async fn call(&self, method: &str, path: &str, mut body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut request = Request::builder().method(method).uri(path).header(header::ORIGIN, ORIGIN);
        if method != "GET" {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        // App callers bind edits to the account whose page they loaded. Explicit owners are left untouched so
        // regression tests can exercise stale-account requests; raw `send` exercises the required-field contract.
        if ((method == "PUT" && path == "/api/homes/me/world") || (method == "PATCH" && path == "/api/homes/me"))
            && let (Some(value), Some(cookie)) = (body.as_mut(), cookie)
            && value.get("expectedOwnerId").is_none()
        {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header::COOKIE, cookie.parse().unwrap());
            if let Some(user) = mogaesup_server::auth::optional_user(&self.state, &headers).await.unwrap() {
                value["expectedOwnerId"] = json!(user.id);
            }
        }
        let body = match (method, body) {
            ("GET", _) => Body::empty(),
            (_, Some(body)) => Body::from(body.to_string()),
            (_, None) => Body::from("{}"),
        };
        self.send(request.body(body).unwrap()).await
    }

    pub async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let cookie = headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::to_owned);
        let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, cookie, body, bytes, headers }
    }

    /// Signs up and returns the session cookie.
    pub async fn register(&self, username: &str, display_name: &str) -> String {
        let reply = self
            .call(
                "POST",
                "/api/auth/register",
                Some(json!({"username": username, "displayName": display_name, "password": "correct horse battery"})),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
        // Production accounts share a 사주 only after they agree. Tests that read one as a visitor start agreed.
        sqlx::query("UPDATE users SET saju_share_consent_at = now() WHERE username = $1")
            .bind(username)
            .execute(&self.state.db)
            .await
            .unwrap();
        reply.cookie.expect("session cookie")
    }

    /// A member made straight in the database and signed in, without a password anyone can type (and so without the
    /// password hashing a sign-up takes): for tests whose API deadline is too short for that. Returns the cookie.
    pub async fn quick_member(&self, username: &str) -> String {
        let id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, saju_share_consent_at)
             VALUES ($1, $2, $2, 'not a hash', now())",
        )
        .bind(id)
        .bind(username)
        .execute(&self.state.db)
        .await
        .unwrap();
        let token = uuid::Uuid::new_v4().simple().to_string().repeat(2);
        let hash = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(token.as_bytes()));
        sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')")
            .bind(hash)
            .bind(id)
            .execute(&self.state.db)
            .await
            .unwrap();
        format!("mogaesup_session={token}")
    }

    pub async fn user_id(&self, username: &str) -> uuid::Uuid {
        sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(username)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }

    /// Grants `username` the `relation` on `object` (`system:mogaesup`, `group:crew`…), as the server itself.
    pub async fn grant(&self, username: &str, object: &str, relation: &str) {
        let subject = rebac::SubjectRef::user(self.user_id(username).await);
        let tuple = rebac::Tuple::new(rebac::Object::parse(object).unwrap(), relation, subject).unwrap();
        rebac::grant(&self.state.db, &tuple, rebac::Actor::server("test"), "test").await.unwrap();
    }

    pub async fn make_admin(&self, username: &str) {
        self.grant(username, "system:mogaesup", "admin").await;
    }
}
