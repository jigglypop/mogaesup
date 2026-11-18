//! The browser's Korean calendar supplies each home's three or four pillars. Recount both elements and determine
//! the gift from those pillars, then bind delivery to the two stored births and the signed-in giver.
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::{
    AppState,
    auth::current_user,
    error::{ApiError, ApiResult, bad, conflict},
    homes::{same_owner, visible_home},
    saju::Birth,
    saju_reading::{BRANCH_ELEMENTS, BRANCHES, STEM_ELEMENTS, STEMS},
    security::rate_limit,
};

const NO_HOME: ApiError = conflict("no_home", "두 사람 모두 사주 집이 있어야 선물할 수 있어요.");
const STALE: ApiError = conflict("stale_birth", "사주가 바뀌었어요. 화면을 새로 불러와 주세요.");
const INVALID: ApiError = bad("invalid_gift", "선물의 궁합과 오행을 확인해 주세요.");
const ELEMENTS: [&str; 5] = ["wood", "fire", "earth", "metal", "water"];

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/homes/{username}/saju/gifts", post(give))
}

#[derive(Deserialize)]
struct Design {
    tone: String,
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GiftRequest {
    expected_giver_id: Option<Uuid>,
    giver_birth: Birth,
    recipient_birth: Birth,
    giver_pillars: Vec<String>,
    recipient_pillars: Vec<String>,
    design: Design,
}

struct Chart {
    dominant: usize,
    day_stem: usize,
    day_branch: usize,
}

impl Chart {
    fn read(pillars: &[String], has_hour: bool) -> ApiResult<Self> {
        if pillars.len() != if has_hour { 4 } else { 3 } {
            return Err(INVALID);
        }
        let mut parts = Vec::with_capacity(4);
        let mut counts = [0u8; 5];
        for pillar in pillars {
            let mut chars = pillar.chars();
            let stem = chars.next().and_then(|c| STEMS.iter().position(|s| *s == c)).ok_or(INVALID)?;
            let branch = chars.next().and_then(|c| BRANCHES.iter().position(|b| *b == c)).ok_or(INVALID)?;
            if chars.next().is_some() || stem % 2 != branch % 2 {
                return Err(INVALID);
            }
            counts[STEM_ELEMENTS[stem]] += 1;
            counts[BRANCH_ELEMENTS[branch]] += 1;
            parts.push((stem, branch));
        }
        let (day_stem, day_branch) = parts[2];
        // Ties go to the day master's element, then the month branch, then 목화토금수 (profileOfReading).
        let order = [STEM_ELEMENTS[day_stem], BRANCH_ELEMENTS[parts[1].1], 0, 1, 2, 3, 4];
        let peak = counts.into_iter().max().unwrap();
        let dominant = order.into_iter().find(|i| counts[*i] == peak).unwrap();
        Ok(Self { dominant, day_stem, day_branch })
    }

    /// The same precedence as compatOf: 천간합 or 육합, then 상생, 비화, 반합 and 상극.
    fn tone(&self, other: &Self) -> &'static str {
        if self.day_stem.abs_diff(other.day_stem) == 5 || (self.day_branch + other.day_branch) % 12 == 1 {
            "union"
        } else if matches!(self.dominant.abs_diff(other.dominant), 1 | 4) {
            "flow"
        } else if self.dominant == other.dominant {
            "same"
        } else if self.day_branch != other.day_branch && self.day_branch % 4 == other.day_branch % 4 {
            "union"
        } else {
            "spark"
        }
    }
}

async fn give(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<GiftRequest>,
) -> ApiResult<StatusCode> {
    let giver = current_user(&state, &headers).await?;
    same_owner(body.expected_giver_id, giver.id)?;
    let (home, own) = visible_home(&state, &name, Some(&giver)).await?;
    if own {
        return Err(bad("own_home", "다른 사람의 집에 선물해 주세요."));
    }
    let mine = Chart::read(&body.giver_pillars, body.giver_birth.time.is_some())?;
    let theirs = Chart::read(&body.recipient_pillars, body.recipient_birth.time.is_some())?;
    let (tone, from, to) = (mine.tone(&theirs), ELEMENTS[mine.dominant], ELEMENTS[theirs.dominant]);
    if body.design.tone != tone || body.design.from != from || body.design.to != to {
        return Err(INVALID);
    }
    rate_limit(&state, format!("saju-gift:{}", giver.id), 30)?;
    let mut tx = state.db.begin().await?;
    let rows = sqlx::query("SELECT * FROM saju_homes WHERE owner_id IN ($1, $2) ORDER BY owner_id FOR SHARE")
        .bind(giver.id)
        .bind(home.owner_id)
        .fetch_all(&mut *tx)
        .await?;
    if rows.len() != 2 {
        return Err(NO_HOME);
    }
    let giver_key = body.giver_birth.key();
    let recipient_key = body.recipient_birth.key();
    for row in rows {
        let expected = if row.get::<Uuid, _>("owner_id") == giver.id { &giver_key } else { &recipient_key };
        if Birth::of(&row).key() != *expected {
            return Err(STALE);
        }
    }
    let pair_key = Sha256::digest(format!("{}|{}|{giver_key}|{recipient_key}", giver.id, home.owner_id));
    sqlx::query(
        "INSERT INTO saju_gifts (id, owner_id, giver_id, pair_key, tone, from_element, to_element)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (owner_id, giver_id, pair_key) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(home.owner_id)
    .bind(giver.id)
    .bind(&pair_key[..])
    .bind(tone)
    .bind(from)
    .bind(to)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Visitors see only keepsakes the owner has placed. A sender leaving does not take their keepsake away.
pub(super) async fn inventory(
    db: &mut PgConnection,
    owner: Uuid,
    own: bool,
    placed: &[Uuid],
) -> Result<Vec<Value>, sqlx::Error> {
    if !own && placed.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT g.*, u.username, u.display_name FROM saju_gifts g LEFT JOIN users u ON u.id = g.giver_id
         WHERE g.owner_id = $1 AND ($2 OR g.id = ANY($3)) ORDER BY g.created_at DESC, g.id",
    )
    .bind(owner)
    .bind(own)
    .bind(placed)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<Uuid, _>("id"),
                "giver": {"username": row.get::<Option<String>, _>("username").unwrap_or_default(),
                          "name": row.get::<Option<String>, _>("display_name").as_deref().unwrap_or("탈퇴한 주민")},
                "design": {"tone": row.get::<String, _>("tone"), "from": row.get::<String, _>("from_element"),
                           "to": row.get::<String, _>("to_element")},
                "givenAt": row.get::<DateTime<Utc>, _>("created_at"),
            })
        })
        .collect())
}
