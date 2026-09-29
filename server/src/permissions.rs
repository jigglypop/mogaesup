//! `/api/admin/permissions/*`: the admin page's view of [`rebac`]. People and groups with what they were granted,
//! granting and revoking with a reason (every change lands in `auth_audit`), tuples by object or subject, a check with
//! its explanation, who holds a relation, and the audit log. Admins only.
//!
//! Objects and subjects are written as in the tuples (`system:mogaesup`, `group:crew#member`); a user may also be named
//! by username (`user:ydh2244`) and a home by its owner's (`home:ydh2244`). Answers name users by id and carry a
//! `users` map from id to username and display name.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::{Row, postgres::PgRow};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{User, require, username},
    error::{ApiError, ApiResult, bad, conflict, not_found},
    rebac::{
        self, ADMIN, Actor, Checker, Expansion, Invalid, Kind, Object, PERMISSIONS, RevokeError, Rule, SCHEMA, Subject,
        SubjectRef, Trace, Tuple,
    },
};

const USER_NOT_FOUND: ApiError = not_found("user_not_found", "없는 사용자입니다.");
const HOME_NOT_FOUND: ApiError = not_found("home_not_found", "없는 섬입니다.");
const INVALID_OBJECT: ApiError = bad("invalid_object", "권한 대상을 확인해 주세요.");
const INVALID_SUBJECT: ApiError = bad("invalid_subject", "권한을 받을 사람이나 그룹을 확인해 주세요.");
const INVALID_RELATION: ApiError = bad("invalid_relation", "그 대상에 없는 관계입니다.");
const LAST_ADMIN: ApiError = conflict("last_admin", "마지막 관리자는 해제할 수 없습니다.");
const MAX_TUPLES: i64 = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/permissions/schema", get(schema))
        .route("/api/admin/permissions/users", get(users))
        .route("/api/admin/permissions/users/{name}", get(user))
        .route("/api/admin/permissions/groups", get(groups))
        .route("/api/admin/permissions/tuples", get(tuples))
        .route("/api/admin/permissions/grant", post(grant))
        .route("/api/admin/permissions/revoke", post(revoke))
        .route("/api/admin/permissions/check", get(check))
        .route("/api/admin/permissions/expand", get(expand))
        .route("/api/admin/permissions/audit", get(audit))
}

fn invalid(reason: Invalid) -> ApiError {
    match reason {
        Invalid::Object => INVALID_OBJECT,
        Invalid::Relation => bad("invalid_relation", "줄 수 있는 관계가 아닙니다."),
        Invalid::Subject => INVALID_SUBJECT,
        Invalid::NotAllowed => bad("subject_not_allowed", "이 관계는 그 대상에게 줄 수 없습니다."),
        Invalid::SelfMember => bad("self_member", "그룹을 자기 구성원으로 넣을 수 없습니다."),
    }
}

/// A user by id or username.
async fn user_id(state: &AppState, text: &str) -> ApiResult<Uuid> {
    let found: Option<Uuid> = match Uuid::parse_str(text) {
        Ok(id) => sqlx::query_scalar("SELECT id FROM users WHERE id = $1").bind(id).fetch_optional(&state.db).await?,
        Err(_) => {
            sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
                .bind(username(text).map_err(|_| USER_NOT_FOUND)?)
                .fetch_optional(&state.db)
                .await?
        }
    };
    found.ok_or(USER_NOT_FOUND)
}

/// `system:mogaesup`, `catalog:mogaesup`, `group:<id>` or `home:<username or owner id>`; a home must exist.
async fn object_ref(state: &AppState, text: &str) -> ApiResult<Object> {
    let (kind, id) = text.trim().split_once(':').ok_or(INVALID_OBJECT)?;
    match Kind::parse(kind).ok_or(INVALID_OBJECT)? {
        Kind::Home => {
            let owner = user_id(state, id).await.map_err(|_| HOME_NOT_FOUND)?;
            let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM homes WHERE owner_id = $1)")
                .bind(owner)
                .fetch_one(&state.db)
                .await?;
            if exists { Ok(Object::home(owner)) } else { Err(HOME_NOT_FOUND) }
        }
        Kind::User => Err(INVALID_OBJECT),
        kind => {
            let object = Object::new(kind, id);
            if object.well_formed() { Ok(object) } else { Err(INVALID_OBJECT) }
        }
    }
}

/// `user:<username or id>` (who must exist), or `group:<id>` / `group:<id>#member` for the group's members.
async fn subject_ref(state: &AppState, text: &str) -> ApiResult<SubjectRef> {
    let text = text.trim();
    if let Some(user) = text.strip_prefix("user:") {
        return Ok(SubjectRef::user(user_id(state, user).await?));
    }
    let group = text.strip_prefix("group:").ok_or(INVALID_SUBJECT)?;
    let group = group.strip_suffix("#member").unwrap_or(group);
    if rebac::group_id(group) { Ok(SubjectRef::members(group)) } else { Err(INVALID_SUBJECT) }
}

/// The user an id-bearing name stands for: `user:<id>`, `home:<owner id>`, possibly with `#relation`.
fn named_user(text: &str) -> Option<Uuid> {
    let (kind, rest) = text.split_once(':')?;
    if kind != "user" && kind != "home" {
        return None;
    }
    Uuid::parse_str(rest.split('#').next()?).ok()
}

/// Username and display name for each of `ids`, keyed by id.
async fn people(state: &AppState, ids: BTreeSet<Uuid>) -> ApiResult<Value> {
    let mut found = Map::new();
    if ids.is_empty() {
        return Ok(Value::Object(found));
    }
    let ids: Vec<Uuid> = ids.into_iter().collect();
    let rows = sqlx::query("SELECT id, username, display_name FROM users WHERE id = ANY($1)")
        .bind(ids)
        .fetch_all(&state.db)
        .await?;
    for row in rows {
        found.insert(
            row.get::<Uuid, _>("id").to_string(),
            json!({"username": row.get::<String, _>("username"), "displayName": row.get::<String, _>("display_name")}),
        );
    }
    Ok(Value::Object(found))
}

const TUPLE_SELECT: &str = "SELECT t.object_type, t.object_id, t.relation, t.subject_type, t.subject_id,
    t.subject_relation, t.created_at, c.username AS created_by FROM auth_tuples t LEFT JOIN users c ON c.id = t.created_by";
const TUPLE_ORDER: &str = "ORDER BY t.object_type, t.object_id, t.relation, t.subject_type, t.subject_id";

fn object_text(row: &PgRow) -> String {
    format!("{}:{}", row.get::<&str, _>("object_type"), row.get::<&str, _>("object_id"))
}

fn subject_text(row: &PgRow) -> String {
    let subject = format!("{}:{}", row.get::<&str, _>("subject_type"), row.get::<&str, _>("subject_id"));
    match row.get::<Option<&str>, _>("subject_relation") {
        Some(relation) => format!("{subject}#{relation}"),
        None => subject,
    }
}

fn tuple_json(row: &PgRow) -> Value {
    json!({
        "object": object_text(row),
        "relation": row.get::<String, _>("relation"),
        "subject": subject_text(row),
        "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
        "createdBy": row.get::<Option<String>, _>("created_by"),
    })
}

fn tuple_users(rows: &[PgRow]) -> BTreeSet<Uuid> {
    rows.iter().flat_map(|row| [named_user(&object_text(row)), named_user(&subject_text(row))]).flatten().collect()
}

/// `GET /api/admin/permissions/schema`: every type's relations, who each may be granted to, what each implies, and
/// the permissions the app checks.
async fn schema(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let types: Vec<Value> = SCHEMA
        .iter()
        .map(|def| {
            let relations: Vec<Value> = def
                .relations
                .iter()
                .map(|relation| {
                    let rewrite: Vec<Value> = relation
                        .rewrite
                        .iter()
                        .map(|rule| match *rule {
                            Rule::This => json!({"this": true}),
                            Rule::Computed(other) => json!({"computed": other}),
                            Rule::Site(kind, other) => {
                                json!({"relation": format!("{}:{}#{other}", kind.as_str(), rebac::SITE)})
                            }
                            Rule::Fact(fact) => json!({"fact": fact}),
                        })
                        .collect();
                    json!({"name": relation.name, "subjects": relation.subjects, "rewrite": rewrite})
                })
                .collect();
            json!({"type": def.kind, "relations": relations})
        })
        .collect();
    let permissions: Vec<Value> = PERMISSIONS
        .iter()
        .map(|permission| {
            json!({"name": permission.name, "object": permission.object().to_string(), "relation": permission.relation})
        })
        .collect();
    Ok(Json(json!({"types": types, "permissions": permissions})))
}

#[derive(Deserialize)]
struct UserSearch {
    #[serde(default)]
    q: String,
    /// Only people named by some tuple.
    #[serde(default)]
    granted: bool,
    limit: Option<i64>,
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// `GET /api/admin/permissions/users?q=&granted=true`: people by username prefix or display name (`matches`), each with
/// the tuples that name them directly.
async fn users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(search): Query<UserSearch>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let query = search.q.trim();
    if query.chars().count() > 40 {
        return Err(bad("invalid_query", "검색어는 40자 이하로 입력해 주세요."));
    }
    let rows = sqlx::query(
        "SELECT u.id, u.username, u.display_name, u.created_at FROM users u
         WHERE ($1 = '' OR u.username LIKE lower($1) || '%' OR u.display_name ILIKE '%' || $1 || '%')
           AND (NOT $2 OR EXISTS (SELECT 1 FROM auth_tuples t WHERE t.subject_type = 'user' AND t.subject_id = u.id::text))
         ORDER BY u.username LIMIT $3",
    )
    .bind(like_escape(query))
    .bind(search.granted)
    .bind(search.limit.unwrap_or(30).clamp(1, 100))
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.get::<Uuid, _>("id").to_string()).collect();
    let grants = sqlx::query(
        "SELECT subject_id, object_type, object_id, relation FROM auth_tuples
         WHERE subject_type = 'user' AND subject_id = ANY($1) ORDER BY object_type, object_id, relation",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let mut held: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut homes = BTreeSet::new();
    for row in &grants {
        let object = object_text(row);
        homes.extend(named_user(&object));
        held.entry(row.get("subject_id"))
            .or_default()
            .push(json!({"object": object, "relation": row.get::<String, _>("relation")}));
    }
    let matches: Vec<Value> = rows
        .iter()
        .zip(&ids)
        .map(|(row, id)| {
            json!({
                "id": id,
                "username": row.get::<String, _>("username"),
                "displayName": row.get::<String, _>("display_name"),
                "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
                "grants": held.remove(id).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({"matches": matches, "users": people(&state, homes).await?})))
}

/// `GET /api/admin/permissions/users/{username or id}`: the person, every tuple naming them directly, and each
/// permission the app checks as it stands for them.
async fn user(State(state): State<AppState>, headers: HeaderMap, Path(name): Path<String>) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let id = user_id(&state, &name).await?;
    let row = sqlx::query("SELECT id, username, display_name, created_at FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let grants = sqlx::query(&format!(
        "{TUPLE_SELECT} WHERE t.subject_type = 'user' AND t.subject_id = $1 {TUPLE_ORDER} LIMIT {MAX_TUPLES}"
    ))
    .bind(id.to_string())
    .fetch_all(&state.db)
    .await?;
    let mut checker = Checker::new(&state.db);
    let mut permissions = Map::new();
    for permission in PERMISSIONS {
        permissions.insert(permission.name.into(), json!(checker.allows(Subject::User(id), &permission).await?));
    }
    Ok(Json(json!({
        "user": {
            "id": id,
            "username": row.get::<String, _>("username"),
            "displayName": row.get::<String, _>("display_name"),
            "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
        },
        "grants": grants.iter().map(tuple_json).collect::<Vec<_>>(),
        "permissions": permissions,
        "users": people(&state, tuple_users(&grants)).await?,
    })))
}

/// `GET /api/admin/permissions/groups`: every group with its members and what its members hold through it.
async fn groups(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let rows = sqlx::query(&format!(
        "{TUPLE_SELECT} WHERE t.object_type = 'group' OR t.subject_type = 'group' {TUPLE_ORDER} LIMIT {MAX_TUPLES}"
    ))
    .fetch_all(&state.db)
    .await?;
    let mut groups: BTreeMap<String, (Vec<Value>, Vec<Value>)> = BTreeMap::new();
    for row in &rows {
        if row.get::<&str, _>("object_type") == "group" {
            groups.entry(row.get("object_id")).or_default().0.push(tuple_json(row));
        }
        if row.get::<&str, _>("subject_type") == "group" {
            groups.entry(row.get("subject_id")).or_default().1.push(tuple_json(row));
        }
    }
    let groups: Vec<Value> = groups
        .into_iter()
        .map(|(id, (members, grants))| json!({"id": id, "members": members, "grants": grants}))
        .collect();
    Ok(Json(json!({"groups": groups, "users": people(&state, tuple_users(&rows)).await?})))
}

#[derive(Deserialize)]
struct TupleQuery {
    object: Option<String>,
    subject: Option<String>,
}

/// `GET /api/admin/permissions/tuples?object=` or `?subject=`: the stored tuples on an object or naming a subject.
async fn tuples(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TupleQuery>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let rows = match (query.object.as_deref(), query.subject.as_deref()) {
        (Some(object), None) => {
            let object = object_ref(&state, object).await?;
            sqlx::query(&format!(
                "{TUPLE_SELECT} WHERE t.object_type = $1 AND t.object_id = $2 {TUPLE_ORDER} LIMIT {MAX_TUPLES}"
            ))
            .bind(object.kind.as_str())
            .bind(&object.id)
            .fetch_all(&state.db)
            .await?
        }
        (None, Some(subject)) => {
            let subject = subject_ref(&state, subject).await?;
            sqlx::query(&format!(
                "{TUPLE_SELECT} WHERE t.subject_type = $1 AND t.subject_id = $2
                 AND t.subject_relation IS NOT DISTINCT FROM $3 {TUPLE_ORDER} LIMIT {MAX_TUPLES}"
            ))
            .bind(subject.object.kind.as_str())
            .bind(&subject.object.id)
            .bind(subject.relation)
            .fetch_all(&state.db)
            .await?
        }
        _ => return Err(bad("invalid_query", "대상이나 주체 중 하나를 정해 주세요.")),
    };
    Ok(Json(json!({
        "tuples": rows.iter().map(tuple_json).collect::<Vec<_>>(),
        "users": people(&state, tuple_users(&rows)).await?,
    })))
}

#[derive(Deserialize)]
struct Change {
    object: String,
    relation: String,
    subject: String,
    reason: String,
}

impl Change {
    async fn tuple(&self, state: &AppState) -> ApiResult<Tuple> {
        let object = object_ref(state, &self.object).await?;
        let subject = subject_ref(state, &self.subject).await?;
        Tuple::new(object, self.relation.trim(), subject).map_err(invalid)
    }

    fn reason(&self) -> ApiResult<&str> {
        let reason = self.reason.trim();
        if reason.is_empty() || reason.chars().count() > 200 || reason.chars().any(char::is_control) {
            return Err(bad("invalid_reason", "사유를 1~200자로 적어 주세요."));
        }
        Ok(reason)
    }
}

fn actor(admin: &User) -> Actor<'_> {
    Actor { id: Some(admin.id), name: &admin.username }
}

fn change_json(tuple: &Tuple, changed: bool) -> Value {
    json!({
        "changed": changed,
        "tuple": {"object": tuple.object.to_string(), "relation": tuple.relation, "subject": tuple.subject.to_string()},
    })
}

/// `POST /api/admin/permissions/grant` `{object, relation, subject, reason}`: 201 when stored, 200 when it already was.
async fn grant(State(state): State<AppState>, headers: HeaderMap, Json(change): Json<Change>) -> ApiResult<Response> {
    let admin = require(&state, &headers, ADMIN).await?;
    let reason = change.reason()?;
    let tuple = change.tuple(&state).await?;
    let changed = rebac::grant(&state.db, &tuple, actor(&admin), reason).await?;
    if changed {
        tracing::warn!(admin = %admin.username, %tuple, "Permission granted");
    }
    let status = if changed { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(change_json(&tuple, changed))).into_response())
}

/// `POST /api/admin/permissions/revoke` `{object, relation, subject, reason}`; the last admin stays.
async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> ApiResult<Json<Value>> {
    let admin = require(&state, &headers, ADMIN).await?;
    let reason = change.reason()?;
    let tuple = change.tuple(&state).await?;
    let changed = match rebac::revoke(&state.db, &tuple, actor(&admin), reason).await {
        Ok(changed) => changed,
        Err(RevokeError::LastAdmin) => return Err(LAST_ADMIN),
        Err(RevokeError::Database(error)) => return Err(error.into()),
    };
    if changed {
        tracing::warn!(admin = %admin.username, %tuple, "Permission revoked");
    }
    Ok(Json(change_json(&tuple, changed)))
}

fn trace_users(trace: &Trace, found: &mut BTreeSet<Uuid>) {
    found.extend(named_user(&trace.object));
    found.extend(trace.subject.as_deref().and_then(named_user));
    for child in &trace.children {
        trace_users(child, found);
    }
}

fn expansion_users(tree: &Expansion, found: &mut BTreeSet<Uuid>) {
    found.extend(named_user(&tree.object));
    found.extend(tree.subject.as_deref().and_then(named_user));
    for child in &tree.children {
        expansion_users(child, found);
    }
}

#[derive(Deserialize)]
struct CheckQuery {
    /// `user:<username or id>`, or `anonymous` for a signed-out visitor.
    subject: String,
    object: String,
    relation: String,
}

/// `GET /api/admin/permissions/check?subject=&object=&relation=`: the decision and how it was reached.
async fn check(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CheckQuery>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let subject = match query.subject.trim() {
        "anonymous" => Subject::Anonymous,
        text => match subject_ref(&state, text).await? {
            SubjectRef { object, relation: None } if object.kind == Kind::User => {
                Subject::User(object.uuid().ok_or(INVALID_SUBJECT)?)
            }
            _ => return Err(INVALID_SUBJECT),
        },
    };
    let object = object_ref(&state, &query.object).await?;
    let trace =
        Checker::new(&state.db).explain(subject, &object, query.relation.trim()).await?.ok_or(INVALID_RELATION)?;
    let mut ids = BTreeSet::new();
    trace_users(&trace, &mut ids);
    if let Subject::User(id) = subject {
        ids.insert(id);
    }
    Ok(Json(json!({
        "subject": subject.to_string(),
        "allowed": trace.allowed,
        "trace": trace,
        "users": people(&state, ids).await?,
    })))
}

#[derive(Deserialize)]
struct ExpandQuery {
    object: String,
    relation: String,
}

/// `GET /api/admin/permissions/expand?object=&relation=`: who holds the relation, as a tree and as a list of users.
async fn expand(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ExpandQuery>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let object = object_ref(&state, &query.object).await?;
    let tree = Checker::new(&state.db).expand(&object, query.relation.trim()).await?.ok_or(INVALID_RELATION)?;
    let holders = tree.users();
    let mut ids = holders.clone();
    expansion_users(&tree, &mut ids);
    Ok(Json(json!({"tree": tree, "holders": holders, "users": people(&state, ids).await?})))
}

#[derive(Deserialize)]
struct AuditQuery {
    before: Option<i64>,
    limit: Option<i64>,
    subject: Option<String>,
    object: Option<String>,
}

/// `GET /api/admin/permissions/audit?before=&limit=&subject=&object=`: grants and revokes, newest first.
async fn audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, ADMIN).await?;
    let subject = match query.subject.as_deref() {
        Some(text) => Some(subject_ref(&state, text).await?),
        None => None,
    };
    let object = match query.object.as_deref() {
        Some(text) => Some(object_ref(&state, text).await?),
        None => None,
    };
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let rows = sqlx::query(
        "SELECT id, action, object_type, object_id, relation, subject_type, subject_id, subject_relation, actor_id, actor,
         reason, created_at FROM auth_audit
         WHERE ($1::bigint IS NULL OR id < $1)
           AND ($2::text IS NULL OR (subject_type = $2 AND subject_id = $3 AND subject_relation IS NOT DISTINCT FROM $4))
           AND ($5::text IS NULL OR (object_type = $5 AND object_id = $6))
         ORDER BY id DESC LIMIT $7",
    )
    .bind(query.before)
    .bind(subject.as_ref().map(|s| s.object.kind.as_str()))
    .bind(subject.as_ref().map(|s| s.object.id.as_str()))
    .bind(subject.as_ref().and_then(|s| s.relation))
    .bind(object.as_ref().map(|o| o.kind.as_str()))
    .bind(object.as_ref().map(|o| o.id.as_str()))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let entries: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<i64, _>("id"),
                "action": row.get::<String, _>("action"),
                "object": object_text(row),
                "relation": row.get::<String, _>("relation"),
                "subject": subject_text(row),
                "actor": row.get::<String, _>("actor"),
                "actorId": row.get::<Option<Uuid>, _>("actor_id"),
                "reason": row.get::<String, _>("reason"),
                "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
            })
        })
        .collect();
    let next = (rows.len() as i64 == limit).then(|| rows.last().map(|row| row.get::<i64, _>("id"))).flatten();
    Ok(Json(json!({"entries": entries, "nextBefore": next, "users": people(&state, tuple_users(&rows)).await?})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns_match_literally() {
        assert_eq!(like_escape("a_b%c\\"), "a\\_b\\%c\\\\");
    }

    #[test]
    fn users_and_homes_are_found_by_id() {
        let id = Uuid::new_v4();
        assert_eq!(named_user(&format!("user:{id}")), Some(id));
        assert_eq!(named_user(&format!("home:{id}")), Some(id));
        assert_eq!(named_user("group:crew#member"), None);
        assert_eq!(named_user("system:mogaesup"), None);
    }
}
