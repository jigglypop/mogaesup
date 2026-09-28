//! What a GLB carries, read from its JSON chunk: whether it is rigged, and which animations gaesup-world can play.

const MAGIC: u32 = 0x4654_6c67; // "glTF"
const VERSION: u32 = 2;
const JSON_CHUNK: u32 = 0x4e4f_534a; // "JSON"

/// Clips a 미니미 needs to stand and walk; the engine holds its rest pose for any other missing motion.
pub const REQUIRED_CLIPS: [&str; 2] = ["idle", "walk"];

#[derive(Debug, PartialEq)]
pub struct Summary {
    pub skinned: bool,
    /// Engine clip names the model can play, sorted and without repeats.
    pub clips: Vec<String>,
}

impl Summary {
    pub fn playable(&self) -> bool {
        self.skinned && REQUIRED_CLIPS.iter().all(|clip| self.clips.iter().any(|have| have == clip))
    }
}

/// gaesup-world's name for a clip (`Walking` → `walk`, `preset:biped:look_around` → `look`), as its
/// `figureClipName` maps them.
pub fn engine_clip(name: &str) -> Option<&'static str> {
    let last = name.rsplit(['|', ':']).next().unwrap_or(name).trim().to_lowercase();
    // `/[\s.-]+/g` → `_`: each run of separators becomes one underscore.
    let mut key = String::with_capacity(last.len());
    let mut in_run = false;
    for c in last.chars() {
        let separator = c.is_whitespace() || c == '.' || c == '-';
        if !separator {
            key.push(c);
        } else if !in_run {
            key.push('_');
        }
        in_run = separator;
    }
    Some(match key.as_str() {
        "idle" => "idle",
        "walk" | "walking" => "walk",
        "run" | "running" => "run",
        "jump" | "jumping" => "jump",
        "fall" | "falling" => "fall",
        "wave" | "wave_one_hand" | "wave_goodbye" | "wave_goodbye_01" | "big_wave_hello" => "wave",
        "look" | "look_around" => "look",
        _ => return None,
    })
}

fn word(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// None unless `bytes` is a whole binary glTF 2.0 file whose first chunk is its JSON.
pub fn inspect(bytes: &[u8]) -> Option<Summary> {
    if word(bytes, 0)? != MAGIC || word(bytes, 4)? != VERSION || word(bytes, 8)? as usize != bytes.len() {
        return None;
    }
    let length = word(bytes, 12)? as usize;
    if word(bytes, 16)? != JSON_CHUNK {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(bytes.get(20..20 + length)?).ok()?;
    let skinned = json["skins"].as_array().is_some_and(|skins| !skins.is_empty());
    let mut clips: Vec<String> = json["animations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|animation| engine_clip(animation["name"].as_str()?))
        .map(str::to_owned)
        .collect();
    clips.sort();
    clips.dedup();
    Some(Summary { skinned, clips })
}

#[cfg(test)]
pub fn build(json: &serde_json::Value) -> Vec<u8> {
    let mut chunk = serde_json::to_vec(json).unwrap();
    while !chunk.len().is_multiple_of(4) {
        chunk.push(b' ');
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MAGIC.to_le_bytes());
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    bytes.extend_from_slice(&((12 + 8 + chunk.len()) as u32).to_le_bytes());
    bytes.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&JSON_CHUNK.to_le_bytes());
    bytes.extend_from_slice(&chunk);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_names_follow_the_engine() {
        assert_eq!(engine_clip("Walking"), Some("walk"));
        assert_eq!(engine_clip("Armature|Running"), Some("run"));
        assert_eq!(engine_clip("preset:biped:look_around"), Some("look"));
        assert_eq!(engine_clip("Wave One-Hand"), Some("wave"));
        assert_eq!(engine_clip("Walking.001"), None);
        assert_eq!(engine_clip("dance"), None);
    }

    #[test]
    fn a_rigged_model_with_idle_and_walk_is_playable() {
        let rigged = json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}],
            "animations": [{"name": "Idle"}, {"name": "Walking"}, {"name": "Running"}, {"name": "Walking"}]});
        let summary = inspect(&build(&rigged)).unwrap();
        assert_eq!(summary.clips, ["idle", "run", "walk"]);
        assert!(summary.playable());
        let statue = json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]});
        assert!(!inspect(&build(&statue)).unwrap().playable());
        let still = json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}]});
        assert!(!inspect(&build(&still)).unwrap().playable());
    }

    #[test]
    fn anything_but_a_whole_glb_is_refused() {
        let bytes = build(&json!({"asset": {"version": "2.0"}}));
        assert!(inspect(&bytes).is_some());
        assert!(inspect(&bytes[..bytes.len() - 1]).is_none());
        assert!(inspect(b"not a model at all").is_none());
    }
}
