//! A database belongs to one running web process. Startup recovery must never interrupt another process's jobs.
use anyhow::{Context, bail};
use sqlx::{Connection, PgConnection, PgPool};
use std::{
    future::Future,
    time::{Duration, Instant},
};

const PROCESS_LOCK: i64 = 7_309_002;
/// How often the lock's connection is asked whether it still holds the lock, and how long it may take to answer.
const HEARTBEAT: Duration = Duration::from_secs(5);
/// How long the database may stay too slow to say whether this process still holds the lock before the process gives
/// up: a busy database (CPU credits spent, a burst of load) answers late for a while, and a restart would drop every
/// room and game for nothing.
const GIVE_UP: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The database ends the lock's session soon after this process is gone (instead of hours later), freeing the lock.
const KEEPALIVE: &str = "SELECT set_config('tcp_keepalives_idle', '10', false),
    set_config('tcp_keepalives_interval', '5', false), set_config('tcp_keepalives_count', '3', false)";
/// Whether the asking session holds the process lock.
const HOLDS_LOCK: &str = "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0
    AND objid::int8 = $1 AND objsubid = 1 AND pid = pg_backend_pid() AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database()))";
/// Which session holds the process lock, if any.
const LOCK_HOLDER: &str = "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid::int8 = $1
    AND objsubid = 1 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())";

pub struct ProcessLock {
    // A connection of its own, outside the pool: a session-scoped lock must never return to the pool.
    connection: PgConnection,
    /// The lock session's backend process, as `pg_locks` names its holder.
    pid: i32,
}

/// What one look at the lock found.
#[derive(Debug)]
enum Beat {
    Held,
    /// No answer in time: the lock may still be held.
    Slow,
    Lost(anyhow::Error),
}

/// What the lock's watcher asks: the lock's own connection, then the pool when that one does not answer.
trait Pulse {
    async fn beat(&mut self) -> Beat;
    /// Some(true) while the lock's session still holds the lock, Some(false) when another session or none does, None
    /// without an answer.
    async fn confirm(&mut self) -> Option<bool>;
}

impl ProcessLock {
    pub async fn acquire(db: &PgPool) -> anyhow::Result<Self> {
        let mut connection = connect(db).await?;
        if !try_lock(&mut connection).await? {
            bail!("Another mogaesup server owns this database; stop it before starting this process");
        }
        Self::holding(connection).await
    }

    async fn holding(mut connection: PgConnection) -> anyhow::Result<Self> {
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut connection).await?;
        Ok(Self { connection, pid })
    }

    pub async fn assert_held(&mut self) -> anyhow::Result<()> {
        match self.look(HEARTBEAT).await {
            Beat::Held => Ok(()),
            Beat::Slow => bail!("Database process lock heartbeat timed out"),
            Beat::Lost(error) => Err(error),
        }
    }

    async fn look(&mut self, wait: Duration) -> Beat {
        let asked = sqlx::query_scalar::<_, bool>(HOLDS_LOCK).bind(PROCESS_LOCK).fetch_one(&mut self.connection);
        match tokio::time::timeout(wait, asked).await {
            Err(_) => Beat::Slow,
            Ok(Ok(true)) => Beat::Held,
            Ok(Ok(false)) => Beat::Lost(anyhow::anyhow!("Database process lock connection was lost: the lock is gone")),
            Ok(Err(error)) => {
                Beat::Lost(anyhow::Error::new(error).context("Database process lock connection was lost"))
            }
        }
    }

    pub async fn monitor(self, db: PgPool) -> anyhow::Result<()> {
        self.watch(db, HEARTBEAT, GIVE_UP).await
    }

    /// Looks at the lock every `every`. Its loss ends the process at once: continuing HTTP or background mutations
    /// while reacquiring a lock could overlap a new owner. A look not answered in time is asked again through the pool:
    /// the lock's session still holding it is fine, another session (or none) holding it is a loss, and no answer at
    /// all for `give_up` ends the process too.
    pub async fn watch(self, db: PgPool, every: Duration, give_up: Duration) -> anyhow::Result<()> {
        keep(&mut Watched { lock: self, db, wait: every.min(HEARTBEAT) }, every, give_up).await
    }
}

struct Watched {
    lock: ProcessLock,
    db: PgPool,
    wait: Duration,
}

impl Pulse for Watched {
    async fn beat(&mut self) -> Beat {
        self.lock.look(self.wait).await
    }

    async fn confirm(&mut self) -> Option<bool> {
        let holder = sqlx::query_scalar::<_, i32>(LOCK_HOLDER).bind(PROCESS_LOCK).fetch_optional(&self.db);
        match tokio::time::timeout(self.wait, holder).await {
            Ok(Ok(holder)) => Some(holder == Some(self.lock.pid)),
            Ok(Err(error)) => {
                tracing::warn!(%error, "Could not ask the database who holds the process lock");
                None
            }
            Err(_) => None,
        }
    }
}

/// [`ProcessLock::watch`]'s loop, over any [`Pulse`].
async fn keep(pulse: &mut impl Pulse, every: Duration, give_up: Duration) -> anyhow::Result<()> {
    let mut unanswered_since: Option<Instant> = None;
    loop {
        tokio::time::sleep(every).await;
        let held = match pulse.beat().await {
            Beat::Held => true,
            Beat::Lost(error) => return Err(error),
            Beat::Slow => match pulse.confirm().await {
                Some(true) => true,
                Some(false) => bail!("Database process lock connection was lost: another session holds the lock"),
                None => false,
            },
        };
        if held {
            if let Some(since) = unanswered_since.take() {
                tracing::warn!(after = ?since.elapsed(), "The database answers the process lock heartbeat again");
            }
            continue;
        }
        let since = *unanswered_since.get_or_insert_with(Instant::now);
        tracing::warn!(waited = ?since.elapsed(), "The database did not answer the process lock heartbeat");
        if since.elapsed() >= give_up {
            bail!("Database process lock heartbeat timed out for {give_up:?}");
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
/// brief database outage, which a request from a page would simply have reported. A request the database refused for
/// what it is ([`permanent`]) is not sent again.
pub(crate) async fn retry<T, F, Fut>(request: F) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, sqlx::Error>>,
{
    retry_after(FIRST_WAIT, request).await
}

/// Whether the database would answer `error` again however often it is asked: SQLSTATE class 22 (a value it cannot
/// take), 23 (a constraint) or 42 (a statement or permission it rejects).
fn permanent(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database) => {
            database.code().is_some_and(|code| matches!(code.get(..2), Some("22" | "23" | "42")))
        }
        _ => false,
    }
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
            Err(error) if permanent(&error) => return Err(error),
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
    use std::{
        borrow::Cow,
        error::Error,
        sync::atomic::{AtomicU32, Ordering},
    };

    /// What PostgreSQL answers with SQLSTATE `.0`.
    #[derive(Debug)]
    struct Refusal(&'static str);

    impl std::fmt::Display for Refusal {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "SQLSTATE {}", self.0)
        }
    }

    impl Error for Refusal {}

    impl sqlx::error::DatabaseError for Refusal {
        fn message(&self) -> &str {
            "refused"
        }
        fn code(&self) -> Option<Cow<'_, str>> {
            Some(self.0.into())
        }
        fn as_error(&self) -> &(dyn Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    fn refused(code: &'static str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(Refusal(code)))
    }

    /// Answers in turn: the lock's connection's, and the pool's when asked.
    struct Script {
        beats: std::collections::VecDeque<Beat>,
        confirms: std::collections::VecDeque<Option<bool>>,
        looked: u32,
    }

    impl Script {
        fn new(beats: Vec<Beat>, confirms: Vec<Option<bool>>) -> Self {
            Self { beats: beats.into(), confirms: confirms.into(), looked: 0 }
        }
    }

    impl Pulse for Script {
        async fn beat(&mut self) -> Beat {
            self.looked += 1;
            self.beats.pop_front().unwrap_or(Beat::Held)
        }
        async fn confirm(&mut self) -> Option<bool> {
            self.confirms.pop_front().expect("the pool is asked only after a slow look")
        }
    }

    #[tokio::test]
    async fn a_slow_heartbeat_is_asked_again_and_only_an_answer_that_never_comes_ends_the_process() {
        let every = Duration::from_millis(1);
        // Slow looks while the pool says the lock is still held, or a while without any answer, then answers again.
        let mut script = Script::new(
            vec![Beat::Slow, Beat::Slow, Beat::Slow, Beat::Held, Beat::Lost(anyhow::anyhow!("lost: ended"))],
            vec![Some(true), None, None],
        );
        let error = keep(&mut script, every, Duration::from_secs(60)).await.unwrap_err();
        assert!(format!("{error:#}").contains("lost: ended"), "{error:#}");
        assert_eq!(script.looked, 5);
        // Another session holding the lock is a loss, however slow the lock's own connection is.
        let mut script = Script::new(vec![Beat::Slow], vec![Some(false)]);
        let error = keep(&mut script, every, Duration::from_secs(60)).await.unwrap_err();
        assert!(format!("{error:#}").contains("another session holds the lock"), "{error:#}");
        // No answer at all for the whole grace period ends it.
        let mut script = Script::new((0..1000).map(|_| Beat::Slow).collect(), (0..1000).map(|_| None).collect());
        let error = keep(&mut script, every, Duration::from_millis(30)).await.unwrap_err();
        assert!(format!("{error:#}").contains("timed out"), "{error:#}");
        assert!(script.looked > 1, "slow looks were asked again before giving up");
    }

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

        // A value, constraint or statement the database refuses is refused again: asked once, not four times.
        for code in ["22P05", "23505", "42703"] {
            let calls = AtomicU32::new(0);
            let refusing = || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(refused(code))
            };
            let error = retry_after(wait, refusing).await.unwrap_err();
            assert!(matches!(&error, sqlx::Error::Database(found) if found.code().as_deref() == Some(code)), "{error}");
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{code}");
        }
        // A deadlock, a server shutting down or a lost connection passes, so it is asked again.
        for code in ["40P01", "57P01", "08006"] {
            let calls = AtomicU32::new(0);
            let passing =
                || async { if calls.fetch_add(1, Ordering::SeqCst) < 1 { Err(refused(code)) } else { Ok(7) } };
            assert_eq!(retry_after(wait, passing).await.unwrap(), 7, "{code}");
            assert_eq!(calls.load(Ordering::SeqCst), 2, "{code}");
        }
    }
}
