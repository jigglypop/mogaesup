mod common;

use common::TestDb;
use mogaesup_server::runtime::ProcessLock;

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
    sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = 7309002 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")
        .execute(&db.pool).await.unwrap();
    assert!(lock.assert_held().await.is_err());
    drop(lock);
    db.remove().await;
}
