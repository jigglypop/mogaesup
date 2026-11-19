//! Islands that are not one member's 사주 home: anyone signed in may raise one, and anyone may open it.
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    AppState,
    auth::current_user,
    error::{ApiError, ApiResult, bad, not_found},
    security::rate_limit,
};

const TITLE: ApiError = bad("invalid_title", "이름은 24자 이하로 입력해 주세요.");
const MISSING: ApiError = not_found("no_island", "그 공용섬이 없어요.");

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/islands", get(list).post(create)).route("/api/islands/{slug}", get(one))
}

#[derive(Deserialize)]
struct Create {
    title: String,
}

fn title_of(title: &str) -> ApiResult<&str> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 24 || title.chars().any(char::is_control) {
        return Err(TITLE);
    }
    Ok(title)
}

fn island(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "slug": row.get::<String, _>("slug"),
        "title": row.get::<String, _>("title"),
        "creator": row.get::<String, _>("username"),
        "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
    })
}

/// `POST /api/islands` `{title}`: raises a public island; 201 with it.
async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Create>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let user = current_user(&state, &headers).await?;
    let title = title_of(&body.title)?;
    rate_limit(&state, format!("shared-island:{}", user.id), 10)?;
    let id = Uuid::new_v4();
    let slug = id.simple().to_string();
    let slug = &slug[..12];
    sqlx::query("INSERT INTO shared_islands (id, slug, title, creator_id) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(slug)
        .bind(title)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    let row = sqlx::query(
        "SELECT i.id, i.slug, i.title, i.created_at, u.username FROM shared_islands i
         JOIN users u ON u.id = i.creator_id WHERE i.id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(island(&row))))
}

/// `GET /api/islands`: the public islands, newest first.
async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        "SELECT i.id, i.slug, i.title, i.created_at, u.username FROM shared_islands i
         JOIN users u ON u.id = i.creator_id ORDER BY i.created_at DESC, i.id DESC LIMIT 40",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({"islands": rows.iter().map(island).collect::<Vec<_>>()})))
}

/// `GET /api/islands/{slug}`: one public island.
async fn one(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    if slug.len() != 12 || !slug.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(MISSING);
    }
    let row = sqlx::query(
        "SELECT i.id, i.slug, i.title, i.created_at, u.username FROM shared_islands i
         JOIN users u ON u.id = i.creator_id WHERE i.slug = $1",
    )
    .bind(slug)
    .fetch_optional(&state.db)
    .await?
    .ok_or(MISSING)?;
    Ok(Json(island(&row)))
}

#[cfg(test)]
mod tests {
    use super::title_of;

    #[test]
    fn 공용섬_이름은_비거나_길면_거절한다() {
        assert!(title_of("  호수  ").is_ok());
        assert!(title_of(" ").is_err());
        assert!(title_of(&"가".repeat(25)).is_err());
    }
}
