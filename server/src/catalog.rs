use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use image::{ImageFormat, ImageReader, Limits};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::io::Cursor;

use crate::{
    AppState,
    auth::require_admin,
    error::{ApiResult, bad, internal, not_found},
    factory::{MAX_MODEL_BYTES, fetch_file},
    glb, slim, studio,
};

const KINDS: [&str; 2] = ["minime", "furniture"];
const STATUSES: [&str; 3] = ["draft", "published", "retired"];
/// The 미니미 picker shows pictures this big; the character server renders them at 800 px.
const THUMBNAIL_EDGE: u32 = 256;
const MAX_PICTURE_BYTES: usize = 8 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/catalog/items", get(items))
        .route("/api/catalog/admin/items", get(admin_items))
        .route("/api/catalog/admin/items/{id}", patch(update))
        .route("/api/catalog/admin/import", post(import))
        .route("/api/catalog/admin/factory-characters", get(factory_characters))
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
    let row = sqlx::query(&format!(
        "UPDATE catalog_items SET label = COALESCE($2, label), emoji = COALESCE($3, emoji), status = COALESCE($4, status),
         sort_order = COALESCE($5, sort_order), updated_at = now() WHERE id = $1 RETURNING {ITEM_COLUMNS}"
    ))
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

/// Finished characters on the character server, each with the catalog item that already holds it, if any.
async fn factory_characters(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let admin = require_admin(&state, &headers).await?;
    let characters = studio::list(&state, &admin.username).await?;
    let rows = sqlx::query("SELECT id, status, source_ref FROM catalog_items WHERE source = 'factory'")
        .fetch_all(&state.db)
        .await?;
    let characters: Vec<Value> = characters
        .into_iter()
        .map(|character| {
            let job = format!("{}/", character.job_id);
            let imported = rows.iter().find_map(|row| {
                let source: Option<String> = row.get("source_ref");
                let source = source.filter(|source| source.starts_with(&job))?;
                let current = source[job.len()..].split('/').next() == Some(character.version.as_str());
                Some(json!({"id": row.get::<String, _>("id"), "status": row.get::<String, _>("status"), "current": current}))
            });
            let mut value = serde_json::to_value(&character).unwrap_or_default();
            value["imported"] = imported.unwrap_or(Value::Null);
            value
        })
        .collect();
    Ok(Json(json!({"characters": characters})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Import {
    id: String,
    kind: String,
    label: String,
    emoji: String,
    factory_job_id: String,
    status: Option<String>,
    sort_order: Option<i32>,
}

/// The character server's front render, shrunk; None when it cannot be read. `image` reads it within fixed bounds.
fn thumbnail(png: &[u8]) -> Option<Vec<u8>> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let picture = reader.decode().ok()?.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE);
    let mut out = Cursor::new(Vec::new());
    picture.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Copies a finished character from the character server into the catalog as a draft: its playable model (the copy
/// with the chosen face, when there is one), checked against the server's record and for a rig with idle and walk,
/// and its front render. Both go to the model store; publishing the item puts it in the 미니미 picker.
async fn import(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Import>) -> ApiResult<Response> {
    let admin = require_admin(&state, &headers).await?;
    let id = catalog_id(&body.id)?.to_owned();
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(bad("invalid_kind", "종류를 확인해 주세요."));
    }
    let label_text = label(&body.label, 30, "invalid_label")?;
    let emoji = label(&body.emoji, 16, "invalid_emoji")?;
    let status = status(body.status)?.unwrap_or_else(|| "draft".into());
    let source = studio::source(&state, &admin.username, &body.factory_job_id).await?;
    let bytes = fetch_file(&state, &admin.username, &source.model_path, MAX_MODEL_BYTES).await?;
    if source.model_sha256.as_ref().is_some_and(|expected| *expected != hex::encode(Sha256::digest(&bytes))) {
        return Err(bad("factory_checksum", "받은 모델이 캐릭터 서버의 기록과 다릅니다. 다시 시도해 주세요."));
    }
    let summary = glb::inspect(&bytes).ok_or(bad("not_glb", "GLB 파일이 아닙니다."))?;
    if body.kind == "minime" && !summary.playable() {
        return Err(bad("not_playable", "미니미로 쓰려면 리깅(스킨)과 idle·walk 애니메이션이 있어야 합니다."));
    }
    let original = bytes.len();
    let bytes = tokio::task::spawn_blocking(move || slim::slim(&bytes).unwrap_or(bytes)).await.map_err(internal)?;
    tracing::info!(original, slimmed = bytes.len(), "Catalog model textures sized for the web");
    let model_url = state.config.models.put("glb", bytes).await?;
    let picture = match fetch_file(&state, &admin.username, &source.thumbnail_path, MAX_PICTURE_BYTES).await {
        Ok(png) => thumbnail(&png),
        Err(_) => None,
    };
    let thumbnail_url = match picture {
        Some(png) => Some(state.config.models.put("png", png).await?),
        None => None,
    };
    let job = studio::segment(&body.factory_job_id).unwrap_or_default();
    let source_ref = match &source.expression {
        Some(expression) => format!("{job}/{}/{expression}", source.version),
        None => format!("{job}/{}", source.version),
    };
    let row = sqlx::query(&format!(
        "INSERT INTO catalog_items (id, kind, label, emoji, model_url, thumbnail_url, clips, source, source_ref, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'factory', $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, label = excluded.label, emoji = excluded.emoji,
         model_url = excluded.model_url, thumbnail_url = excluded.thumbnail_url, clips = excluded.clips, source = 'factory',
         source_ref = excluded.source_ref, status = excluded.status, sort_order = excluded.sort_order, updated_at = now()
         RETURNING {ITEM_COLUMNS}"
    ))
    .bind(&id)
    .bind(&body.kind)
    .bind(label_text)
    .bind(emoji)
    .bind(model_url)
    .bind(thumbnail_url)
    .bind(&summary.clips)
    .bind(source_ref)
    .bind(status)
    .bind(body.sort_order.unwrap_or(100))
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(item(&row))).into_response())
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
    fn thumbnails_shrink_to_the_picker_size_and_keep_transparency() {
        let mut canvas = image::RgbaImage::new(800, 600);
        canvas.put_pixel(400, 300, image::Rgba([255, 0, 0, 255]));
        let mut png = Cursor::new(Vec::new());
        canvas.write_to(&mut png, ImageFormat::Png).unwrap();
        let small = image::load_from_memory(&thumbnail(png.get_ref()).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (256, 192));
        assert!(small.color().has_alpha());
        assert!(thumbnail(b"not a picture").is_none());
    }
}
