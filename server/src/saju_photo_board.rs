use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, codecs::jpeg::JpegEncoder};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Cursor;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{current_user, optional_user},
    error::{ApiError, ApiResult, bad, conflict, internal, not_found},
    homes::{PICTURE_SAVING, limited_body, same_owner, visible_home},
    security::{rate_limit, rate_running},
    share,
};

const EDGE: u32 = 1280;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_BODY: usize = MAX_BYTES.div_ceil(3) * 4 + 512;
const INVALID: ApiError = bad("invalid_photo", "사진을 읽을 수 없어요. 다른 사진을 선택해 주세요.");
const LARGE: ApiError = ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "photo_too_large", "전광판 사진이 너무 커요.");
const NO_HOME: ApiError = conflict("no_home", "사주 집을 지은 뒤 사진을 올려 주세요.");

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/homes/me/saju/photo-board", put(save).delete(remove))
        .route("/api/homes/{username}/saju/photo-board/{version}", get(view))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    expected_owner_id: Option<Uuid>,
    image: String,
}

/// Check the header before allocating pixels. Re-encoding discards metadata and trailing bytes even for direct API callers.
fn normalized(data: String) -> ApiResult<(u32, u32, Vec<u8>)> {
    let encoded = data.strip_prefix("data:image/jpeg;base64,").ok_or(INVALID)?;
    let bytes = STANDARD.decode(encoded).map_err(|_| INVALID)?;
    if bytes.len() > MAX_BYTES {
        return Err(LARGE);
    }
    let reader = || ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Jpeg);
    let (width, height) = reader().into_dimensions().map_err(|_| INVALID)?;
    if width == 0 || height == 0 || width > EDGE || height > EDGE {
        return Err(LARGE);
    }
    let pixels = reader().decode().map_err(|_| INVALID)?.into_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 88)
        .encode(pixels.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .map_err(internal)?;
    Ok((width, height, jpeg))
}

async fn save(State(state): State<AppState>, headers: HeaderMap, body: Body) -> ApiResult<Json<Value>> {
    let owner = current_user(&state, &headers).await?;
    rate_limit(&state, format!("saju-photo-board:{}", owner.id), 30)?;
    // One photo of a member's at a time, and decoded as the site's other pictures are: a few at once across the server.
    let _uploading =
        rate_running(&state, &format!("saju-photo-board-running:{}", owner.id), 1)?.ok_or(PICTURE_SAVING)?;
    let bytes = limited_body(body, MAX_BODY, LARGE, INVALID).await?;
    let upload: Upload = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    same_owner(upload.expected_owner_id, owner.id)?;
    drop(bytes);
    let permit = share::decoding_slot(share::DECODE_WAIT).await?;
    let (width, height, jpeg) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        normalized(upload.image)
    })
    .await
    .map_err(internal)??;
    let version = Uuid::new_v4();
    let saved = sqlx::query(
        "INSERT INTO saju_photo_boards (owner_id, version, width, height, jpeg)
         SELECT owner_id, $2, $3, $4, $5 FROM saju_homes WHERE owner_id = $1
         ON CONFLICT (owner_id) DO UPDATE SET version = excluded.version, width = excluded.width,
             height = excluded.height, jpeg = excluded.jpeg",
    )
    .bind(owner.id)
    .bind(version)
    .bind(width as i32)
    .bind(height as i32)
    .bind(jpeg)
    .execute(&state.db)
    .await?;
    if saved.rows_affected() == 0 {
        return Err(NO_HOME);
    }
    Ok(Json(json!({"version": version, "width": width, "height": height})))
}

async fn view(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((name, version)): Path<(String, Uuid)>,
) -> ApiResult<Response> {
    let viewer = optional_user(&state, &headers).await?;
    let (home, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let jpeg: Vec<u8> = sqlx::query_scalar("SELECT jpeg FROM saju_photo_boards WHERE owner_id = $1 AND version = $2")
        .bind(home.owner_id)
        .bind(version)
        .fetch_optional(&state.db)
        .await?
        .ok_or(not_found("photo_not_found", "전광판에 이 사진이 없어요."))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, no-store")], jpeg).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    expected_owner_id: Option<Uuid>,
}

async fn remove(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Removal>) -> ApiResult<StatusCode> {
    let owner = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, owner.id)?;
    sqlx::query("DELETE FROM saju_photo_boards WHERE owner_id = $1").bind(owner.id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
