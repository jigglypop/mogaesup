//! A database belongs to one running web process. Startup recovery must never interrupt another process's jobs.
use anyhow::{Context, bail};
use sqlx::{Connection, PgConnection, PgPool};
use std::{future::Future, time::Duration};

const PROCESS_LOCK: i64 = 7_309_002;
/// How often the lock's connection is asked whether it is still there, and how long it may take to answer.
const HEARTBEAT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The database ends the lock's session soon after this process is gone (instead of hours later), freeing the lock.
const KEEPALIVE: &str = "SELECT set_config('tcp_keepalives_idle', '10', false),
    set_config('tcp_keepalives_interval', '5', false), set_config('tcp_keepalives_count', '3', false)";

pub struct ProcessLock {
    // A connection of its own, outside the pool: a session-scoped lock must never return to the pool.
    connection: PgConnection,
}

impl ProcessLock {
    pub async fn acquire(db: &PgPool) -> anyhow::Result<Self> {
        let mut connection = connect(db).await?;
        if !try_lock(&mut connection).await? {
            bail!("Another mogaesup server owns this database; stop it before starting this process");
        }
        Self::holding(connection).await
    }

    async fn holding(connection: PgConnection) -> anyhow::Result<Self> {
        Ok(Self { connection })
    }

    pub async fn assert_held(&mut self) -> anyhow::Result<()> {
        tokio::time::timeout(HEARTBEAT, sqlx::query("SELECT 1").execute(&mut self.connection))
            .await
            .context("Database process lock heartbeat timed out")?
            .context("Database process lock connection was lost")?;
        Ok(())
    }

    pub async fn monitor(self, db: PgPool) -> anyhow::Result<()> {
        self.watch(db, HEARTBEAT, Duration::ZERO).await
    }

    /// Loss of this session ends the process immediately. Continuing HTTP or
    /// background mutations while reacquiring a lock could overlap a new owner.
    pub async fn watch(self, _db: PgPool, every: Duration, _give_up: Duration) -> anyhow::Result<()> {
        let mut lock = self;
        loop {
            tokio::time::sleep(every).await;
            lock.assert_held().await?;
        }
    }
}

async fn connect(db: &PgPool) -> anyhow::Result<PgConnection> {
    let mut connection = tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect_with(&db.connect_options()))
        .await
        .context("Database connection timed out")??;
    if let Err(error) = sqlx::query(KEEPALIVE).execute(&mut connection).await {
        tracing::debug!(%error, "Database keepalive settings were not taken");
    }
    Ok(connection)
}

async fn try_lock(connection: &mut PgConnection) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT pg_try_advisory_lock($1)").bind(PROCESS_LOCK).fetch_one(&mut *connection).await
}

/// Tries of a background task's database request, and the first wait between them (doubling after each).
const ATTEMPTS: u32 = 4;
const FIRST_WAIT: Duration = Duration::from_millis(500);

/// `request` until it succeeds, [`ATTEMPTS`] times at most: a background task's check or final write must outlast a
/// brief database outage, which a request from a page would simply have reported.
pub(crate) async fn retry<T, F, Fut>(request: F) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, sqlx::Error>>,
{
    retry_after(FIRST_WAIT, request).await
}

async fn retry_after<T, F, Fut>(first_wait: Duration, mut request: F) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, sqlx::Error>>,
{
    let mut wait = first_wait;
    for _ in 1..ATTEMPTS {
        match request().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                tracing::warn!(%error, "Database request failed; trying again");
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
        }
    }
    request().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn a_background_request_outlasts_a_brief_outage_and_then_gives_up() {
        let wait = Duration::from_millis(1);
        let calls = AtomicU32::new(0);
        let flaky =
            || async { if calls.fetch_add(1, Ordering::SeqCst) < 2 { Err(sqlx::Error::PoolTimedOut) } else { Ok(7) } };
        assert_eq!(retry_after(wait, flaky).await.unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let calls = AtomicU32::new(0);
        let down = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), _>(sqlx::Error::PoolTimedOut)
        };
        assert!(retry_after(wait, down).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), ATTEMPTS);
    }
}
