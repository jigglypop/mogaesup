use axum::{Json, Router, extract::State, http::HeaderMap, routing::put};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    AppState,
    auth::current_user,
    error::{ApiResult, bad, conflict},
    homes::same_owner,
    saju_decor::shown,
    security::rate_limit,
};

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/homes/me/saju/terrain", put(save))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    expected_owner_id: Option<Uuid>,
    terrain: String,
}

async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Choice>) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    if !matches!(body.terrain.as_str(), "default" | "snow" | "desert" | "moss") {
        return Err(bad("invalid_terrain", "목록에서 땅 타일을 골라 주세요."));
    }
    rate_limit(&state, format!("saju-terrain:{}", user.id), 60)?;
    let mut tx = state.db.begin().await?;
    let saved = sqlx::query(
        "INSERT INTO saju_decor (owner_id, terrain)
         SELECT owner_id, $2 FROM saju_homes WHERE owner_id = $1 FOR KEY SHARE
         ON CONFLICT (owner_id) DO UPDATE SET terrain = EXCLUDED.terrain, updated_at = now()",
    )
    .bind(user.id)
    .bind(body.terrain)
    .execute(&mut *tx)
    .await?;
    if saved.rows_affected() == 0 {
        return Err(conflict("no_home", "아직 지은 사주 집이 없어요."));
    }
    let decor = shown(&mut tx, user.id, true).await?;
    tx.commit().await?;
    Ok(Json(decor))
}
