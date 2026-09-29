#![allow(dead_code)]

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use mogaesup_server::{AppState, MIGRATOR, config::Config, config::Factory, models::Models, router};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::path::PathBuf;
use tower::ServiceExt;

pub const ORIGIN: &str = "http://test.local";
pub const TICKET_SECRET: &[u8] = b"test-realtime-ticket-secret-of-32-bytes";

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
        let db = TestDb::create().await;
        MIGRATOR.run(&db.pool).await.unwrap();
        let model_dir = std::env::temp_dir().join(&db.name);
        let config = Config {
            origins: vec![ORIGIN.into()],
            cookie_secure: false,
            ticket_secret: TICKET_SECRET.to_vec(),
            models: Models::open(model_dir.to_str().unwrap()).unwrap(),
            factory,
        };
        let state = AppState::new(db.pool.clone(), config);
        Self { router: router(state.clone()), state, model_dir, db }
    }

    pub async fn cleanup(self) {
        self.db.remove().await;
        let _ = std::fs::remove_dir_all(&self.model_dir);
    }

    pub async fn call(&self, method: &str, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut request = Request::builder().method(method).uri(path).header(header::ORIGIN, ORIGIN);
        if method != "GET" {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
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
        reply.cookie.expect("session cookie")
    }

    pub async fn make_admin(&self, username: &str) {
        sqlx::query("UPDATE users SET role = 'admin' WHERE username = $1")
            .bind(username)
            .execute(&self.state.db)
            .await
            .unwrap();
    }
}
