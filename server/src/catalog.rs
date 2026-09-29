use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{cmp::Reverse, time::Duration};

use crate::{
    AppState,
    auth::require,
    error::{ApiError, ApiResult, bad, not_found},
    factory, imports,
    rebac::CATALOG_EDITOR,
    studio::{self, Freshness},
    studio_power,
};

/// 미니미 are what people walk as, 주민 (`npc`) stand on islands, furniture is placed.
const KINDS: [&str; 3] = ["minime", "furniture", "npc"];
const STATUSES: [&str; 3] = ["draft", "published", "retired"];
/// Faces asked for at once for the character listing, and how long the listing waits for all of them; a face that is
/// late counts as unknown rather than holding the page past CloudFront's 30 s.
const FACE_LOOKUPS: usize = 6;
const FACE_BUDGET: Duration = Duration::from_secs(10);
const MAX_BULK: usize = 200;
const ITEM_NOT_FOUND: ApiError = not_found("item_not_found", "없는 카탈로그 항목입니다.");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/catalog/items", get(items))
        .route("/api/catalog/admin/items", get(admin_items))
        .route("/api/catalog/admin/items/{id}", patch(update))
        .route("/api/catalog/admin/items/{id}/versions", get(versions))
        .route("/api/catalog/admin/items/{id}/rollback", post(rollback))
        .route("/api/catalog/admin/bulk-status", post(bulk_status))
        .route("/api/catalog/admin/import", post(imports::enqueue))
        .route("/api/catalog/admin/imports", get(imports::list))
        .route("/api/catalog/admin/imports/{id}", get(imports::one))
        .route("/api/catalog/admin/factory-characters", get(factory_characters))
        .route("/api/catalog/admin/factory-usage", get(factory::usage))
        .route("/api/catalog/admin/studio-power", get(studio_power::status).post(studio_power::start))
}

const ITEM_COLUMNS: &str =
    "id, kind, label, emoji, model_url, thumbnail_url, clips, source, source_ref, status, sort_order";

fn item(row: &PgRow) -> Value {
    json!({
        "id": row.get::<String, _>("id"),
        "kind": row.get::<String, _>("kind"),
        "label": row.get::<String, _>("label"),
        "emoji": row.get::<String, _>("emoji"),
        "modelUrl": row.get::<String, _>("model_url"),
        "thumbnailUrl": row.get::<Option<String>, _>("thumbnail_url"),
        "clips": row.get::<Vec<String>, _>("clips"),
        "source": row.get::<String, _>("source"),
        "sourceRef": row.get::<Option<String>, _>("source_ref"),
        "status": row.get::<String, _>("status"),
        "sortOrder": row.get::<i32, _>("sort_order"),
    })
}

async fn list(db: &PgPool, kind: Option<&str>, published_only: bool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {ITEM_COLUMNS} FROM catalog_items WHERE ($1::text IS NULL OR kind = $1)
         AND (NOT $2 OR status = 'published') ORDER BY kind, sort_order, id"
    ))
    .bind(kind)
    .bind(published_only)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(item).collect())
}

#[derive(Deserialize)]
struct ItemsQuery {
    kind: Option<String>,
}

async fn items(State(state): State<AppState>, Query(query): Query<ItemsQuery>) -> ApiResult<Json<Value>> {
    let kind = query.kind.filter(|kind| KINDS.contains(&kind.as_str()));
    Ok(Json(json!({"items": list(&state.db, kind.as_deref(), true).await?})))
}

/// Admin rows: the item, how many homes wear it (미니미 only), how many versions it has, and where it came from.
const ADMIN_SELECT: &str = "WITH wearing AS (SELECT minime, count(*) AS homes FROM homes GROUP BY minime),
    history AS (SELECT item_id, count(*) AS versions FROM catalog_versions GROUP BY item_id)
    SELECT i.id, i.kind, i.label, i.emoji, i.model_url, i.thumbnail_url, i.clips, i.source, i.source_ref, i.status,
      i.sort_order, i.character_id, i.version_id, i.updated_at,
      CASE WHEN i.kind = 'minime' THEN COALESCE(w.homes, 0) ELSE 0 END AS usage, COALESCE(h.versions, 0) AS versions
    FROM catalog_items i LEFT JOIN wearing w ON w.minime = i.id LEFT JOIN history h ON h.item_id = i.id";

fn admin_item(row: &PgRow) -> Value {
    let mut value = item(row);
    value["characterId"] = json!(row.get::<Option<String>, _>("character_id"));
    value["versionId"] = json!(row.get::<Option<i64>, _>("version_id"));
    value["versionCount"] = json!(row.get::<i64, _>("versions"));
    value["usage"] = json!(row.get::<i64, _>("usage"));
    value["updatedAt"] = json!(row.get::<DateTime<Utc>, _>("updated_at"));
    value
}

/// Admin rows for `ids`, or for every item.
async fn admin_list(db: &PgPool, ids: Option<&[String]>) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "{ADMIN_SELECT} WHERE ($1::text[] IS NULL OR i.id = ANY($1)) ORDER BY i.kind, i.sort_order, i.id"
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(admin_item).collect())
}

async fn admin_one(db: &PgPool, id: &str) -> ApiResult<Json<Value>> {
    let ids = [id.to_owned()];
    let rows = admin_list(db, Some(&ids[..])).await?;
    rows.into_iter().next().map(Json).ok_or(ITEM_NOT_FOUND)
}

async fn admin_items(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    Ok(Json(json!({"items": admin_list(&state.db, None).await?})))
}

pub(crate) fn catalog_id(value: &str) -> ApiResult<&str> {
    let bytes = value.as_bytes();
    let valid = (2..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || *b == b'_' || *b == b'-');
    if valid {
        Ok(value)
    } else {
        Err(bad("invalid_id", "카탈로그 ID는 영문 소문자·숫자·밑줄·하이픈 2~64자입니다."))
    }
}

pub(crate) fn kind(value: &str) -> ApiResult<&str> {
    if KINDS.contains(&value) { Ok(value) } else { Err(bad("invalid_kind", "종류를 확인해 주세요.")) }
}

pub(crate) fn label(value: &str, max: usize, code: &'static str) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(bad(code, "입력한 값의 길이를 확인해 주세요."));
    }
    Ok(value.to_owned())
}

pub(crate) fn status(value: Option<String>) -> ApiResult<Option<String>> {
    match value {
        Some(status) if !STATUSES.contains(&status.as_str()) => Err(bad("invalid_status", "상태를 확인해 주세요.")),
        other => Ok(other),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    label: Option<String>,
    emoji: Option<String>,
    status: Option<String>,
    sort_order: Option<i32>,
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(changes): Json<Changes>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = catalog_id(&id)?;
    let updated = sqlx::query(
        "UPDATE catalog_items SET label = COALESCE($2, label), emoji = COALESCE($3, emoji), status = COALESCE($4, status),
         sort_order = COALESCE($5, sort_order), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(changes.label.as_deref().map(|v| label(v, 30, "invalid_label")).transpose()?)
    .bind(changes.emoji.as_deref().map(|v| label(v, 16, "invalid_emoji")).transpose()?)
    .bind(status(changes.status)?)
    .bind(changes.sort_order)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(ITEM_NOT_FOUND);
    }
    admin_one(&state.db, id).await
}

#[derive(Deserialize)]
struct BulkStatus {
    ids: Vec<String>,
    status: String,
}

/// `POST /api/catalog/admin/bulk-status`: one status for several items at once.
async fn bulk_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BulkStatus>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    if body.ids.is_empty() || body.ids.len() > MAX_BULK {
        return Err(bad("invalid_ids", "한 번에 바꿀 항목은 1~200개입니다."));
    }
    for id in &body.ids {
        catalog_id(id)?;
    }
    let status = status(Some(body.status))?;
    sqlx::query("UPDATE catalog_items SET status = $2, updated_at = now() WHERE id = ANY($1) AND status <> $2")
        .bind(&body.ids)
        .bind(status)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"items": admin_list(&state.db, Some(body.ids.as_slice())).await?})))
}

/// `GET /api/catalog/admin/items/{id}/versions`: every model the item has shown, newest first.
async fn versions(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = catalog_id(&id)?;
    let current: Option<i64> = sqlx::query_scalar("SELECT version_id FROM catalog_items WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ITEM_NOT_FOUND)?;
    let rows = sqlx::query(
        "SELECT v.id, v.model_url, v.thumbnail_url, v.clips, v.source_ref, v.character_id, v.stage, v.report, v.import_id,
         u.username AS created_by, v.created_at FROM catalog_versions v LEFT JOIN users u ON u.id = v.created_by
         WHERE v.item_id = $1 ORDER BY v.id DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let versions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let version: i64 = row.get("id");
            json!({
                "id": version,
                "current": current == Some(version),
                "modelUrl": row.get::<String, _>("model_url"),
                "thumbnailUrl": row.get::<Option<String>, _>("thumbnail_url"),
                "clips": row.get::<Vec<String>, _>("clips"),
                "sourceRef": row.get::<Option<String>, _>("source_ref"),
                "characterId": row.get::<Option<String>, _>("character_id"),
                "stage": row.get::<Option<String>, _>("stage"),
                "report": row.get::<Option<Value>, _>("report"),
                "importId": row.get::<Option<uuid::Uuid>, _>("import_id"),
                "createdBy": row.get::<Option<String>, _>("created_by"),
                "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
            })
        })
        .collect();
    Ok(Json(json!({"versions": versions})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rollback {
    version_id: i64,
}

/// `POST /api/catalog/admin/items/{id}/rollback`: the item shows one of its earlier versions again. Its status, order,
/// name and emoji stay; the files are still in the store because stored files are never deleted.
async fn rollback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Rollback>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = catalog_id(&id)?;
    let moved = sqlx::query(
        "UPDATE catalog_items i SET model_url = v.model_url, thumbnail_url = v.thumbnail_url, clips = v.clips,
         source_ref = v.source_ref, character_id = COALESCE(v.character_id, i.character_id), version_id = v.id,
         updated_at = now() FROM catalog_versions v WHERE i.id = $1 AND v.id = $2 AND v.item_id = i.id",
    )
    .bind(id)
    .bind(body.version_id)
    .execute(&state.db)
    .await?;
    if moved.rows_affected() == 0 {
        return Err(not_found("version_not_found", "이 항목에 없는 버전입니다."));
    }
    admin_one(&state.db, id).await
}

/// Which copy stands for a character when several do: the public one first, then the newest.
fn copy_rank(row: &PgRow) -> (u8, Reverse<DateTime<Utc>>) {
    let rank = match row.get::<&str, _>("status") {
        "published" => 0,
        "draft" => 1,
        _ => 2,
    };
    (rank, Reverse(row.get("updated_at")))
}

/// Finished characters on the character server, each with the catalog item that copies it, if any. Items match by
/// character, so a remade job is an update of the same item, and a copy is current only while its job, assembly,
/// chosen face and stage are the character's latest.
async fn factory_characters(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let admin = require(&state, &headers, CATALOG_EDITOR).await?;
    let listing = studio::list(&state, &admin.username).await?;
    let deadline = tokio::time::Instant::now() + FACE_BUDGET;
    let lookups: Vec<_> = listing
        .characters
        .iter()
        .map(|character| {
            let face = studio::chosen_face(&state, &admin.username, &character.job_id, &character.version);
            async move { tokio::time::timeout_at(deadline, face).await.ok().flatten() }
        })
        .collect();
    let faces: Vec<Option<Option<String>>> = stream::iter(lookups).buffered(FACE_LOOKUPS).collect().await;
    let rows = sqlx::query(
        "SELECT i.id, i.kind, i.label, i.emoji, i.status, i.thumbnail_url, i.source_ref, i.character_id, i.updated_at,
         v.stage FROM catalog_items i LEFT JOIN catalog_versions v ON v.id = i.version_id WHERE i.source = 'factory'",
    )
    .fetch_all(&state.db)
    .await?;
    // Each copy's character: recorded with it, or found through the job it was copied from.
    let held: Vec<(String, &PgRow)> = rows
        .iter()
        .filter_map(|row| {
            let character = row.get::<Option<String>, _>("character_id").or_else(|| {
                let source: String = row.get::<Option<String>, _>("source_ref")?;
                let job = source.split('/').next()?;
                Some(listing.owners.get(job).cloned().unwrap_or_else(|| job.to_owned()))
            })?;
            Some((character, row))
        })
        .collect();
    let characters: Vec<Value> = listing
        .characters
        .iter()
        .zip(faces)
        .map(|(character, face)| {
            let key = character.character_id.as_deref().unwrap_or(&character.job_id);
            let mut copies: Vec<&PgRow> = held.iter().filter(|(held, _)| held == key).map(|(_, row)| *row).collect();
            copies.sort_by_key(|row| copy_rank(row));
            let chosen = face.clone().flatten();
            let imported = copies.first().map(|row| {
                let freshness = studio::freshness(
                    row.get::<Option<&str>, _>("source_ref").unwrap_or_default(),
                    row.get("stage"),
                    &character.job_id,
                    &character.version,
                    face.as_ref().map(Option::as_deref),
                    &character.stage,
                );
                json!({
                    "id": row.get::<String, _>("id"),
                    "kind": row.get::<String, _>("kind"),
                    "label": row.get::<String, _>("label"),
                    "emoji": row.get::<String, _>("emoji"),
                    "status": row.get::<String, _>("status"),
                    "thumbnailUrl": row.get::<Option<String>, _>("thumbnail_url"),
                    "sourceRef": row.get::<Option<String>, _>("source_ref"),
                    "current": freshness == Freshness::Current,
                    "freshness": freshness,
                })
            });
            let mut value = serde_json::to_value(character).unwrap_or_default();
            value["face"] = json!(chosen);
            value["faceKnown"] = json!(face.is_some());
            value["sourceRef"] = json!(studio::source_ref(&character.job_id, &character.version, chosen.as_deref()));
            let model = studio::model_path(&character.job_id, &character.version, chosen.as_deref());
            value["modelUrl"] = json!(format!("/api/factory/{model}"));
            value["imported"] = imported.unwrap_or(Value::Null);
            value["otherItems"] =
                json!(copies.iter().skip(1).map(|row| row.get::<String, _>("id")).collect::<Vec<_>>());
            value
        })
        .collect();
    Ok(Json(json!({"characters": characters})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_lowercase_slugs() {
        assert!(catalog_id("factory-hero").is_ok());
        assert!(catalog_id("Hero").is_err());
        assert!(catalog_id("a").is_err());
    }

    #[test]
    fn only_known_kinds_and_statuses_pass() {
        assert!(kind("minime").is_ok() && kind("furniture").is_ok() && kind("npc").is_ok());
        assert_eq!(kind("hat").unwrap_err().code, "invalid_kind");
        assert_eq!(status(Some("gone".into())).unwrap_err().code, "invalid_status");
        assert_eq!(status(None).unwrap(), None);
    }
}
