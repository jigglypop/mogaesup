//! A database belongs to one running web process. Startup recovery must never interrupt another process's jobs.
use anyhow::{Context, bail};
use sqlx::{PgConnection, PgPool};
use std::time::Duration;

const PROCESS_LOCK: i64 = 7_309_002;

pub struct ProcessLock {
    // A detached connection closes on drop; it must never return a session-scoped lock to the pool.
    connection: PgConnection,
}

impl ProcessLock {
    pub async fn acquire(db: &PgPool) -> anyhow::Result<Self> {
        let mut connection = db.acquire().await?.detach();
        let held: bool =
            sqlx::query_scalar("SELECT pg_try_advisory_lock($1)").bind(PROCESS_LOCK).fetch_one(&mut connection).await?;
        if !held {
            bail!("Another mogaesup server owns this database; stop it before starting this process");
        }
        Ok(Self { connection })
    }

    pub async fn assert_held(&mut self) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(5), sqlx::query("SELECT 1").execute(&mut self.connection))
            .await
            .context("Database process lock heartbeat timed out")?
            .context("Database process lock connection was lost")?;
        Ok(())
    }

    pub async fn monitor(mut self) -> anyhow::Result<()> {
        loop {
            self.assert_held().await?;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
}
