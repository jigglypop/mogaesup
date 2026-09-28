//! Finished characters on the character server (gaesup-character), picked the way its own studio picks them: sealed
//! `character_parts` assemblies not uploaded as-is, the newest job per character, minus what the operator deleted or
//! archived. A character's playable file is the copy with the selected face baked in when there is one.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::{
    AppState,
    error::{ApiResult, conflict, not_found},
    factory::fetch_json,
};

/// Character-flow stages of a sealed assembly: faces done, or still being baked.
const FINISHED_STAGES: [&str; 2] = ["complete", "expressions"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub job_id: String,
    pub character_id: Option<String>,
    pub name: String,
    pub version: String,
    /// `complete` (face baked) or `expressions` (face still pending; the plain assembly is used).
    pub stage: String,
    pub created_at: Option<String>,
    /// The assembly's front render through the admin proxy.
    pub thumbnail_url: String,
}

/// Where a character's playable model and front render are, and the model's recorded SHA-256.
#[derive(Debug, PartialEq)]
pub struct Source {
    pub version: String,
    pub expression: Option<String>,
    pub model_path: String,
    pub model_sha256: Option<String>,
    pub thumbnail_path: String,
}

/// Ids the character server hands out, checked before they become path segments.
pub fn segment(value: &str) -> Option<&str> {
    let valid = (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b));
    valid.then_some(value)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|text| !text.is_empty())
}

fn flag(entry: Option<&Value>, key: &str) -> bool {
    entry.and_then(|entry| entry.get(key)).and_then(Value::as_bool).unwrap_or(false)
}

fn artifact_sha256(artifacts: Option<&Value>, name: &str) -> Option<String> {
    artifacts?
        .as_array()?
        .iter()
        .find(|artifact| text(artifact, "name") == Some(name))
        .and_then(|artifact| text(artifact, "sha256"))
        .map(str::to_owned)
}

fn thumbnail_path(job: &str, version: &str) -> String {
    format!("avatar-factory/jobs/{job}/native-parts/{version}/front.png")
}

/// The finished characters in a job listing and studio catalog, newest first.
pub fn finished(jobs: &Value, catalog: &Value) -> Vec<Character> {
    let mut newest: HashMap<String, Character> = HashMap::new();
    for job in jobs["jobs"].as_array().into_iter().flatten() {
        let (Some(id), Some(version)) =
            (text(job, "id").and_then(segment), text(job, "assembly_version").and_then(segment))
        else {
            continue;
        };
        let stage = job["character_flow"]["stage"].as_str().unwrap_or_default();
        let character_id = text(job, "character_id").map(str::to_owned);
        let body = catalog["parts"].get(format!("{id}:body"));
        let removed = flag(catalog["items"].get(id), "deleted")
            || flag(catalog["items"].get(id), "archived")
            || flag(body, "deleted")
            || character_id.as_deref().is_some_and(|character| flag(catalog["characters"].get(character), "deleted"));
        if text(job, "production_mode") != Some("character_parts")
            || text(job, "assembly_origin") == Some("uploaded_glb")
            || !FINISHED_STAGES.contains(&stage)
            || removed
        {
            continue;
        }
        let name = body
            .and_then(|body| text(body, "name"))
            .or_else(|| catalog["items"].get(id).and_then(|item| text(item, "name")))
            .or_else(|| text(job, "character_name"))
            .unwrap_or(id);
        let character = Character {
            job_id: id.to_owned(),
            character_id: character_id.clone(),
            name: name.chars().take(30).collect(),
            version: version.to_owned(),
            stage: stage.to_owned(),
            created_at: text(job, "created_at").map(str::to_owned),
            thumbnail_url: format!("/api/factory/{}", thumbnail_path(id, version)),
        };
        let group = character_id.unwrap_or_else(|| id.to_owned());
        if newest.get(&group).is_none_or(|kept| kept.created_at < character.created_at) {
            newest.insert(group, character);
        }
    }
    let mut characters: Vec<Character> = newest.into_values().collect();
    characters.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.job_id.cmp(&b.job_id)));
    characters
}

pub async fn list(state: &AppState, username: &str) -> ApiResult<Vec<Character>> {
    let jobs = fetch_json(state, username, "avatar-factory/jobs").await?.unwrap_or_default();
    let catalog = fetch_json(state, username, "studio/catalog").await?.unwrap_or_default();
    Ok(finished(&jobs, &catalog))
}

/// A job's sealed assembly and, when its face is chosen, the copy with that face baked in.
pub fn source_of(job_id: &str, job: &Value, expressions: Option<&Value>) -> ApiResult<Source> {
    let version = text(job, "assembly_version")
        .and_then(segment)
        .ok_or(conflict("factory_not_sealed", "아직 조립이 끝나지 않은 캐릭터입니다."))?;
    let selected = expressions.and_then(|listing| {
        let id = text(listing, "selected").and_then(segment)?;
        let item = listing["items"].as_array()?.iter().find(|item| text(item, "id") == Some(id))?;
        Some((id, item))
    });
    let (expression, model_path, model_sha256) = match selected {
        Some((id, item)) => (
            Some(id.to_owned()),
            format!("studio/bodies/{job_id}/{version}/expressions/{id}/model.glb"),
            artifact_sha256(item.get("artifacts"), "model.glb"),
        ),
        None => (
            None,
            format!("avatar-factory/jobs/{job_id}/native-parts/{version}/model.glb"),
            artifact_sha256(job.get("assembly_artifacts"), "model.glb"),
        ),
    };
    Ok(Source {
        version: version.to_owned(),
        expression,
        model_path,
        model_sha256,
        thumbnail_path: thumbnail_path(job_id, version),
    })
}

pub async fn source(state: &AppState, username: &str, job_id: &str) -> ApiResult<Source> {
    let job_id = segment(job_id).ok_or(not_found("factory_job_not_found", "캐릭터 서버에 없는 작업입니다."))?;
    let job = fetch_json(state, username, &format!("avatar-factory/jobs/{job_id}"))
        .await?
        .ok_or(not_found("factory_job_not_found", "캐릭터 서버에 없는 작업입니다."))?;
    let version = text(&job, "assembly_version").and_then(segment);
    let expressions = match version {
        Some(version) => fetch_json(state, username, &format!("studio/bodies/{job_id}/{version}/expressions")).await?,
        None => None,
    };
    source_of(job_id, &job, expressions.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(id: &str, character: &str, created: &str, stage: &str) -> Value {
        json!({"id": id, "character_id": character, "character_name": format!("{id} 이름"), "created_at": created,
            "production_mode": "character_parts", "assembly_version": "v1", "assembly_origin": "generated_parts_fitted_to_meshy_body",
            "character_flow": {"stage": stage}, "assembly_artifacts": [{"name": "model.glb", "sha256": "aa"}]})
    }

    #[test]
    fn the_newest_finished_job_stands_for_each_character() {
        let mut uploaded = job("up", "c4", "2026-09-05", "complete");
        uploaded["assembly_origin"] = json!("uploaded_glb");
        let mut unsealed = job("wip", "c5", "2026-09-06", "assemble");
        unsealed["assembly_version"] = Value::Null;
        let jobs = json!({"jobs": [
            job("old", "c1", "2026-09-01", "complete"), job("new", "c1", "2026-09-03", "expressions"),
            job("solo", "c2", "2026-09-02", "complete"), job("gone", "c3", "2026-09-04", "complete"),
            job("paused", "c6", "2026-09-07", "assemble"), uploaded, unsealed,
            {"id": "../x", "assembly_version": "v1", "production_mode": "character_parts", "character_flow": {"stage": "complete"}},
        ]});
        let catalog =
            json!({"items": {}, "parts": {"solo:body": {"name": "모개"}}, "characters": {"c3": {"deleted": true}}});
        let found = finished(&jobs, &catalog);
        let ids: Vec<_> = found.iter().map(|character| character.job_id.as_str()).collect();
        assert_eq!(ids, ["new", "solo"]);
        assert_eq!(found[1].name, "모개");
        assert_eq!(found[0].stage, "expressions");
        assert_eq!(found[1].thumbnail_url, "/api/factory/avatar-factory/jobs/solo/native-parts/v1/front.png");
    }

    #[test]
    fn a_chosen_face_picks_the_baked_copy() {
        let job = job("j1", "c1", "2026-09-01", "complete");
        let plain = source_of("j1", &job, None).unwrap();
        assert_eq!(plain.model_path, "avatar-factory/jobs/j1/native-parts/v1/model.glb");
        assert_eq!(plain.model_sha256.as_deref(), Some("aa"));
        let faces = json!({"selected": "smile", "items": [{"id": "smile", "artifacts": [{"name": "model.glb", "sha256": "bb"}]}]});
        let baked = source_of("j1", &job, Some(&faces)).unwrap();
        assert_eq!(baked.model_path, "studio/bodies/j1/v1/expressions/smile/model.glb");
        assert_eq!((baked.expression.as_deref(), baked.model_sha256.as_deref()), (Some("smile"), Some("bb")));
        let unsealed = json!({"id": "j2"});
        assert_eq!(source_of("j2", &unsealed, None).unwrap_err().code, "factory_not_sealed");
    }
}
