mod common;

use common::TestDb;
use mogaesup_server::runtime::ProcessLock;
use sqlx::PgPool;
use std::time::Duration;

/// Ends whichever session holds the process lock in this database, as a dropped connection or a database restart does.
async fn end_lock_session(db: &PgPool) {
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 7309002 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")
        .execute(db).await.unwrap();
}

/// The backend holding the process lock, if any.
async fn lock_holder(db: &PgPool) -> Option<i32> {
    sqlx::query_scalar("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 7309002 AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")
        .fetch_optional(db).await.unwrap()
}

#[tokio::test]
async fn a_second_process_cannot_recover_a_running_process_jobs() {
    let db = TestDb::create().await;
    let mut first = ProcessLock::acquire(&db.pool).await.unwrap();
    first.assert_held().await.unwrap();
    assert!(ProcessLock::acquire(&db.pool).await.is_err());
    drop(first);
    // Closing a detached connection releases its session lock, without contaminating pooled connections.
    let mut second = ProcessLock::acquire(&db.pool).await.unwrap();
    second.assert_held().await.unwrap();
    drop(second);
    db.remove().await;
}

#[tokio::test]
async fn losing_the_lock_connection_is_detected() {
    let db = TestDb::create().await;
    let mut lock = ProcessLock::acquire(&db.pool).await.unwrap();
    end_lock_session(&db.pool).await;
    assert!(lock.assert_held().await.is_err());
    drop(lock);
    db.remove().await;
}

#[tokio::test]
async fn a_lost_lock_connection_stops_the_watcher_without_reacquiring() {
    let db = TestDb::create().await;
    let lock = ProcessLock::acquire(&db.pool).await.unwrap();
    assert!(lock_holder(&db.pool).await.is_some());
    let watcher = tokio::spawn(lock.watch(db.pool.clone(), Duration::from_millis(200), Duration::from_secs(10)));
    end_lock_session(&db.pool).await;
    // The former grace period is deliberately longer than this deadline. Loss must fail at the next heartbeat.
    let stopped = tokio::time::timeout(Duration::from_secs(2), watcher).await.unwrap().unwrap();
    assert!(format!("{:#}", stopped.unwrap_err()).contains("process lock connection was lost"));
    assert_eq!(lock_holder(&db.pool).await, None, "the old owner must never retake a lost session lock");
    let mut next = ProcessLock::acquire(&db.pool).await.unwrap();
    next.assert_held().await.unwrap();
    drop(next);
    db.remove().await;
}

#[tokio::test]
async fn another_process_taking_the_lock_stops_this_one() {
    let db = TestDb::create().await;
    let lock = ProcessLock::acquire(&db.pool).await.unwrap();
    let before = lock_holder(&db.pool).await.unwrap();
    // Slow to look, so the other process gets the lock first.
    let watcher = tokio::spawn(lock.watch(db.pool.clone(), Duration::from_secs(2), Duration::from_secs(10)));
    end_lock_session(&db.pool).await;
    let mut other = None;
    for _ in 0..100 {
        if let Ok(lock) = ProcessLock::acquire(&db.pool).await {
            other = Some(lock);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut other = other.expect("the other process took the lock");
    let after = lock_holder(&db.pool).await.unwrap();
    assert_ne!(before, after);
    let stopped = tokio::time::timeout(Duration::from_secs(10), watcher).await.unwrap().unwrap();
    assert!(format!("{:#}", stopped.unwrap_err()).contains("process lock connection was lost"));
    other.assert_held().await.unwrap();
    assert_eq!(lock_holder(&db.pool).await, Some(after), "stopping the old owner must not disturb the new owner");
    drop(other);
    db.remove().await;
}

#[tokio::test]
async fn a_database_that_goes_away_stops_the_watcher_without_a_grace_period() {
    let db = TestDb::create().await;
    let pool = db.pool.clone();
    let lock = ProcessLock::acquire(&pool).await.unwrap();
    let watcher = tokio::spawn(lock.watch(pool, Duration::from_millis(200), Duration::from_secs(60)));
    // The database goes away for good: dropped, its sessions ended.
    db.remove().await;
    let stopped = tokio::time::timeout(Duration::from_secs(2), watcher).await.unwrap().unwrap();
    assert!(format!("{:#}", stopped.unwrap_err()).contains("process lock connection was lost"));
}
