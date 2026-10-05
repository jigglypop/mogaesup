//! 주민: studio characters an island's owner stands on the island, each with a name and a line it says to whoever
//! talks to it. They are saved with the island, as the `residents` domain of its save envelope, so visitors load the
//! same ones. Only the catalog item is stored; its model comes from the catalog whenever the island loads.

use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::HashSet;

use crate::{catalog::catalog_id, error::ApiResult};

/// The save envelope's domain key.
pub const DOMAIN: &str = "residents";
pub const MAX_RESIDENTS: usize = 12;
const MAX_NAME: usize = 20;
const MAX_GREETING: usize = 80;
/// Residents stand on the island, which is 56 m across; the building grid reaches a little past it.
const MAX_COORDINATE: f64 = 100.0;

fn text(value: &Value, min: usize, max: usize) -> bool {
    value.as_str().is_some_and(|text| {
        let count = text.chars().count();
        (min..=max).contains(&count) && text.trim().chars().count() >= min && !text.chars().any(char::is_control)
    })
}

fn resident_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}

fn coordinate(value: &Value) -> bool {
    value.as_f64().is_some_and(|v| v.is_finite() && v.abs() <= MAX_COORDINATE)
}

/// The catalog items the domain names, or what is wrong with its shape: `{version: 1, residents: [{id, npc, name,
/// greeting, position: [x, y, z], rotation}]}`, at most [`MAX_RESIDENTS`], ids unique, nothing else in an entry.
pub fn shape(domain: &Value) -> Result<Vec<String>, &'static str> {
    let domain = domain.as_object().ok_or("residents")?;
    if domain.get("version").and_then(Value::as_i64) != Some(1)
        || domain.keys().any(|key| key != "version" && key != "residents")
    {
        return Err("residents");
    }
    let list = domain.get("residents").and_then(Value::as_array).ok_or("residents")?;
    if list.len() > MAX_RESIDENTS {
        return Err("residents_count");
    }
    let mut ids = HashSet::new();
    let mut items = Vec::new();
    for entry in list {
        let entry = entry.as_object().ok_or("resident")?;
        const FIELDS: [&str; 6] = ["id", "npc", "name", "greeting", "position", "rotation"];
        if entry.len() != FIELDS.len() || !FIELDS.iter().all(|field| entry.contains_key(*field)) {
            return Err("resident");
        }
        if !resident_id(&entry["id"]) || !ids.insert(entry["id"].as_str().unwrap_or_default()) {
            return Err("resident_id");
        }
        let npc = entry["npc"].as_str().filter(|id| catalog_id(id).is_ok()).ok_or("resident_npc")?;
        if !text(&entry["name"], 1, MAX_NAME) || !text(&entry["greeting"], 0, MAX_GREETING) {
            return Err("resident_text");
        }
        let position = entry["position"].as_array().filter(|p| p.len() == 3 && p.iter().all(coordinate));
        if position.is_none() || !entry["rotation"].as_f64().is_some_and(f64::is_finite) {
            return Err("resident_place");
        }
        items.push(npc.to_owned());
    }
    items.sort();
    items.dedup();
    Ok(items)
}

/// Why the island's residents may not be saved: a malformed domain, or a resident that is no 주민 in the catalog. A
/// retired one still passes, so an island keeps saving after an admin takes a resident off the drawer (islands only
/// draw published ones). An island without the domain has none.
pub async fn problem(db: &PgPool, domains: &Map<String, Value>) -> ApiResult<Option<&'static str>> {
    let Some(domain) = domains.get(DOMAIN) else { return Ok(None) };
    let items = match shape(domain) {
        Ok(items) => items,
        Err(problem) => return Ok(Some(problem)),
    };
    Ok(unknown(db, &items).await?.then_some("resident_npc"))
}

/// Whether any of `items` (each once, as [`shape`] gives them) is no 주민 in the catalog.
pub async fn unknown(db: &PgPool, items: &[String]) -> ApiResult<bool> {
    if items.is_empty() {
        return Ok(false);
    }
    let known: i64 = sqlx::query_scalar("SELECT count(*) FROM catalog_items WHERE id = ANY($1) AND kind = 'npc'")
        .bind(items)
        .fetch_one(db)
        .await?;
    Ok(known != items.len() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resident(id: &str, npc: &str) -> Value {
        json!({"id": id, "npc": npc, "name": "모개", "greeting": "어서 와", "position": [2.0, 0.0, -18.0], "rotation": 1.5})
    }

    #[test]
    fn residents_name_catalog_items_once_and_stay_on_the_island() {
        let ok = json!({"version": 1, "residents": [resident("a", "npc-hero"), resident("b", "npc-hero"), resident("c", "npc-cat")]});
        assert_eq!(shape(&ok).unwrap(), ["npc-cat", "npc-hero"]);
        assert_eq!(shape(&json!({"version": 1, "residents": []})).unwrap(), Vec::<String>::new());

        let with = |change: &dyn Fn(&mut Value)| {
            let mut one = resident("a", "npc-hero");
            change(&mut one);
            shape(&json!({"version": 1, "residents": [one]}))
        };
        assert_eq!(with(&|r| r["name"] = json!("  ")), Err("resident_text"));
        assert_eq!(with(&|r| r["name"] = json!("가".repeat(21))), Err("resident_text"));
        assert_eq!(with(&|r| r["greeting"] = json!("")), Ok(vec!["npc-hero".to_owned()]));
        assert_eq!(with(&|r| r["greeting"] = json!("a\nb")), Err("resident_text"));
        assert_eq!(with(&|r| r["npc"] = json!("../x")), Err("resident_npc"));
        assert_eq!(with(&|r| r["position"] = json!([0, 0, 1000])), Err("resident_place"));
        assert_eq!(with(&|r| r["position"] = json!([0, 0])), Err("resident_place"));
        assert_eq!(with(&|r| r["rotation"] = json!("north")), Err("resident_place"));
        assert_eq!(with(&|r| r["id"] = json!("a b")), Err("resident_id"));
        assert_eq!(with(&|r| r["modelUrl"] = json!("https://evil.example/x.glb")), Err("resident"));

        let twice = json!({"version": 1, "residents": [resident("a", "npc-hero"), resident("a", "npc-hero")]});
        assert_eq!(shape(&twice), Err("resident_id"));
        let crowd: Vec<Value> = (0..=MAX_RESIDENTS).map(|i| resident(&format!("r{i}"), "npc-hero")).collect();
        assert_eq!(shape(&json!({"version": 1, "residents": crowd})), Err("residents_count"));
        assert_eq!(shape(&json!({"version": 2, "residents": []})), Err("residents"));
        assert_eq!(shape(&json!([resident("a", "npc-hero")])), Err("residents"));
    }
}
