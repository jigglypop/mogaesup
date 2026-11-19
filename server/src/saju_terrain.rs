use axum::{Json, Router, extract::State, http::HeaderMap, routing::put};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
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
struct Tile {
    x: i32,
    z: i32,
    terrain: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    expected_owner_id: Option<Uuid>,
    terrain: Option<String>,
    tiles: Option<Vec<Tile>>,
}

/// The whole of an estate's lawn, 48 metres across (the app's MOST_CELLS).
const MOST_TILES: usize = 48 * 48;

/// Painted cells, each a metre and a known terrain, with no cell twice.
fn checked_tiles(tiles: &[Tile]) -> ApiResult<Vec<Value>> {
    if tiles.len() > MOST_TILES {
        return Err(bad("invalid_terrain", "칸은 2304개까지 깔 수 있어요."));
    }
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(tiles.len());
    for tile in tiles {
        if !matches!(tile.terrain.as_str(), "snow" | "desert" | "moss") || tile.x.abs() > 40 || tile.z.abs() > 40 {
            return Err(bad("invalid_terrain", "목록에서 땅 타일을 골라 주세요."));
        }
        if !seen.insert((tile.x, tile.z)) {
            return Err(bad("invalid_terrain", "같은 칸에 타일이 두 번 있어요."));
        }
        kept.push(json!({"x": tile.x, "z": tile.z, "terrain": tile.terrain}));
    }
    Ok(kept)
}

async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Choice>) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    if body.terrain.is_none() && body.tiles.is_none() {
        return Err(bad("invalid_terrain", "목록에서 땅 타일을 골라 주세요."));
    }
    if let Some(terrain) = &body.terrain
        && !matches!(terrain.as_str(), "default" | "snow" | "desert" | "moss")
    {
        return Err(bad("invalid_terrain", "목록에서 땅 타일을 골라 주세요."));
    }
    let tiles = body.tiles.as_deref().map(checked_tiles).transpose()?;
    rate_limit(&state, format!("saju-terrain:{}", user.id), 60)?;
    let mut tx = state.db.begin().await?;
    let saved = sqlx::query(
        "INSERT INTO saju_decor (owner_id, terrain, tiles)
         SELECT owner_id, COALESCE($2, 'default'), COALESCE($3, '[]'::jsonb) FROM saju_homes WHERE owner_id = $1 FOR KEY SHARE
         ON CONFLICT (owner_id) DO UPDATE SET
           terrain = COALESCE($2, saju_decor.terrain),
           tiles = COALESCE($3, saju_decor.tiles),
           updated_at = now()",
    )
    .bind(user.id)
    .bind(body.terrain)
    .bind(tiles.map(|tiles| json!(tiles)))
    .execute(&mut *tx)
    .await?;
    if saved.rows_affected() == 0 {
        return Err(conflict("no_home", "아직 지은 사주 집이 없어요."));
    }
    let decor = shown(&mut tx, user.id, true).await?;
    tx.commit().await?;
    Ok(Json(decor))
}

#[cfg(test)]
mod tests {
    use super::{Tile, checked_tiles};

    #[test]
    fn 칸_타일은_알려진_땅만_한_칸에_하나다() {
        let tiles = vec![Tile { x: 1, z: -2, terrain: "snow".into() }, Tile { x: 1, z: -2, terrain: "moss".into() }];
        assert!(checked_tiles(&tiles).is_err());
        assert!(checked_tiles(&[Tile { x: 41, z: 0, terrain: "snow".into() }]).is_err());
        assert!(checked_tiles(&[Tile { x: 0, z: 0, terrain: "default".into() }]).is_err());
        let kept = checked_tiles(&[Tile { x: 3, z: 4, terrain: "desert".into() }]).unwrap();
        assert_eq!(kept[0]["terrain"], "desert");
    }
}
