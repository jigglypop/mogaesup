pub mod auth;
pub mod catalog;
pub mod config;
pub mod error;
pub mod factory;
pub mod glb;
pub mod homes;
pub mod imports;
pub mod models;
pub mod rooms;
pub mod security;
pub mod slim;
pub mod social;
pub mod studio;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    middleware,
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

use crate::{config::Config, error::ApiResult, security::RateTable};

/// Password hashes running at once; argon2 is deliberately heavy.
const HASHING_SLOTS: usize = 2;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub attempts: Arc<Mutex<RateTable>>,
    pub hashing: Arc<Semaphore>,
    pub rooms: rooms::Rooms,
    pub http: reqwest::Client,
    /// Catalog imports copying at once; the rest wait their turn as `queued`.
    pub imports: Arc<Semaphore>,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        Self {
            db,
            config: Arc::new(config),
            attempts: Default::default(),
            hashing: Arc::new(Semaphore::new(HASHING_SLOTS)),
            rooms: rooms::Rooms::default(),
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("HTTP client"),
            imports: Arc::new(Semaphore::new(imports::SLOTS)),
        }
    }
}

pub fn router(state: AppState) -> Router {
    let auth = Router::new()
        .route("/register", post(auth::register))
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/me", get(auth::me))
        .route("/realtime-ticket", post(auth::realtime_ticket))
        .layer(DefaultBodyLimit::max(4096));
    let api = Router::new()
        .nest("/api/auth", auth)
        .route("/api/health", get(health))
        .merge(homes::router())
        .merge(social::router())
        .merge(catalog::router())
        .merge(factory::router())
        .layer(middleware::from_fn_with_state(state.clone(), security::protect))
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());
    // In production CloudFront serves /models/* from S3 and never sends it here.
    let models = Router::new().route("/models/{file}", get(models::serve)).with_state(state.clone());
    api.merge(models).merge(rooms::router(state))
}

async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({"status": "ok", "server": "rust", "database": "postgresql", "rooms": state.rooms.count()})))
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
