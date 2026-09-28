use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::path::PathBuf;

use crate::{
    AppState,
    auth::require_admin,
    error::{ApiResult, bad, internal, not_found},
    factory::fetch_model,
};

const KINDS: [&str; 2] = ["minime", "furniture"];
const STATUSES: [&str; 3] = ["draft", "published", "retired"];
const GLB_MAGIC: u32 = 0x4654_6c67;
const GLB_VERSION: u32 = 2;
const BLOB_PATH: &str = "/api/catalog/blobs";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/catalog/items", get(items))
        .route("/api/catalog/admin/items", get(admin_items))
        .route("/api/catalog/admin/items/{id}", patch(update))
        .route("/api/catalog/admin/import", post(import))
        .route("/api/catalog/blobs/{file}", get(blob))
}

const ITEM_SELECT: &str =
    "SELECT id, kind, label, emoji, model_url, source, source_ref, status, sort_order FROM catalog_items";

fn item(row: &PgRow) -> Value {
    json!({
        "id": row.get::<String, _>("id"),
        "kind": row.get::<String, _>("kind"),
        "label": row.get::<String, _>("label"),
        "emoji": row.get::<String, _>("emoji"),
        "modelUrl": row.get::<String, _>("model_url"),
        "source": row.get::<String, _>("source"),
        "sourceRef": row.get::<Option<String>, _>("source_ref"),
        "status": row.get::<String, _>("status"),
        "sortOrder": row.get::<i32, _>("sort_order"),
    })
}

async fn list(db: &PgPool, kind: Option<&str>, published_only: bool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "{ITEM_SELECT} WHERE ($1::text IS NULL OR kind = $1) AND (NOT $2 OR status = 'published') ORDER BY kind, sort_order, id"
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

async fn admin_items(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_admin(&state, &headers).await?;
    Ok(Json(json!({"items": list(&state.db, None, false).await?})))
}

fn catalog_id(value: &str) -> ApiResult<&str> {
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

fn label(value: &str, max: usize, code: &'static str) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(bad(code, "입력한 값의 길이를 확인해 주세요."));
    }
    Ok(value.to_owned())
}

fn status(value: Option<String>) -> ApiResult<Option<String>> {
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
    require_admin(&state, &headers).await?;
    let row = sqlx::query(
        "UPDATE catalog_items SET label = COALESCE($2, label), emoji = COALESCE($3, emoji), status = COALESCE($4, status),
         sort_order = COALESCE($5, sort_order), updated_at = now() WHERE id = $1
         RETURNING id, kind, label, emoji, model_url, source, source_ref, status, sort_order",
    )
    .bind(catalog_id(&id)?)
    .bind(changes.label.as_deref().map(|v| label(v, 30, "invalid_label")).transpose()?)
    .bind(changes.emoji.as_deref().map(|v| label(v, 16, "invalid_emoji")).transpose()?)
    .bind(status(changes.status)?)
    .bind(changes.sort_order)
    .fetch_optional(&state.db)
    .await?
    .ok_or(not_found("item_not_found", "없는 카탈로그 항목입니다."))?;
    Ok(Json(item(&row)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Import {
    id: String,
    kind: String,
    label: String,
    emoji: String,
    factory_job_id: String,
    factory_version: String,
    status: Option<String>,
    sort_order: Option<i32>,
}

fn factory_part(value: &str, extra: &[u8]) -> ApiResult<String> {
    let valid = (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b) || extra.contains(&b));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(bad("invalid_factory_ref", "작업 ID와 조립 버전을 확인해 주세요."))
    }
}

/// A binary glTF 2.0 container whose header length matches the bytes.
pub fn is_glb(bytes: &[u8]) -> bool {
    let word = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    word(0) == Some(GLB_MAGIC) && word(4) == Some(GLB_VERSION) && word(8) == Some(bytes.len() as u32)
}

fn blob_path(state: &AppState, sha: &str) -> PathBuf {
    state.config.blob_dir.join(&sha[..2]).join(sha)
}

/// Copies a sealed character-server assembly into the catalog as a draft; publishing it puts it in the 미니미 list.
async fn import(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Import>) -> ApiResult<Response> {
    let admin = require_admin(&state, &headers).await?;
    let id = catalog_id(&body.id)?.to_owned();
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(bad("invalid_kind", "종류를 확인해 주세요."));
    }
    let job = factory_part(&body.factory_job_id, b"")?;
    let version = factory_part(&body.factory_version, b".")?;
    let bytes = fetch_model(&state, &admin.username, &job, &version).await?;
    if !is_glb(&bytes) {
        return Err(bad("not_glb", "GLB 파일이 아닙니다."));
    }
    let sha = hex::encode(Sha256::digest(&bytes));
    let path = blob_path(&state, &sha);
    if !path.exists() {
        let dir = path.parent().ok_or_else(|| internal("blob path"))?;
        tokio::fs::create_dir_all(dir).await.map_err(internal)?;
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        tokio::fs::write(&temporary, &bytes).await.map_err(internal)?;
        tokio::fs::rename(&temporary, &path).await.map_err(internal)?;
    }
    let row = sqlx::query(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, source, source_ref, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, 'factory', $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, label = excluded.label, emoji = excluded.emoji,
         model_url = excluded.model_url, source = 'factory', source_ref = excluded.source_ref,
         status = excluded.status, sort_order = excluded.sort_order, updated_at = now()
         RETURNING id, kind, label, emoji, model_url, source, source_ref, status, sort_order",
    )
    .bind(&id)
    .bind(&body.kind)
    .bind(label(&body.label, 30, "invalid_label")?)
    .bind(label(&body.emoji, 16, "invalid_emoji")?)
    .bind(format!("{BLOB_PATH}/{sha}.glb"))
    .bind(format!("{job}/{version}"))
    .bind(status(body.status)?.unwrap_or_else(|| "draft".into()))
    .bind(body.sort_order.unwrap_or(100))
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(item(&row))).into_response())
}

async fn blob(State(state): State<AppState>, Path(file): Path<String>) -> ApiResult<Response> {
    let sha = file
        .strip_suffix(".glb")
        .filter(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .ok_or(not_found("not_found", "찾을 수 없습니다."))?;
    let bytes =
        tokio::fs::read(blob_path(&state, sha)).await.map_err(|_| not_found("not_found", "찾을 수 없습니다."))?;
    Ok((
        [(header::CONTENT_TYPE, "model/gltf-binary"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb() -> Vec<u8> {
        let json = br#"{"asset":{"version":"2.0"}} "#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&GLB_MAGIC.to_le_bytes());
        bytes.extend_from_slice(&GLB_VERSION.to_le_bytes());
        bytes.extend_from_slice(&((12 + 8 + json.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"JSON");
        bytes.extend_from_slice(json);
        bytes
    }

    #[test]
    fn glb_header_must_match_the_bytes() {
        let bytes = glb();
        assert!(is_glb(&bytes));
        assert!(!is_glb(b"<html>"));
        assert!(!is_glb(&bytes[..bytes.len() - 1]));
    }

    #[test]
    fn catalog_ids_are_lowercase_slugs() {
        assert!(catalog_id("factory-hero").is_ok());
        assert!(catalog_id("Hero").is_err());
        assert!(catalog_id("a").is_err());
    }
}
