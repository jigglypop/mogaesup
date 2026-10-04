pub mod auth;
pub mod catalog;
pub mod config;
pub mod error;
pub mod factory;
pub mod games;
pub mod glb;
mod glb_validation;
mod gltf;
pub mod homes;
pub mod imports;
pub mod look_bake;
pub mod looks;
pub mod models;
pub mod permissions;
pub mod rebac;
pub mod residents;
pub mod rooms;
pub mod runtime;
pub mod security;
pub mod slim;
pub mod social;
pub mod studio;
pub mod studio_power;
#[cfg(test)]
#[path = "../tests/fixtures/character.rs"]
mod test_glb;
pub mod war;

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
use tower_http::compression::{
    CompressionLayer,
    predicate::{DefaultPredicate, NotForContentType, Predicate},
};

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
    /// Minigames on the islands, played by the people in each island's room.
    pub games: games::Games,
    pub http: reqwest::Client,
    /// Catalog imports copying at once; the rest wait their turn as `queued`.
    pub imports: Arc<Semaphore>,
    /// Admission for queued and active wardrobe bakes, acquired before any upstream work.
    pub looks: Arc<Semaphore>,
    /// The character server's instance, started again when it has powered itself off.
    pub power: studio_power::StudioPower,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        let power =
            studio_power::StudioPower::new(config.factory.as_ref().and_then(|factory| factory.instance.clone()));
        Self {
            db,
            config: Arc::new(config),
            attempts: Default::default(),
            hashing: Arc::new(Semaphore::new(HASHING_SLOTS)),
            rooms: rooms::Rooms::default(),
            games: games::Games::default(),
            http: factory::client(),
            imports: Arc::new(Semaphore::new(imports::SLOTS)),
            looks: Arc::new(Semaphore::new(looks::MAX_BAKING)),
            power,
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
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn(auth::deadline));
    // Models and other files pass through as they came, so their length and byte ranges hold.
    let compression = CompressionLayer::new().compress_when(
        DefaultPredicate::new()
            .and(NotForContentType::const_new("model/"))
            .and(NotForContentType::const_new("application/octet-stream")),
    );
    let api = Router::new()
        .nest("/api/auth", auth)
        .route("/api/health", get(health))
        .merge(homes::router())
        .merge(social::router())
        .merge(catalog::router())
        .merge(factory::router())
        .merge(looks::router())
        .merge(permissions::router())
        .layer(middleware::from_fn_with_state(state.clone(), security::protect))
        .layer(compression)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());
    // In production CloudFront serves /models/* from S3 and never sends it here.
    let models = Router::new().route("/models/{file}", get(models::serve)).with_state(state.clone());
    api.merge(models).merge(rooms::router(state.clone())).merge(games::router(state))
}

async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({"status": "ok", "server": "rust", "database": "postgresql", "rooms": state.rooms.count()})))
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
