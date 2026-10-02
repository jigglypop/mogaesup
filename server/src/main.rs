use anyhow::Context;
use mogaesup_server::{AppState, auth, config::Config, imports, looks, router, runtime::ProcessLock};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::env;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    // A bad setting stops the start before the database is connected or migrated.
    let config = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(12)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&database_url)
        .await?;
    let process_lock = ProcessLock::acquire(&db).await?;
    // Monitor the ownership connection during migrations and recovery too, before any HTTP listener exists.
    tokio::select! {
        result = run(db, config) => result?,
        result = process_lock.monitor() => result?,
    }
    Ok(())
}

async fn run(db: PgPool, config: Config) -> anyhow::Result<()> {
    let bootstrap = env::var("BOOTSTRAP_ADMIN_USERNAME").ok().zip(env::var("BOOTSTRAP_ADMIN_PASSWORD").ok());
    auth::verify_legacy_admin_before_migration(
        &db,
        bootstrap.as_ref().map(|(username, password)| (username.as_str(), password.as_str())),
    )
    .await?;
    let mut migrator = sqlx::migrate!("./migrations");
    // A rollback restores the previous binary but not the schema, so an older release must start on a database that
    // a newer release already migrated. Migrations stay additive.
    migrator.set_ignore_missing(true);
    migrator.run(&db).await?;
    let interrupted = imports::interrupt_unfinished(&db).await.context("interrupted catalog imports")?;
    if interrupted > 0 {
        tracing::warn!(interrupted, "Catalog imports cut short by the last shutdown were marked failed");
    }
    let interrupted = looks::interrupt_unfinished(&db).await.context("interrupted looks")?;
    if interrupted > 0 {
        tracing::warn!(interrupted, "Looks cut short by the last shutdown were marked failed");
    }
    let state = AppState::new(db.clone(), config);
    if let Some((username, password)) = bootstrap {
        auth::bootstrap_admin(&state, &username, &password).await.context("bootstrap admin")?;
    }
    auth::spawn_cleanup(db);
    let address = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "mogaesup server ready");
    axum::serve(listener, router(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

/// systemd stops the service with SIGTERM; Ctrl+C covers local runs. Either one lets in-flight requests finish.
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
    tracing::info!("Shutdown signal received");
}
