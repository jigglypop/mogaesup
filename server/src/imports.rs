//! Catalog imports from the character server. The request only queues one and answers 202; a task copies the model
//! step by step (source, download, checks, textures, store, picture, catalog) while the admin page polls it. Every check
//! lands in a report, so an admin sees everything wrong at once, and a finished import becomes a version of its catalog
//! item. Re-importing into an item replaces its model and keeps its status, order, name and emoji.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{io::Cursor, ops::RangeInclusive, panic::AssertUnwindSafe, sync::atomic::Ordering, time::Duration};
use uuid::Uuid;

use crate::{
    AppState,
    auth::require,
    catalog,
    error::{ApiError, ApiResult, bad, conflict, internal, not_found},
    factory::{self, MAX_MODEL_BYTES, Received},
    glb,
    rebac::CATALOG_EDITOR,
    runtime::retry,
    slim, studio,
};

/// Imports copying at once. Each holds a whole model (up to 64 MB) and decodes its textures to shrink them.
pub const SLOTS: usize = 2;
/// Each step and the progress it starts at; the download fills the span up to the checks.
const STEPS: [(&str, i16); 9] = [
    ("queued", 0),
    ("source", 5),
    ("download", 10),
    ("verify", 50),
    ("slim", 60),
    ("store", 75),
    ("thumbnail", 85),
    ("save", 95),
    ("done", 100),
];
const DOWNLOAD_TICK: Duration = Duration::from_millis(700);
/// The 미니미 picker shows pictures this big; the character server renders them at 800 px.
const THUMBNAIL_EDGE: u32 = 256;
const MAX_PICTURE_BYTES: usize = 8 * 1024 * 1024;
/// Past these a 미니미 still works but weighs on the island: warnings, not failures.
const TRIANGLE_BUDGET: u64 = 100_000;
const WEB_BYTES_BUDGET: usize = 24 * 1024 * 1024;
const TEXTURE_EDGE_BUDGET: u32 = 1024;
/// Heights a 미니미 can plausibly have, in metres; the built-in figures stand 1.7 m.
const HEIGHT_RANGE: RangeInclusive<f64> = 0.3..=3.0;

const NOT_GLB: ApiError = bad("not_glb", "GLB 파일이 아닙니다.");
const CHECKSUM: ApiError = bad("factory_checksum", "받은 모델이 캐릭터 서버의 기록과 다릅니다. 다시 시도해 주세요.");
const NOT_PLAYABLE: ApiError =
    bad("not_playable", "미니미로 쓰려면 리깅(스킨)과 idle·walk 애니메이션이 있어야 합니다.");
const NOT_RESIDENT: ApiError = bad("not_playable", "주민으로 쓰려면 리깅(스킨)과 idle 애니메이션이 있어야 합니다.");
/** Engine clips a resident needs: it stands where the island's owner put it, so a walk is optional. */
const RESIDENT_CLIPS: [&str; 1] = ["idle"];
const RUNNING: ApiError = conflict("import_running", "이 항목은 이미 가져오는 중입니다. 끝난 뒤 다시 시도해 주세요.");
const NOT_FOUND: ApiError = not_found("import_not_found", "없는 가져오기 작업입니다.");
const INTERRUPTED: &str = "서버가 다시 시작되어 가져오기가 멈췄습니다. 다시 시도해 주세요.";
/// A running import records its progress at least every step, and about every second while it downloads; one silent
/// this long has stopped without recording why.
const STALLED_MINUTES: i32 = 30;
const STALLED: &str = "가져오기가 30분 넘게 진행되지 않아 멈춘 것으로 처리했습니다. 다시 시도해 주세요.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    Ok,
    Info,
    Warning,
    Error,
}

#[derive(Debug, Serialize)]
struct Check {
    code: &'static str,
    level: Level,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReport {
    sha256: String,
    expected_sha256: Option<String>,
    bytes: usize,
    /// The stored copy, once its textures went through [`slim`].
    web_bytes: Option<usize>,
    slimmed: Option<bool>,
}

/// What an import found, kept with the import and with the version it made.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    checks: Vec<Check>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<FileReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<glb::Details>,
    /// The stored copy's textures, after shrinking.
    #[serde(skip_serializing_if = "Option::is_none")]
    web_textures: Option<Vec<glb::Texture>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail: Option<Value>,
    /// `created`, `updated`, or `unchanged` when the item already showed this very copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
}

impl Report {
    fn check(&mut self, code: &'static str, level: Level, message: impl Into<String>) {
        self.checks.push(Check { code, level, message: message.into() });
    }

    fn json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// `7.1 MB`, `512 KB`, as the admin page shows sizes (1 MB = 1024² bytes).
fn size_text(bytes: usize) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= MB { format!("{:.1} MB", bytes as f64 / MB) } else { format!("{} KB", bytes.div_ceil(1024)) }
}

/// A studio import creates an item or updates one made the same way; it never replaces a built-in or changes a kind.
fn check_target(kind: &str, source: &str, wanted: &str) -> ApiResult<()> {
    if source != "factory" {
        return Err(conflict("builtin_item", "기본 항목은 덮어쓸 수 없습니다. 다른 ID로 가져오세요."));
    }
    if kind != wanted {
        return Err(conflict("kind_mismatch", "이 ID는 다른 종류의 항목이 쓰고 있습니다."));
    }
    Ok(())
}

/// The character server's front render at picker size, with its size; None when it cannot be read within fixed bounds.
fn thumbnail(png: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let picture =
        slim::decode(png, ImageFormat::Png, 4096, 64 * 1024 * 1024)?.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE);
    let mut out = Cursor::new(Vec::new());
    picture.write_to(&mut out, ImageFormat::Png).ok()?;
    Some((out.into_inner(), picture.width(), picture.height()))
}

/// Runs every check on a downloaded model into `report`, then fails on the first hard problem, in this order: not a
/// GLB, a checksum that differs from the character server's record, a character whose data cannot be read (with what
/// could not), a 미니미 without a rig or without idle and walk, a resident (`npc`) without a rig or without idle.
fn verify(kind: &str, bytes: &[u8], expected: Option<&str>, report: &mut Report) -> ApiResult<glb::Details> {
    let sha256 = hex::encode(Sha256::digest(bytes));
    let checksum = match expected {
        Some(expected) if expected == sha256 => Level::Ok,
        Some(_) => Level::Error,
        None => Level::Warning,
    };
    report.check(
        "checksum",
        checksum,
        match checksum {
            Level::Ok => "캐릭터 서버 기록과 SHA-256이 같습니다.",
            Level::Error => "받은 모델이 캐릭터 서버의 기록과 다릅니다.",
            _ => "캐릭터 서버에 SHA-256 기록이 없어 대조하지 못했습니다.",
        },
    );
    report.file = Some(FileReport {
        sha256,
        expected_sha256: expected.map(str::to_owned),
        bytes: bytes.len(),
        web_bytes: None,
        slimmed: None,
    });
    let Some(details) = glb::details(bytes) else {
        report.check("glb", Level::Error, "GLB(glTF 2.0 바이너리) 파일이 아닙니다.");
        return Err(NOT_GLB);
    };
    report.check("glb", Level::Ok, format!("GLB 파일 {}", size_text(bytes.len())));
    let resident = kind == "npc";
    let character = kind == "minime" || resident;
    // What a character must have is only worth noting on furniture.
    let must = if character { Level::Error } else { Level::Info };
    let wanted: &[&'static str] = if resident { &RESIDENT_CLIPS } else { &glb::REQUIRED_CLIPS };
    let summary = details.summary();
    // Data that cannot be read leaves the rig and the clips unknown, and says why.
    let unreadable = details.problem.filter(|problem| *problem != glb::Problem::NoSkin);
    if let Some(problem) = unreadable {
        report.check("model_data", must, problem.message());
    }
    match details.problem {
        None => report.check("skin", Level::Ok, format!("리깅(스킨)이 있습니다 · 관절 {}개", details.joints)),
        Some(glb::Problem::NoSkin) => report.check("skin", must, glb::Problem::NoSkin.message()),
        Some(_) => report.check("skin", must, "모델 데이터를 읽지 못해 리깅(스킨)을 확인하지 못했습니다."),
    }
    let missing = summary.missing(wanted);
    if missing.is_empty() {
        report.check("clips", Level::Ok, format!("필요한 애니메이션({})이 있습니다.", wanted.join("·")));
    } else if unreadable.is_some() {
        let message = format!("모델 데이터를 읽지 못해 애니메이션({})을 확인하지 못했습니다.", wanted.join("·"));
        report.check("clips", must, message);
    } else {
        report.check("clips", must, format!("필요한 애니메이션이 없습니다: {}", missing.join(", ")));
    }
    let unused: Vec<&str> =
        details.animations.iter().filter(|name| glb::engine_clip(name).is_none()).map(String::as_str).collect();
    if !unused.is_empty() {
        report.check("unused_clips", Level::Info, format!("엔진이 쓰지 않는 애니메이션: {}", unused.join(", ")));
    }
    if details.triangles > TRIANGLE_BUDGET {
        let message = format!(
            "삼각형이 {}개로 많아 섬에서 느려질 수 있습니다 (권장 {TRIANGLE_BUDGET}개 이하).",
            details.triangles
        );
        report.check("triangles", Level::Warning, message);
    } else {
        report.check("triangles", Level::Ok, format!("삼각형 {}개 · 정점 {}개", details.triangles, details.vertices));
    }
    match details.size {
        Some([_, height, _]) if !character || HEIGHT_RANGE.contains(&height) => {
            report.check("height", Level::Ok, format!("높이 {height:.2} m"));
        }
        Some([_, height, _]) => {
            report.check("height", Level::Warning, format!("높이가 {height:.2} m입니다. 기본 미니미는 1.7 m입니다."));
        }
        None => report.check("height", Level::Warning, "모델 크기를 읽지 못했습니다."),
    }
    let largest = details.textures.iter().filter_map(glb::Texture::edge).max();
    let textures = match largest {
        _ if details.textures.is_empty() => "텍스처가 없습니다.".to_owned(),
        Some(edge) => format!("텍스처 {}장 · 가장 큰 변 {edge}px", details.textures.len()),
        None => format!("텍스처 {}장 · 크기를 읽지 못했습니다.", details.textures.len()),
    };
    report.check("textures", Level::Info, textures);
    report.model = Some(details.clone());
    if checksum == Level::Error {
        return Err(CHECKSUM);
    }
    if character && let Some(problem) = unreadable {
        return Err(bad("not_playable", problem.message()));
    }
    if character && (!summary.skinned || !missing.is_empty()) {
        return Err(if resident { NOT_RESIDENT } else { NOT_PLAYABLE });
    }
    Ok(details)
}

/// Checks on the stored copy: whether its textures shrank, what is still oversized, and its size.
fn web_checks(report: &mut Report, before: usize, after: usize, slimmed: bool, textures: &[glb::Texture]) {
    if slimmed {
        let message = format!("텍스처를 웹용으로 줄였습니다: {} → {}", size_text(before), size_text(after));
        report.check("slim", Level::Ok, message);
    } else {
        report.check("slim", Level::Info, "줄일 수 있는 텍스처가 없어 원본을 그대로 씁니다.");
    }
    let largest = textures.iter().filter_map(glb::Texture::edge).max().unwrap_or(0);
    if largest > TEXTURE_EDGE_BUDGET {
        let message = format!("{TEXTURE_EDGE_BUDGET}px보다 큰 텍스처가 남았습니다 (가장 큰 변 {largest}px).");
        report.check("texture_size", Level::Warning, message);
    }
    if after > WEB_BYTES_BUDGET {
        report.check(
            "file_size",
            Level::Warning,
            format!("웹용 모델이 {}로 커서 섬에서 늦게 뜰 수 있습니다.", size_text(after)),
        );
    } else {
        report.check("file_size", Level::Ok, format!("웹용 모델 {}", size_text(after)));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBody {
    id: String,
    kind: String,
    label: String,
    emoji: String,
    factory_job_id: String,
    /// Where a new item starts; an existing item keeps its own.
    status: Option<String>,
    sort_order: Option<i32>,
}

/// A checked import request.
struct Order {
    item: String,
    kind: String,
    label: String,
    emoji: String,
    status: String,
    sort_order: i32,
    job: String,
}

const IMPORT_SELECT: &str = "SELECT i.id, i.item_id, i.kind, i.label, i.emoji, i.factory_job_id, i.character_id,
    i.replaces, i.status, i.step, i.progress, i.detail, i.error_code, i.error_message, i.report, i.version_id,
    u.username AS requested_by, i.created_at, i.updated_at, i.finished_at
    FROM catalog_imports i LEFT JOIN users u ON u.id = i.requested_by";

fn import_json(row: &PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "itemId": row.get::<String, _>("item_id"),
        "kind": row.get::<String, _>("kind"),
        "label": row.get::<String, _>("label"),
        "emoji": row.get::<String, _>("emoji"),
        "factoryJobId": row.get::<String, _>("factory_job_id"),
        "characterId": row.get::<Option<String>, _>("character_id"),
        "replaces": row.get::<bool, _>("replaces"),
        "status": row.get::<String, _>("status"),
        "step": row.get::<String, _>("step"),
        "progress": row.get::<i16, _>("progress"),
        "detail": row.get::<Option<String>, _>("detail"),
        "errorCode": row.get::<Option<String>, _>("error_code"),
        "errorMessage": row.get::<Option<String>, _>("error_message"),
        "report": row.get::<Option<Value>, _>("report"),
        "versionId": row.get::<Option<i64>, _>("version_id"),
        "requestedBy": row.get::<Option<String>, _>("requested_by"),
        "createdAt": row.get::<DateTime<Utc>, _>("created_at"),
        "updatedAt": row.get::<DateTime<Utc>, _>("updated_at"),
        "finishedAt": row.get::<Option<DateTime<Utc>>, _>("finished_at"),
    })
}

async fn fetch(db: &PgPool, id: Uuid) -> Result<Option<PgRow>, sqlx::Error> {
    sqlx::query(&format!("{IMPORT_SELECT} WHERE i.id = $1")).bind(id).fetch_optional(db).await
}

/// `POST /api/catalog/admin/import`: queues a copy of a finished character into catalog item `id` and answers 202 with
/// the import to follow. What can be told without the character server is refused here; the rest shows up as a failed
/// import.
pub async fn enqueue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ImportBody>,
) -> ApiResult<Response> {
    let admin = require(&state, &headers, CATALOG_EDITOR).await?;
    let order = Order {
        item: catalog::catalog_id(&body.id)?.to_owned(),
        kind: catalog::kind(&body.kind)?.to_owned(),
        label: catalog::label(&body.label, 30, "invalid_label")?,
        emoji: catalog::label(&body.emoji, 16, "invalid_emoji")?,
        status: catalog::status(body.status)?.unwrap_or_else(|| "draft".into()),
        sort_order: body.sort_order.unwrap_or(100),
        job: studio::segment(&body.factory_job_id).ok_or(studio::JOB_NOT_FOUND)?.to_owned(),
    };
    factory::configured(&state)?;
    let existing = sqlx::query("SELECT kind, source FROM catalog_items WHERE id = $1")
        .bind(&order.item)
        .fetch_optional(&state.db)
        .await?;
    if let Some(row) = &existing {
        check_target(row.get("kind"), row.get("source"), &order.kind)?;
    }
    let id = Uuid::new_v4();
    // The partial unique index on active imports turns a second import of the same item into no row.
    let queued = sqlx::query(
        "INSERT INTO catalog_imports (id, item_id, kind, label, emoji, factory_job_id, replaces, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(&order.item)
    .bind(&order.kind)
    .bind(&order.label)
    .bind(&order.emoji)
    .bind(&order.job)
    .bind(existing.is_some())
    .bind(admin.id)
    .execute(&state.db)
    .await?;
    if queued.rows_affected() == 0 {
        return Err(RUNNING);
    }
    tokio::spawn(Task { state: state.clone(), id, username: admin.username, user: admin.id, order }.run());
    let row = fetch(&state.db, id).await?.ok_or(NOT_FOUND)?;
    Ok((StatusCode::ACCEPTED, Json(import_json(&row))).into_response())
}

#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<i64>,
}

/// `GET /api/catalog/admin/imports`: the latest imports, newest first.
pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let rows = sqlx::query(&format!("{IMPORT_SELECT} ORDER BY i.created_at DESC LIMIT $1"))
        .bind(query.limit.unwrap_or(30).clamp(1, 100))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({"imports": rows.iter().map(import_json).collect::<Vec<_>>()})))
}

/// `GET /api/catalog/admin/imports/{id}`.
pub async fn one(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require(&state, &headers, CATALOG_EDITOR).await?;
    let id = Uuid::parse_str(&id).map_err(|_| NOT_FOUND)?;
    Ok(Json(import_json(&fetch(&state.db, id).await?.ok_or(NOT_FOUND)?)))
}

/// Marks the imports a stopped server left queued or running as failed: their tasks ended with it. Run at startup,
/// before this server queues any of its own.
pub async fn interrupt_unfinished(db: &PgPool) -> Result<u64, sqlx::Error> {
    let stopped = sqlx::query(
        "UPDATE catalog_imports SET status = 'failed', error_code = 'interrupted', error_message = $1, detail = NULL,
         updated_at = now(), finished_at = now() WHERE status IN ('queued', 'running')",
    )
    .bind(INTERRUPTED)
    .execute(db)
    .await?;
    Ok(stopped.rows_affected())
}

/// Marks running imports that stopped recording progress as failed, so they no longer hold their item (a new import of
/// it would be refused as `import_running`). Run periodically; a task that could not record its own failure ends here.
pub async fn interrupt_stale(db: &PgPool) -> Result<u64, sqlx::Error> {
    let stopped = sqlx::query(
        "UPDATE catalog_imports SET status = 'failed', error_code = 'interrupted', error_message = $1, detail = NULL,
         updated_at = now(), finished_at = now()
         WHERE status = 'running' AND updated_at < now() - make_interval(mins => $2)",
    )
    .bind(STALLED)
    .bind(STALLED_MINUTES)
    .execute(db)
    .await?;
    Ok(stopped.rows_affected())
}

/// One queued import, run by its own task.
struct Task {
    state: AppState,
    id: Uuid,
    username: String,
    user: Uuid,
    order: Order,
}

impl Task {
    async fn run(self) {
        // Waiting here is the `queued` step. The semaphore is never closed.
        let Ok(_slot) = self.state.imports.clone().acquire_owned().await else { return };
        let mut report = Report::default();
        let error = match AssertUnwindSafe(self.copy(&mut report)).catch_unwind().await {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error,
            Err(_) => internal("catalog import panicked"),
        };
        tracing::warn!(import = %self.id, code = error.code, "Catalog import failed");
        // The step stays where it stopped, so the page can point at it. Left `running`, the import would hold its item
        // until `interrupt_stale` gives up on it, so a database that does not answer at once is asked again.
        let report = report.json();
        let saved = retry(|| {
            sqlx::query(
                "UPDATE catalog_imports SET status = 'failed', error_code = $2, error_message = $3, report = $4,
                 detail = NULL, updated_at = now(), finished_at = now() WHERE id = $1",
            )
            .bind(self.id)
            .bind(error.code)
            .bind(error.message)
            .bind(&report)
            .execute(&self.state.db)
        })
        .await;
        if let Err(error) = saved {
            tracing::error!(%error, import = %self.id, "Could not record a failed catalog import");
        }
    }

    async fn step(&self, step: &'static str) {
        let progress = STEPS.iter().find(|(name, _)| *name == step).map_or(0, |(_, at)| *at);
        self.progress(step, progress, None).await;
    }

    async fn progress(&self, step: &str, progress: i16, detail: Option<String>) {
        let saved = sqlx::query(
            "UPDATE catalog_imports SET status = 'running', step = $2, progress = $3, detail = $4, updated_at = now()
             WHERE id = $1 AND status IN ('queued', 'running')",
        )
        .bind(self.id)
        .bind(step)
        .bind(progress)
        .bind(detail)
        .execute(&self.state.db)
        .await;
        if let Err(error) = saved {
            tracing::warn!(%error, import = %self.id, "Could not record a catalog import's progress");
        }
    }

    async fn copy(&self, report: &mut Report) -> ApiResult<()> {
        self.step("source").await;
        let source = studio::source(&self.state, &self.username, &self.order.job).await?;
        report.source = Some(json!({
            "jobId": source.job_id, "version": source.version, "face": source.expression, "stage": source.stage,
            "characterId": source.character_id, "modelPath": source.model_path,
        }));
        if source.character_id.is_some() {
            sqlx::query("UPDATE catalog_imports SET character_id = $2 WHERE id = $1")
                .bind(self.id)
                .bind(&source.character_id)
                .execute(&self.state.db)
                .await?;
        }

        self.step("download").await;
        let bytes = self.download(&source.model_path).await?;

        self.step("verify").await;
        let (kind, expected) = (self.order.kind.clone(), source.model_sha256.clone());
        let mut checked = std::mem::take(report);
        let (bytes, checked, details) = tokio::task::spawn_blocking(move || {
            let details = verify(&kind, &bytes, expected.as_deref(), &mut checked);
            (bytes, checked, details)
        })
        .await
        .map_err(internal)?;
        *report = checked;
        let details = details?;

        self.step("slim").await;
        let original = bytes.len();
        let (web, web_details, slimmed) = tokio::task::spawn_blocking(move || match slim::slim(&bytes) {
            Some(smaller) => {
                let details = glb::details(&smaller);
                (smaller, details, true)
            }
            None => (bytes, None, false),
        })
        .await
        .map_err(internal)?;
        let web_textures = web_details.map_or_else(|| details.textures.clone(), |web| web.textures);
        web_checks(report, original, web.len(), slimmed, &web_textures);
        report.web_textures = Some(web_textures);
        if let Some(file) = report.file.as_mut() {
            (file.web_bytes, file.slimmed) = (Some(web.len()), Some(slimmed));
        }
        tracing::info!(original, slimmed = web.len(), "Catalog model textures sized for the web");

        self.step("store").await;
        let model_url = self.state.config.models.put("glb", web).await?;

        self.step("thumbnail").await;
        let thumbnail_url = self.picture(&source.thumbnail_path, report).await?;

        self.step("save").await;
        self.save(&source, model_url, thumbnail_url, details.clips, report).await
    }

    /// The model, with the share received so far written to the import about once a second.
    async fn download(&self, path: &str) -> ApiResult<Vec<u8>> {
        let received = Received::default();
        let fetch = factory::fetch_file(&self.state, &self.username, path, MAX_MODEL_BYTES, Some(&received));
        tokio::pin!(fetch);
        let mut tick = tokio::time::interval(DOWNLOAD_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                bytes = &mut fetch => return bytes,
                _ = tick.tick() => {
                    let done = received.bytes.load(Ordering::Relaxed);
                    let total = received.total.load(Ordering::Relaxed);
                    let (share, detail) = match total {
                        0 => (0, size_text(done)),
                        total => ((done.min(total) as u64 * 40 / total as u64) as i16, format!("{} / {}", size_text(done), size_text(total))),
                    };
                    self.progress("download", 10 + share, Some(detail)).await;
                }
            }
        }
    }

    /// The front render at picker size, stored. A picture the character server cannot give is only a warning.
    async fn picture(&self, path: &str, report: &mut Report) -> ApiResult<Option<String>> {
        let fetched = factory::fetch_file(&self.state, &self.username, path, MAX_PICTURE_BYTES, None).await;
        let (picture, reason) = match fetched {
            Ok(png) => (
                tokio::task::spawn_blocking(move || thumbnail(&png)).await.map_err(internal)?,
                "PNG로 읽지 못했습니다.",
            ),
            Err(error) => (None, error.message),
        };
        let Some((png, width, height)) = picture else {
            report.check("thumbnail", Level::Warning, format!("대표 그림을 받지 못했습니다: {reason}"));
            report.thumbnail = Some(json!({"ok": false}));
            return Ok(None);
        };
        report.check("thumbnail", Level::Ok, format!("대표 그림 {width}×{height}"));
        report.thumbnail = Some(json!({"ok": true, "width": width, "height": height}));
        Ok(Some(self.state.config.models.put("png", png).await?))
    }

    /// Makes the copy the item's model in one transaction, with its version and the finished import. A new item starts
    /// with the order's name, emoji, status and place; an existing one keeps all of those and, when no new picture came,
    /// its picture. A copy identical to the version the item shows adds no version.
    async fn save(
        &self,
        source: &studio::Source,
        model_url: String,
        thumbnail_url: Option<String>,
        clips: Vec<String>,
        report: &mut Report,
    ) -> ApiResult<()> {
        let source_ref = source.source_ref();
        let mut tx = self.state.db.begin().await?;
        let existing = sqlx::query(
            "SELECT i.kind, i.source, i.thumbnail_url, v.id AS version, v.model_url AS version_model,
             v.thumbnail_url AS version_thumbnail, v.source_ref AS version_ref, v.stage AS version_stage
             FROM catalog_items i LEFT JOIN catalog_versions v ON v.id = i.version_id WHERE i.id = $1 FOR UPDATE OF i",
        )
        .bind(&self.order.item)
        .fetch_optional(&mut *tx)
        .await?;
        let thumbnail_url = match &existing {
            Some(row) => {
                check_target(row.get("kind"), row.get("source"), &self.order.kind)?;
                let previous: Option<String> = row.get("thumbnail_url");
                if thumbnail_url.is_none() && previous.is_some() {
                    report.check("thumbnail_kept", Level::Info, "이전 대표 그림을 그대로 씁니다.");
                }
                thumbnail_url.or(previous)
            }
            None => {
                sqlx::query(
                    "INSERT INTO catalog_items (id, kind, label, emoji, model_url, thumbnail_url, clips, source, status,
                     sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, 'factory', $8, $9)",
                )
                .bind(&self.order.item)
                .bind(&self.order.kind)
                .bind(&self.order.label)
                .bind(&self.order.emoji)
                .bind(&model_url)
                .bind(&thumbnail_url)
                .bind(&clips)
                .bind(&self.order.status)
                .bind(self.order.sort_order)
                .execute(&mut *tx)
                .await?;
                thumbnail_url
            }
        };
        let same = |row: &&PgRow| {
            row.get::<Option<String>, _>("version_model").as_deref() == Some(model_url.as_str())
                && row.get::<Option<String>, _>("version_thumbnail") == thumbnail_url
                && row.get::<Option<String>, _>("version_ref").as_deref() == Some(source_ref.as_str())
                && row.get::<Option<String>, _>("version_stage") == source.stage
        };
        let kept: Option<i64> = existing.as_ref().filter(same).and_then(|row| row.get("version"));
        report.outcome = Some(match (&existing, kept) {
            (None, _) => "created",
            (Some(_), Some(_)) => "unchanged",
            (Some(_), None) => "updated",
        });
        let report = report.json();
        let version: i64 = match kept {
            Some(version) => {
                sqlx::query("UPDATE catalog_versions SET report = $2, import_id = $3 WHERE id = $1")
                    .bind(version)
                    .bind(&report)
                    .bind(self.id)
                    .execute(&mut *tx)
                    .await?;
                version
            }
            None => {
                sqlx::query_scalar(
                    "INSERT INTO catalog_versions (item_id, model_url, thumbnail_url, clips, source_ref, character_id,
                     stage, report, import_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
                )
                .bind(&self.order.item)
                .bind(&model_url)
                .bind(&thumbnail_url)
                .bind(&clips)
                .bind(&source_ref)
                .bind(&source.character_id)
                .bind(&source.stage)
                .bind(&report)
                .bind(self.id)
                .bind(self.user)
                .fetch_one(&mut *tx)
                .await?
            }
        };
        sqlx::query(
            "UPDATE catalog_items SET model_url = $2, thumbnail_url = $3, clips = $4, source_ref = $5,
             character_id = COALESCE($6, character_id), version_id = $7, updated_at = now() WHERE id = $1",
        )
        .bind(&self.order.item)
        .bind(&model_url)
        .bind(&thumbnail_url)
        .bind(&clips)
        .bind(&source_ref)
        .bind(&source.character_id)
        .bind(version)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE catalog_imports SET status = 'done', step = 'done', progress = 100, detail = NULL, report = $2,
             version_id = $3, updated_at = now(), finished_at = now() WHERE id = $1",
        )
        .bind(self.id)
        .bind(&report)
        .bind(version)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thumbnails_shrink_to_the_picker_size_and_keep_transparency() {
        let mut canvas = image::RgbaImage::new(800, 600);
        canvas.put_pixel(400, 300, image::Rgba([255, 0, 0, 255]));
        let mut png = Cursor::new(Vec::new());
        canvas.write_to(&mut png, ImageFormat::Png).unwrap();
        let (small, width, height) = thumbnail(png.get_ref()).unwrap();
        let small = image::load_from_memory(&small).unwrap();
        assert_eq!((small.width(), small.height()), (256, 192));
        assert_eq!((width, height), (256, 192));
        assert!(small.color().has_alpha());
        assert!(thumbnail(b"not a picture").is_none());
    }

    fn levels(report: &Report) -> Vec<(&'static str, Level)> {
        report.checks.iter().map(|check| (check.code, check.level)).collect()
    }

    #[test]
    fn every_check_is_reported_before_the_first_hard_failure_decides() {
        // No rig, no walk, and bytes the character server's record does not match: all three are reported, and the
        // checksum decides.
        let statue =
            glb::join(&json!({"asset": {"version": "2.0"}, "animations": [{"name": "Idle"}, {"name": "Sit"}]}), &[]);
        let mut report = Report::default();
        let error = verify("minime", &statue, Some("0".repeat(64).as_str()), &mut report).unwrap_err();
        assert_eq!(error.code, "factory_checksum");
        let found = levels(&report);
        for expected in [("checksum", Level::Error), ("skin", Level::Error), ("clips", Level::Error)] {
            assert!(found.contains(&expected), "{found:?}");
        }
        assert!(report.checks.iter().any(|check| check.code == "clips" && check.message.contains("walk")));
        assert!(report.checks.iter().any(|check| check.code == "unused_clips" && check.message.contains("Sit")));
        assert_eq!(report.model.as_ref().unwrap().animations, ["Idle", "Sit"]);

        let mut report = Report::default();
        let sha = hex::encode(Sha256::digest(&statue));
        // Its animations have no channels, which the glTF schema requires: the reason is named, not just the rig.
        let error = verify("minime", &statue, Some(sha.as_str()), &mut report).unwrap_err();
        assert_eq!((error.code, error.message), ("not_playable", glb::Problem::Schema.message()));
        assert_eq!(levels(&report).iter().find(|(code, _)| *code == "model_data"), Some(&("model_data", Level::Error)));
        // A resident needs a rig and idle, not a walk; furniture needs neither a rig nor clips.
        let mut report = Report::default();
        let error = verify("npc", &statue, None, &mut report).unwrap_err();
        assert_eq!((error.code, error.message), ("not_playable", glb::Problem::Schema.message()));
        assert!(report.checks.iter().any(|check| check.code == "clips" && check.level == Level::Error));
        let (mut unrigged, bin) = crate::test_glb::document(&["Idle"]);
        unrigged["nodes"][2].as_object_mut().unwrap().remove("skin");
        let mut report = Report::default();
        let error = verify("npc", &glb::join(&unrigged, &bin), None, &mut report).unwrap_err();
        assert_eq!((error.code, error.message), ("not_playable", NOT_RESIDENT.message));
        assert!(report.checks.iter().any(|check| check.code == "skin" && check.message == "리깅(스킨)이 없습니다."));
        assert!(!levels(&report).iter().any(|(code, _)| *code == "model_data"));
        let standing = crate::test_glb::character(&["Idle"]);
        let mut report = Report::default();
        assert!(verify("npc", &standing, None, &mut report).is_ok());
        assert_eq!(verify("minime", &standing, None, &mut Report::default()).unwrap_err().code, "not_playable");
        let mut report = Report::default();
        assert!(verify("furniture", &statue, None, &mut report).is_ok());
        assert!(levels(&report).contains(&("checksum", Level::Warning)));
        assert!(!levels(&report).iter().any(|(_, level)| *level == Level::Error));

        let mut report = Report::default();
        assert_eq!(verify("minime", b"nope", None, &mut report).unwrap_err().code, "not_glb");
        assert_eq!(levels(&report).last(), Some(&("glb", Level::Error)));
    }

    #[test]
    fn a_web_copy_is_checked_for_size_and_leftover_large_maps() {
        let big = glb::Texture { image: 0, mime: None, width: Some(2048), height: Some(1024), bytes: Some(10) };
        let mut report = Report::default();
        web_checks(&mut report, 30 << 20, 26 << 20, true, &[big]);
        assert_eq!(
            levels(&report),
            [("slim", Level::Ok), ("texture_size", Level::Warning), ("file_size", Level::Warning)]
        );
        assert_eq!(report.checks[0].message, "텍스처를 웹용으로 줄였습니다: 30.0 MB → 26.0 MB");
        let mut report = Report::default();
        web_checks(&mut report, 900, 900, false, &[]);
        assert_eq!(levels(&report), [("slim", Level::Info), ("file_size", Level::Ok)]);
        assert_eq!(size_text(900), "1 KB");
    }

    #[test]
    fn studio_imports_never_replace_built_ins_or_change_kinds() {
        assert!(check_target("minime", "factory", "minime").is_ok());
        assert_eq!(check_target("minime", "builtin", "minime").unwrap_err().code, "builtin_item");
        assert_eq!(check_target("furniture", "factory", "minime").unwrap_err().code, "kind_mismatch");
    }
}
