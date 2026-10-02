use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgExecutor, PgPool, Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{current_user, optional_user},
    error::{ApiResult, bad, conflict, forbidden, not_found},
    homes::{Page, visible_home},
    rebac::{Checker, MODERATOR, Subject},
    security::{client_address, rate_limit},
};

const MAX_GUESTBOOK_ENTRIES: i64 = 2_000;
const MAX_PENDING_REQUESTS: i64 = 100;

/// Every change of one relationship locks both accounts in UUID order. Opposite requests and accept/unlink cannot
/// observe a stale pair, and concurrent requests involving one account cannot pass its pending-request cap.
async fn pair_transaction(db: &PgPool, left: Uuid, right: Uuid) -> ApiResult<Transaction<'_, Postgres>> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(vec![left, right])
        .fetch_all(&mut *tx)
        .await?;
    Ok(tx)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes/{username}/guestbook", get(guestbook).post(write))
        .route("/api/guestbook/{id}", delete(remove))
        .route("/api/homes/{username}/ilchons", get(ilchons))
        .route("/api/ilchon/{username}", get(status).delete(unlink))
        .route("/api/ilchon/{username}/request", post(request))
        .route("/api/ilchon-requests", get(requests))
        .route("/api/ilchon-requests/{id}", delete(dismiss))
        .route("/api/ilchon-requests/{id}/accept", post(accept))
}

/// A user as pages show them: name and their 미니미 emoji.
fn card(row: &PgRow, prefix: &str) -> Value {
    json!({
        "id": row.get::<Uuid, _>(format!("{prefix}id").as_str()),
        "username": row.get::<String, _>(format!("{prefix}username").as_str()),
        "displayName": row.get::<String, _>(format!("{prefix}display_name").as_str()),
        "emoji": row.get::<Option<String>, _>(format!("{prefix}emoji").as_str()).unwrap_or_else(|| "🧑".into()),
    })
}

async fn guestbook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, is_owner) = visible_home(&state, &name, viewer.as_ref()).await?;
    let limit = page.limit();
    let rows = sqlx::query(
        "SELECT g.id AS entry_id, g.body, g.secret, g.created_at, u.id, u.username, u.display_name, h.emoji
         FROM guestbook_entries g JOIN users u ON u.id = g.author_id LEFT JOIN homes h ON h.owner_id = u.id
         WHERE g.home_owner_id = $1 AND g.deleted_at IS NULL AND g.created_at < $2
         ORDER BY g.created_at DESC LIMIT $3",
    )
    .bind(home.owner_id)
    .bind(page.before())
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let total: i64 =
        sqlx::query("SELECT count(*) AS total FROM guestbook_entries WHERE home_owner_id = $1 AND deleted_at IS NULL")
            .bind(home.owner_id)
            .fetch_one(&state.db)
            .await?
            .get("total");
    let viewer_id = viewer.map(|user| user.id);
    // Moderators may remove any entry; secret ones stay unreadable to them.
    let moderator = match viewer_id {
        Some(id) if !is_owner => Checker::new(&state.db).allows(Subject::User(id), &MODERATOR).await?,
        _ => false,
    };
    let entries: Vec<Value> = rows
        .iter()
        .map(|row| {
            let author: Uuid = row.get("id");
            let secret: bool = row.get("secret");
            let mine = viewer_id == Some(author);
            json!({
                "id": row.get::<Uuid, _>("entry_id"),
                "author": card(row, ""),
                "body": if !secret || is_owner || mine { row.get::<String, _>("body") } else { String::new() },
                "secret": secret,
                "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
                "canDelete": is_owner || mine || moderator,
            })
        })
        .collect();
    let next = (rows.len() as i64 == limit).then(|| rows.last().map(|row| row.get::<DateTime<Utc>, _>("created_at")));
    Ok(Json(json!({"entries": entries, "total": total, "nextBefore": next.flatten()})))
}

#[derive(Deserialize)]
struct NewEntry {
    body: String,
    #[serde(default)]
    secret: bool,
}

async fn write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(entry): Json<NewEntry>,
) -> ApiResult<Response> {
    let author = current_user(&state, &headers).await?;
    rate_limit(&state, format!("guestbook-user:{}", author.id), 30)?;
    rate_limit(&state, format!("guestbook-address:{}", client_address(&headers)), 60)?;
    let (home, _) = visible_home(&state, &name, Some(&author)).await?;
    let body = entry.body.trim();
    if body.is_empty() || body.chars().count() > 300 {
        return Err(bad("invalid_body", "방명록은 1~300자로 남겨 주세요."));
    }
    let id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM homes WHERE owner_id = $1 FOR UPDATE").bind(home.owner_id).execute(&mut *tx).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM guestbook_entries WHERE home_owner_id = $1 AND deleted_at IS NULL")
            .bind(home.owner_id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= MAX_GUESTBOOK_ENTRIES {
        return Err(conflict("guestbook_full", "방명록이 가득 찼어요. 글을 정리한 뒤 다시 남겨 주세요."));
    }
    sqlx::query(
        "INSERT INTO guestbook_entries (id, home_owner_id, author_id, body, secret) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(home.owner_id)
    .bind(author.id)
    .bind(body)
    .bind(entry.secret)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id": id}))).into_response())
}

async fn remove(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let viewer = current_user(&state, &headers).await?;
    let row =
        sqlx::query("SELECT home_owner_id, author_id FROM guestbook_entries WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(not_found("entry_not_found", "없는 글입니다."))?;
    let party = viewer.id == row.get::<Uuid, _>("home_owner_id") || viewer.id == row.get::<Uuid, _>("author_id");
    if !party && !Checker::new(&state.db).allows(Subject::User(viewer.id), &MODERATOR).await? {
        return Err(forbidden("forbidden", "주인이나 글쓴이만 지울 수 있습니다."));
    }
    sqlx::query("UPDATE guestbook_entries SET deleted_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

const ILCHON_SELECT: &str =
    "SELECT mine.name, theirs.name AS their_name, mine.since, u.id, u.username, u.display_name, h.emoji
    FROM ilchons mine
    JOIN ilchons theirs ON theirs.user_id = mine.friend_id AND theirs.friend_id = mine.user_id
    JOIN users u ON u.id = mine.friend_id LEFT JOIN homes h ON h.owner_id = u.id";

fn ilchon(row: &PgRow) -> Value {
    json!({
        "user": card(row, ""),
        "name": row.get::<String, _>("name"),
        "theirName": row.get::<String, _>("their_name"),
        "since": row.get::<DateTime<Utc>, _>("since"),
    })
}

async fn find_ilchon<'e>(db: impl PgExecutor<'e>, user: Uuid, friend: Uuid) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query(&format!("{ILCHON_SELECT} WHERE mine.user_id = $1 AND mine.friend_id = $2"))
        .bind(user)
        .bind(friend)
        .fetch_optional(db)
        .await?;
    Ok(row.as_ref().map(ilchon))
}

async fn ilchons(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let rows = sqlx::query(&format!("{ILCHON_SELECT} WHERE mine.user_id = $1 ORDER BY mine.since"))
        .bind(home.owner_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({"ilchons": rows.iter().map(ilchon).collect::<Vec<_>>()})))
}

const REQUEST_SELECT: &str = "SELECT r.id AS request_id, r.name, r.their_name, r.message, r.created_at,
    f.id AS f_id, f.username AS f_username, f.display_name AS f_display_name, fh.emoji AS f_emoji,
    t.id AS t_id, t.username AS t_username, t.display_name AS t_display_name, th.emoji AS t_emoji
    FROM ilchon_requests r
    JOIN users f ON f.id = r.from_id LEFT JOIN homes fh ON fh.owner_id = f.id
    JOIN users t ON t.id = r.to_id LEFT JOIN homes th ON th.owner_id = t.id";

fn request_json(row: &PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("request_id"),
        "from": card(row, "f_"),
        "to": card(row, "t_"),
        "name": row.get::<String, _>("name"),
        "theirName": row.get::<String, _>("their_name"),
        "message": row.get::<String, _>("message"),
        "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
    })
}

/// The person behind `/@username`, who must exist; the caller may be that person.
async fn other(state: &AppState, name: &str) -> ApiResult<Uuid> {
    let name = crate::auth::username(name)?;
    let row = sqlx::query("SELECT id FROM users WHERE username = $1")
        .bind(name)
        .fetch_optional(&state.db)
        .await?
        .ok_or(not_found("user_not_found", "없는 사용자입니다."))?;
    Ok(row.get("id"))
}

/// Where the caller stands with someone (`self`, `none`, `requested`, `received` or `ilchon`), with the 일촌 or the
/// pending request behind it.
fn relation(relation: &str, ilchon: Option<Value>, request: Option<Value>) -> Json<Value> {
    Json(json!({"relation": relation, "ilchon": ilchon, "request": request}))
}

async fn status(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    let viewer = current_user(&state, &headers).await?;
    let other = other(&state, &name).await?;
    if other == viewer.id {
        return Ok(relation("self", None, None));
    }
    let mut tx = pair_transaction(&state.db, viewer.id, other).await?;
    if let Some(ilchon) = find_ilchon(&mut *tx, viewer.id, other).await? {
        tx.commit().await?;
        return Ok(relation("ilchon", Some(ilchon), None));
    }
    let pending = sqlx::query(&format!(
        "{REQUEST_SELECT} WHERE (r.from_id = $1 AND r.to_id = $2) OR (r.from_id = $2 AND r.to_id = $1)"
    ))
    .bind(viewer.id)
    .bind(other)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(match pending {
        None => relation("none", None, None),
        Some(row) => {
            let side = if row.get::<Uuid, _>("f_id") == viewer.id { "requested" } else { "received" };
            relation(side, None, Some(request_json(&row)))
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IlchonAsk {
    name: String,
    their_name: String,
    #[serde(default)]
    message: String,
}

fn ilchon_name(value: &str) -> ApiResult<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 12 {
        return Err(bad("invalid_ilchon_name", "일촌명은 1~12자로 정해 주세요."));
    }
    Ok(name.to_owned())
}

async fn request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(ask): Json<IlchonAsk>,
) -> ApiResult<Response> {
    let viewer = current_user(&state, &headers).await?;
    let other = other(&state, &name).await?;
    if other == viewer.id {
        return Err(conflict("self_ilchon", "나와는 일촌을 맺을 수 없습니다."));
    }
    let message = ask.message.trim();
    if message.chars().count() > 100 {
        return Err(bad("invalid_message", "한마디는 100자 이하로 적어 주세요."));
    }
    let my_name = ilchon_name(&ask.name)?;
    let their_name = ilchon_name(&ask.their_name)?;
    rate_limit(&state, format!("ilchon-request:{}", viewer.id), 30)?;
    let mut tx = pair_transaction(&state.db, viewer.id, other).await?;
    let linked: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM ilchons WHERE user_id = $1 AND friend_id = $2)")
            .bind(viewer.id)
            .bind(other)
            .fetch_one(&mut *tx)
            .await?;
    if linked {
        return Err(conflict("already_ilchon", "이미 일촌입니다."));
    }
    let received = sqlx::query("SELECT 1 FROM ilchon_requests WHERE from_id = $1 AND to_id = $2")
        .bind(other)
        .bind(viewer.id)
        .fetch_optional(&mut *tx)
        .await?;
    if received.is_some() {
        return Err(conflict("request_received", "상대가 먼저 일촌을 신청했습니다."));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ilchon_requests WHERE (from_id = $1 OR to_id = $1) AND NOT (from_id = $1 AND to_id = $2)",
    )
    .bind(viewer.id)
    .bind(other)
    .fetch_one(&mut *tx)
    .await?;
    let target_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ilchon_requests WHERE (from_id = $1 OR to_id = $1) AND NOT (from_id = $2 AND to_id = $1)",
    )
    .bind(other)
    .bind(viewer.id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_PENDING_REQUESTS || target_count >= MAX_PENDING_REQUESTS {
        return Err(conflict("requests_full", "대기 중인 일촌 신청을 정리해 주세요."));
    }
    sqlx::query(
        "INSERT INTO ilchon_requests (id, from_id, to_id, name, their_name, message) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (from_id, to_id) DO UPDATE SET name = excluded.name, their_name = excluded.their_name,
         message = excluded.message, created_at = now()",
    )
    .bind(Uuid::new_v4())
    .bind(viewer.id)
    .bind(other)
    .bind(my_name)
    .bind(their_name)
    .bind(message)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"relation": "requested"}))).into_response())
}

async fn unlink(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<StatusCode> {
    let viewer = current_user(&state, &headers).await?;
    let other = other(&state, &name).await?;
    let mut tx = pair_transaction(&state.db, viewer.id, other).await?;
    sqlx::query("DELETE FROM ilchons WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)")
        .bind(viewer.id)
        .bind(other)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM ilchon_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)")
        .bind(viewer.id)
        .bind(other)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Each of them may have stood on the other's island as a 일촌; whoever may not now is let out.
    crate::rooms::revalidate(&state, &viewer.username).await;
    crate::rooms::revalidate(&state, &crate::auth::username(&name)?).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn requests(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let viewer = current_user(&state, &headers).await?;
    let rows =
        sqlx::query(&format!("{REQUEST_SELECT} WHERE r.from_id = $1 OR r.to_id = $1 ORDER BY r.created_at DESC"))
            .bind(viewer.id)
            .fetch_all(&state.db)
            .await?;
    let (received, sent): (Vec<_>, Vec<_>) = rows.iter().partition(|row| row.get::<Uuid, _>("t_id") == viewer.id);
    Ok(Json(json!({
        "received": received.into_iter().map(request_json).collect::<Vec<_>>(),
        "sent": sent.into_iter().map(request_json).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct Accept {
    name: Option<String>,
}

async fn accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Accept>,
) -> ApiResult<Json<Value>> {
    let viewer = current_user(&state, &headers).await?;
    let from: Uuid = sqlx::query_scalar("SELECT from_id FROM ilchon_requests WHERE id = $1 AND to_id = $2")
        .bind(id)
        .bind(viewer.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(not_found("request_not_found", "없는 일촌 신청입니다."))?;
    let mut tx = pair_transaction(&state.db, from, viewer.id).await?;
    let row = sqlx::query("SELECT from_id, to_id, name, their_name FROM ilchon_requests WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .filter(|row| row.get::<Uuid, _>("to_id") == viewer.id)
        .ok_or(not_found("request_not_found", "없는 일촌 신청입니다."))?;
    let from: Uuid = row.get("from_id");
    let my_name = match body.name {
        Some(name) => ilchon_name(&name)?,
        None => row.get("their_name"),
    };
    sqlx::query(
        "INSERT INTO ilchons (user_id, friend_id, name) VALUES ($1, $2, $3), ($2, $1, $4)
         ON CONFLICT (user_id, friend_id) DO UPDATE SET name = excluded.name",
    )
    .bind(from)
    .bind(viewer.id)
    .bind(row.get::<String, _>("name"))
    .bind(my_name)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM ilchon_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)")
        .bind(from)
        .bind(viewer.id)
        .execute(&mut *tx)
        .await?;
    let ilchon = find_ilchon(&mut *tx, viewer.id, from).await?;
    tx.commit().await?;
    Ok(relation("ilchon", ilchon, None))
}

async fn dismiss(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let viewer = current_user(&state, &headers).await?;
    let pair: (Uuid, Uuid) =
        sqlx::query_as("SELECT from_id, to_id FROM ilchon_requests WHERE id = $1 AND (from_id = $2 OR to_id = $2)")
            .bind(id)
            .bind(viewer.id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(not_found("request_not_found", "없는 일촌 신청입니다."))?;
    let mut tx = pair_transaction(&state.db, pair.0, pair.1).await?;
    let deleted = sqlx::query("DELETE FROM ilchon_requests WHERE id = $1 AND (from_id = $2 OR to_id = $2)")
        .bind(id)
        .bind(viewer.id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(not_found("request_not_found", "없는 일촌 신청입니다."));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
