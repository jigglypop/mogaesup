//! A member's 사주 home: the name on its gate and the birth its chart is read from.
//!
//! The app works a chart out in the browser, where the calendar tables are, so the server keeps what was entered and
//! hands it to whoever may see the member's home ([`visible_home`]): the home's visibility and 이웃 decide that, as
//! they do for its guestbook. A home's village is its owner's 이웃 who built a home of their own (their houses stand
//! whoever looks; only those the viewer may see can be visited) and, in the places they leave, the public homes built
//! most recently.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, put},
};
use chrono::{Days, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{STAFF_NAME, current_user, optional_user, reads_as_staff},
    error::{ApiError, ApiResult, bad},
    homes::{same_owner, visible_home},
    rebac::{Checker, Object, Subject},
    security::{plain_text, rate_limit},
    social::card,
};

/// Homes a village shows around its own: one on each side and corner of the map.
const VILLAGE_HOMES: usize = 8;
/// Saves of one member's 사주 in the rate window (ten minutes).
const SAVES_PER_MEMBER: u32 = 30;
const NAME_MAX: usize = 12;
/// Years a birth may name. The app's calendar decides whether the date exists; this only keeps nonsense out.
const YEARS: std::ops::RangeInclusive<i16> = 1000..=2200;

const INVALID_NAME: ApiError = bad("invalid_name", "이름은 1~12자로 적어 주세요.");
const INVALID_BIRTH: ApiError = bad("invalid_birth", "생년월일과 태어난 시간을 확인해 주세요.");

const COLUMNS: &str = "s.name AS saju_name, s.calendar, s.birth_year, s.birth_month, s.birth_day, s.leap_month,
    s.birth_time, s.gender";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/homes/me/saju", put(save).delete(remove)).route("/api/homes/{username}/saju", get(view))
}

/// A stored home as the app reads it.
fn home(row: &PgRow) -> Value {
    json!({
        "name": row.get::<String, _>("saju_name"),
        "birth": {
            "calendar": row.get::<String, _>("calendar"),
            "year": row.get::<i16, _>("birth_year"),
            "month": row.get::<i16, _>("birth_month"),
            "day": row.get::<i16, _>("birth_day"),
            "leapMonth": row.get::<bool, _>("leap_month"),
            "time": row.get::<Option<String>, _>("birth_time"),
            "gender": row.get::<String, _>("gender"),
        },
    })
}

/// `GET /api/homes/{username}/saju`: the member's 사주 home (`saju`, null until they build one) and the village around
/// it (`village`). Their 이웃 come first (`neighbour: true`; the viewer before the others, then the oldest 이웃), each
/// house standing whoever looks; `visitable` says whether this viewer may go on to that 이웃's 섬 (a home kept to its
/// 이웃 or to its owner stands in the village all the same, closed). The places left go to the public homes built or
/// built again most recently. What the owner agreed to share (the chart's details, the reading) is the page's to hold
/// back, by each home's `shared`: a house is drawn from the birth.
async fn view(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    let viewer = optional_user(&state, &headers).await?;
    let (profile, _) = visible_home(&state, &name, viewer.as_ref()).await?;
    let own = sqlx::query(&format!("SELECT {COLUMNS} FROM saju_homes s WHERE s.owner_id = $1"))
        .bind(profile.owner_id)
        .fetch_optional(&state.db)
        .await?;
    let viewer_id = viewer.as_ref().map(|user| user.id);
    // Whether the viewer may go into each 이웃's 섬, read with the rows: a public home, the viewer's own, or one kept to
    // its 이웃 when the viewer is one (rebac's home facts). A home with grants of its own (`auth_tuples`) is asked of
    // the checker, as every one once was, one query or two each.
    let rows = sqlx::query(&format!(
        "SELECT u.id, u.username, u.display_name, h.emoji, h.visibility, {COLUMNS},
           u.saju_share_consent_at IS NOT NULL AS shared,
           (h.visibility = 'public' OR u.id IS NOT DISTINCT FROM $2
             OR (h.visibility = 'ilchon' AND EXISTS (SELECT 1 FROM ilchons v WHERE v.user_id = $2 AND v.friend_id = u.id)))
             AS open,
           EXISTS (SELECT 1 FROM auth_tuples t WHERE t.object_type = 'home' AND t.object_id = u.id::text) AS granted
         FROM ilchons mine
         JOIN ilchons theirs ON theirs.user_id = mine.friend_id AND theirs.friend_id = mine.user_id
         JOIN users u ON u.id = mine.friend_id
         JOIN homes h ON h.owner_id = u.id
         JOIN saju_homes s ON s.owner_id = u.id
         WHERE mine.user_id = $1
         ORDER BY (u.id IS NOT DISTINCT FROM $2) DESC, mine.since, u.id LIMIT $3"
    ))
    .bind(profile.owner_id)
    .bind(viewer_id)
    .bind(VILLAGE_HOMES as i64)
    .fetch_all(&state.db)
    .await?;
    let subject = viewer_id.map_or(Subject::Anonymous, Subject::User);
    let mut village = Vec::new();
    let mut placed = vec![profile.owner_id];
    for row in &rows {
        let owner: Uuid = row.get("id");
        let visitable = row.get::<bool, _>("open")
            || (viewer_id.is_some() && row.get::<bool, _>("granted") && {
                let mut checker = Checker::new(&state.db);
                checker.know_home(owner, row.get::<String, _>("visibility").as_str());
                checker.check(subject, &Object::home(owner), "viewer").await?
            });
        village.push(json!({
            "user": card(row, ""), "saju": home(row), "neighbour": true, "visitable": visitable,
            "shared": row.get::<bool, _>("shared"),
        }));
        placed.push(owner);
    }
    if village.len() < VILLAGE_HOMES {
        let others = sqlx::query(&format!(
            "SELECT u.id, u.username, u.display_name, h.emoji, {COLUMNS}, u.saju_share_consent_at IS NOT NULL AS shared
             FROM saju_homes s JOIN users u ON u.id = s.owner_id JOIN homes h ON h.owner_id = u.id
             WHERE h.visibility = 'public' AND NOT (u.id = ANY($1))
             ORDER BY s.updated_at DESC, u.id LIMIT $2"
        ))
        .bind(&placed)
        .bind((VILLAGE_HOMES - village.len()) as i64)
        .fetch_all(&state.db)
        .await?;
        village.extend(others.iter().map(|row| {
            json!({
                "user": card(row, ""), "saju": home(row), "neighbour": false, "visitable": true,
                "shared": row.get::<bool, _>("shared"),
            })
        }));
    }
    Ok(Json(json!({"saju": own.as_ref().map(home), "village": village})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Birth {
    pub(crate) calendar: String,
    pub(crate) year: i16,
    pub(crate) month: i16,
    pub(crate) day: i16,
    #[serde(default)]
    pub(crate) leap_month: bool,
    /// `HH:MM`, or nothing when the hour is not known.
    pub(crate) time: Option<String>,
    pub(crate) gender: String,
}

impl Birth {
    /// The birth a stored home was built from.
    pub(crate) fn of(row: &PgRow) -> Self {
        Self {
            calendar: row.get("calendar"),
            year: row.get("birth_year"),
            month: row.get("birth_month"),
            day: row.get("birth_day"),
            leap_month: row.get("leap_month"),
            time: row.get("birth_time"),
            gender: row.get("gender"),
        }
    }

    /// What tells one birth from another: what the server makes for a home from its chart is kept under it, and a home
    /// built again from another birth has none of it.
    pub(crate) fn key(&self) -> String {
        let leap = if self.leap_month { "leap" } else { "plain" };
        let time = self.time.as_deref().unwrap_or("-");
        format!("{}:{:04}-{:02}-{:02}:{leap}:{time}:{}", self.calendar, self.year, self.month, self.day, self.gender)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Save {
    /// The account the page was loaded for. A missing value must refuse the save.
    expected_owner_id: Option<Uuid>,
    name: String,
    birth: Birth,
}

fn clock_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && [0, 1, 3, 4].iter().all(|&at| bytes[at].is_ascii_digit())
        && &time[..2] <= "23"
        && &time[3..] <= "59"
}

/// A birth worth keeping: fields in range, a solar date that exists and is not ahead of today, an hour on the clock.
/// Whether a lunar date exists is the app's calendar to say; one that does not builds no home there.
fn checked(mut birth: Birth) -> ApiResult<Birth> {
    let lunar = match birth.calendar.as_str() {
        "solar" => false,
        "lunar" => true,
        _ => return Err(INVALID_BIRTH),
    };
    if !matches!(birth.gender.as_str(), "female" | "male") || !YEARS.contains(&birth.year) {
        return Err(INVALID_BIRTH);
    }
    if lunar {
        if !(1..=12).contains(&birth.month) || !(1..=30).contains(&birth.day) {
            return Err(INVALID_BIRTH);
        }
    } else {
        let date = u32::try_from(birth.month)
            .ok()
            .zip(u32::try_from(birth.day).ok())
            .and_then(|(month, day)| NaiveDate::from_ymd_opt(birth.year.into(), month, day))
            .ok_or(INVALID_BIRTH)?;
        // Seoul's today is at most a day ahead of the server's.
        if date > Utc::now().date_naive() + Days::new(1) {
            return Err(INVALID_BIRTH);
        }
    }
    birth.leap_month &= lunar;
    if birth.time.as_deref().is_some_and(|time| !clock_time(time)) {
        return Err(INVALID_BIRTH);
    }
    Ok(birth)
}

/// `PUT /api/homes/me/saju`: builds the caller's 사주 home, or builds it again from a corrected name or birth.
async fn save(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Save>) -> ApiResult<Json<Value>> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || !plain_text(name, false) {
        return Err(INVALID_NAME);
    }
    // The name every village shows for the member: none that reads as the site's staff, as for a display name.
    if user.role != "admin" && reads_as_staff(name) {
        return Err(STAFF_NAME);
    }
    let birth = checked(body.birth)?;
    rate_limit(&state, format!("saju-save:{}", user.id), SAVES_PER_MEMBER)?;
    let mut tx = state.db.begin().await?;
    crate::homes::create(&mut *tx, &user).await?;
    sqlx::query(
        "INSERT INTO saju_homes (owner_id, name, calendar, birth_year, birth_month, birth_day, leap_month, birth_time, gender)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (owner_id) DO UPDATE SET name = excluded.name, calendar = excluded.calendar,
         birth_year = excluded.birth_year, birth_month = excluded.birth_month, birth_day = excluded.birth_day,
         leap_month = excluded.leap_month, birth_time = excluded.birth_time, gender = excluded.gender, updated_at = now()",
    )
    .bind(user.id)
    .bind(name)
    .bind(&birth.calendar)
    .bind(birth.year)
    .bind(birth.month)
    .bind(birth.day)
    .bind(birth.leap_month)
    .bind(&birth.time)
    .bind(&birth.gender)
    .execute(&mut *tx)
    .await?;
    // A reading or picture made from another birth is not this home's any more.
    crate::saju_made::forget_other_births(&mut tx, user.id, &birth.key()).await?;
    // A home built or built again is a change to the member's 섬: the listing shows it among the newest.
    sqlx::query("UPDATE homes SET updated_at = now() WHERE owner_id = $1").bind(user.id).execute(&mut *tx).await?;
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM saju_homes s WHERE s.owner_id = $1"))
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"saju": home(&row)})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    /// The account the page was loaded for. A missing value must refuse the removal.
    expected_owner_id: Option<Uuid>,
}

/// `DELETE /api/homes/me/saju`: takes the caller's 사주 home down, and its reading and picture with it (the database
/// cascades). Their guestbook and 이웃 stay.
async fn remove(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Removal>) -> ApiResult<StatusCode> {
    let user = current_user(&state, &headers).await?;
    same_owner(body.expected_owner_id, user.id)?;
    sqlx::query("DELETE FROM saju_homes WHERE owner_id = $1").bind(user.id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn birth(value: Value) -> ApiResult<Birth> {
        checked(serde_json::from_value(value).unwrap())
    }

    #[test]
    fn 양력_생일은_달력에_있고_오늘보다_앞서지_않아야_한다() {
        let solar = |year: i16, month: i16, day: i16| {
            birth(
                json!({"calendar": "solar", "year": year, "month": month, "day": day, "time": null, "gender": "female"}),
            )
        };
        assert!(solar(1992, 2, 29).is_ok());
        assert!(solar(1993, 2, 29).is_err());
        assert!(solar(1990, 13, 1).is_err());
        assert!(solar(1990, 0, 1).is_err());
        assert!(solar(2199, 1, 1).is_err());
        assert!(solar(999, 1, 1).is_err());
    }

    #[test]
    fn 윤달은_음력에만_남고_시간은_시계에_있는_값만_받는다() {
        let lunar = |time: Value, leap: bool| {
            birth(
                json!({"calendar": "lunar", "year": 1988, "month": 8, "day": 21, "leapMonth": leap, "time": time, "gender": "male"}),
            )
        };
        assert!(lunar(json!("06:15"), true).unwrap().leap_month);
        assert!(lunar(Value::Null, false).unwrap().time.is_none());
        for time in ["24:00", "12:60", "6:15", "06-15", "0615", "ab:cd", "06:15 "] {
            assert!(lunar(json!(time), false).is_err(), "{time}");
        }
        let solar = birth(
            json!({"calendar": "solar", "year": 1988, "month": 8, "day": 21, "leapMonth": true, "time": "23:59", "gender": "male"}),
        );
        assert!(!solar.unwrap().leap_month);
        assert!(
            birth(json!({"calendar": "lunar", "year": 1988, "month": 8, "day": 31, "time": null, "gender": "male"}))
                .is_err()
        );
        assert!(
            birth(json!({"calendar": "solar", "year": 1988, "month": 8, "day": 21, "time": null, "gender": "other"}))
                .is_err()
        );
        assert!(
            birth(json!({"calendar": "julian", "year": 1988, "month": 8, "day": 21, "time": null, "gender": "male"}))
                .is_err()
        );
    }
}
