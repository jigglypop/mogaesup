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
mod openai;
pub mod permissions;
pub mod pets;
pub mod rebac;
pub mod residents;
pub mod rooms;
pub mod runtime;
pub mod saju;
pub mod saju_decor;
mod saju_gifts;
pub mod saju_made;
mod saju_photo_board;
mod saju_reading;
mod saju_terrain;
pub mod security;
pub mod share;
pub mod slim;
pub mod social;
pub mod studio;
pub mod studio_power;
#[cfg(test)]
#[path = "../tests/fixtures/character.rs"]
mod test_glb;
/// The war game's rules, kept but not served: built only with the `war` feature.
#[cfg(feature = "war")]
pub mod war;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tower_http::compression::{
    CompressionLayer,
    predicate::{DefaultPredicate, NotForContentType, Predicate},
};

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
    security::RateTable,
};

/// Password hashes running at once; argon2 is deliberately heavy.
const HASHING_SLOTS: usize = 2;
/// How long an API request may take until its answer starts, its body read included: a request whose body stops
/// coming, or that waits on something stuck, lets go of what it holds. It ends well before CloudFront stops waiting for
/// an answer to start (a minute, frontend/infra/aws-static.yaml), so a request is answered from here, and stops holding
/// anything, before its client is told it timed out; every wait a route has inside it is shorter. The studio's routes
/// keep their own limits (their uploads and downloads run for minutes; a member's wardrobe read has its own, as short),
/// and the realtime sockets are routes of their own.
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(25);
/// The largest JSON body an API route reads, before it knows who sent it; routes that take more read their bodies
/// themselves (island saves, pictures, the studio's uploads). The islands', guestbooks' and permissions' routes take
/// small ones.
const JSON_BODY_LIMIT: usize = 64 * 1024;
const SMALL_JSON_BODY_LIMIT: usize = 8 * 1024;
const TIMED_OUT: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "timeout",
    "요청을 제때 처리하지 못했어요. 잠시 뒤에 다시 시도해 주세요.",
);

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
    /// Island saves under way and island loads kept compressed.
    pub homes: homes::Homes,
    /// Members' wardrobe reads and part downloads waiting for the character server.
    pub wardrobe: factory::Wardrobe,
    /// [`REQUEST_DEADLINE`], unless a test needs a shorter one.
    pub request_deadline: Duration,
    /// Readings and pictures of 사주 homes being made with a paid model.
    pub made: saju_made::Slots,
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
            homes: homes::Homes::default(),
            wardrobe: factory::Wardrobe::default(),
            request_deadline: REQUEST_DEADLINE,
            made: saju_made::Slots::default(),
        }
    }
}

/// `next` within `deadline`, or [`TIMED_OUT`]: whatever the request was waiting for is dropped with it.
pub async fn answer_within(deadline: Duration, request: Request, next: Next) -> Response {
    tokio::time::timeout(deadline, next.run(request)).await.unwrap_or_else(|_| TIMED_OUT.into_response())
}

/// Every API request but the studio's answers within the state's deadline ([`REQUEST_DEADLINE`]).
async fn deadline(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if factory::is_studio_path(request.uri().path()) {
        return next.run(request).await;
    }
    answer_within(state.request_deadline, request, next).await
}

pub fn router(state: AppState) -> Router {
    let auth = Router::new()
        .route("/register", post(auth::register))
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/logout-others", post(auth::logout_others))
        .route("/password", post(auth::change_password))
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
    let small = || DefaultBodyLimit::max(SMALL_JSON_BODY_LIMIT);
    let api = Router::new()
        .nest("/api/auth", auth)
        .route("/api/health", get(health))
        .merge(homes::router().layer(small()))
        .merge(social::router().layer(small()))
        .merge(saju::router().layer(small()))
        .merge(saju_decor::router().layer(small()))
        .merge(saju_gifts::router().layer(small()))
        .merge(saju_photo_board::router())
        .merge(saju_terrain::router().layer(small()))
        // The reading route keeps a body limit of its own, and the picture route reads its body itself.
        .merge(saju_made::router())
        .merge(catalog::router())
        .merge(factory::router())
        .merge(looks::router())
        // A brain save is a few kilobytes: the default limit, not `small()`.
        .merge(pets::router())
        .merge(permissions::router().layer(small()))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(middleware::from_fn_with_state(state.clone(), deadline))
        .layer(middleware::from_fn_with_state(state.clone(), security::protect))
        .layer(compression)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone())
        // The link preview page is HTML with headers of its own, outside the JSON middleware above.
        .merge(share::router(state.clone()));
    // In production CloudFront serves /models/* from S3 and never sends it here.
    let models = Router::new().route("/models/{file}", get(models::serve)).with_state(state.clone());
    api.merge(models).merge(rooms::router(state.clone())).merge(games::router(state))
}

/// The commit this binary was built from: `MOGAESUP_COMMIT` in the build's environment (the pipeline sets it), None for
/// a build without it.
pub const COMMIT: Option<&str> = option_env!("MOGAESUP_COMMIT");

async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok(Json(json!({
        "status": "ok",
        "server": "rust",
        "database": "postgresql",
        "rooms": state.rooms.count(),
        "commit": COMMIT,
    })))
}

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn a_request_that_takes_too_long_is_answered_and_let_go() {
        let app = Router::new()
            .route("/slow", get(std::future::pending::<&'static str>))
            .route("/quick", get(|| async { "done" }))
            .layer(middleware::from_fn(|request: Request, next: Next| {
                answer_within(Duration::from_millis(100), request, next)
            }));
        let send = |path: &'static str| {
            let app = app.clone();
            async move { app.oneshot(axum::http::Request::get(path).body(Body::empty()).unwrap()).await.unwrap() }
        };
        let started = std::time::Instant::now();
        let slow = send("/slow").await;
        assert_eq!(slow.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(send("/quick").await.status(), StatusCode::OK);
        // The studio's routes are left to their own limits.
        assert!(factory::is_studio_path("/api/avatar-factory/wardrobe/bodies"));
        assert!(!factory::is_studio_path("/api/homes/me/world"));
    }
}
