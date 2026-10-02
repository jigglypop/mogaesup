//! What a GLB carries, read from its JSON chunk: whether it is rigged, and which animations gaesup-world can play.
//! [`details`] also measures it for the import report: geometry, rest-pose size and the embedded textures. [`split`] and
//! [`join`] take the container apart and put it back together.

use image::ImageReader;
use serde::Serialize;
use serde_json::Value;
use std::io::Cursor;

use crate::gltf::{Matrix, index, numbers, pad, view_range, walk};

const MAGIC: u32 = 0x4654_6c67; // "glTF"
const VERSION: u32 = 2;
const JSON_CHUNK: u32 = 0x4e4f_534a; // "JSON"
const BIN_CHUNK: u32 = 0x004e_4942; // "BIN\0"

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
        self.missing_clips().is_empty() && self.skinned
    }

    /// Required clips the model cannot play, in [`REQUIRED_CLIPS`] order.
    pub fn missing_clips(&self) -> Vec<&'static str> {
        self.missing(&REQUIRED_CLIPS)
    }

    /// Of `wanted` engine clips, the ones the model cannot play, in `wanted` order.
    pub fn missing(&self, wanted: &[&'static str]) -> Vec<&'static str> {
        wanted.iter().copied().filter(|clip| !self.clips.iter().any(|have| have == clip)).collect()
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
    Some(u32::from_le_bytes(bytes.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

/// The JSON chunk of a whole binary glTF 2.0 file, and its binary chunk when the next chunk is one (empty otherwise;
/// chunks of other kinds are ignored, as the format asks).
pub fn split(bytes: &[u8]) -> Option<(Value, &[u8])> {
    if word(bytes, 0)? != MAGIC || word(bytes, 4)? != VERSION || word(bytes, 8)? as usize != bytes.len() {
        return None;
    }
    let json_end = 20usize.checked_add(word(bytes, 12)? as usize)?;
    if word(bytes, 16)? != JSON_CHUNK {
        return None;
    }
    let json = serde_json::from_slice(bytes.get(20..json_end)?).ok()?;
    let bin = match (word(bytes, json_end), word(bytes, json_end + 4)) {
        (Some(length), Some(BIN_CHUNK)) => {
            (json_end + 8).checked_add(length as usize).and_then(|end| bytes.get(json_end + 8..end)).unwrap_or_default()
        }
        _ => &[],
    };
    Some((json, bin))
}

fn summarize(json: &Value) -> Summary {
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
    Summary { skinned, clips }
}

/// One image the model embeds; sizes are None when it is not in the binary chunk or its header cannot be read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Texture {
    pub image: usize,
    pub mime: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: Option<usize>,
}

impl Texture {
    pub fn edge(&self) -> Option<u32> {
        Some(self.width?.max(self.height?))
    }
}

/// What the import report shows about a model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub skinned: bool,
    /// Joints of the largest skin.
    pub joints: usize,
    /// Engine clip names, as in [`Summary`].
    pub clips: Vec<String>,
    /// Every animation's own name, in file order.
    pub animations: Vec<String>,
    pub meshes: usize,
    pub materials: usize,
    /// Triangles and vertices drawn, counting each node that places a mesh.
    pub triangles: u64,
    pub vertices: u64,
    /// Width, height and depth of the unanimated model in metres: position bounds through the node transforms.
    pub size: Option<[f64; 3]>,
    pub textures: Vec<Texture>,
}

impl Details {
    pub fn summary(&self) -> Summary {
        Summary { skinned: self.skinned, clips: self.clips.clone() }
    }
}

fn accessor_count(json: &Value, accessor: &Value) -> u64 {
    index(accessor)
        .and_then(|at| json["accessors"].get(at))
        .and_then(|accessor| accessor["count"].as_u64())
        .unwrap_or(0)
}

/// Triangles and vertices of one mesh.
fn mesh_counts(json: &Value, mesh: &Value) -> (u64, u64) {
    let mut totals = (0, 0);
    for primitive in mesh["primitives"].as_array().into_iter().flatten() {
        let vertices = accessor_count(json, &primitive["attributes"]["POSITION"]);
        let elements =
            if primitive["indices"].is_null() { vertices } else { accessor_count(json, &primitive["indices"]) };
        totals.0 += match primitive["mode"].as_u64().unwrap_or(4) {
            4 => elements / 3,
            5 | 6 => elements.saturating_sub(2),
            _ => 0,
        };
        totals.1 += vertices;
    }
    totals
}

fn transform(m: &Matrix, [x, y, z]: [f64; 3]) -> [f64; 3] {
    [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ]
}

/// What the default scene draws: triangles and vertices of every node that places a mesh, and the bounding box size.
/// Skinned meshes are measured where their nodes place them, which for the character server's exports is the bind pose.
/// A file without nodes counts each mesh once.
fn placed(json: &Value) -> (u64, u64, Option<[f64; 3]>) {
    let (mut triangles, mut vertices, mut meshes_placed) = (0, 0, 0);
    let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    walk(json, |_, node, world| {
        let mesh = index(&node["mesh"]).and_then(|mesh| json["meshes"].get(mesh));
        if let Some(mesh) = mesh {
            let (t, v) = mesh_counts(json, mesh);
            (triangles, vertices, meshes_placed) = (triangles + t, vertices + v, meshes_placed + 1);
        }
        for primitive in mesh.and_then(|mesh| mesh["primitives"].as_array()).into_iter().flatten() {
            let Some(accessor) = index(&primitive["attributes"]["POSITION"]).and_then(|a| json["accessors"].get(a))
            else {
                continue;
            };
            let (min, max) = (numbers(&accessor["min"], [f64::NAN; 3]), numbers(&accessor["max"], [f64::NAN; 3]));
            if min.iter().chain(&max).any(|value| !value.is_finite()) {
                continue;
            }
            for corner in 0..8 {
                let point = std::array::from_fn(|axis| if corner >> axis & 1 == 0 { min[axis] } else { max[axis] });
                for (axis, value) in transform(world, point).into_iter().enumerate() {
                    low[axis] = low[axis].min(value);
                    high[axis] = high[axis].max(value);
                }
            }
        }
    });
    if json["nodes"].as_array().is_none_or(Vec::is_empty) && meshes_placed == 0 {
        for mesh in json["meshes"].as_array().into_iter().flatten() {
            let (t, v) = mesh_counts(json, mesh);
            (triangles, vertices) = (triangles + t, vertices + v);
        }
    }
    let size: [f64; 3] = std::array::from_fn(|axis| high[axis] - low[axis]);
    (triangles, vertices, size.iter().all(|value| value.is_finite() && *value >= 0.0).then_some(size))
}

fn view<'a>(json: &Value, bin: &'a [u8], view: usize) -> Option<&'a [u8]> {
    let view = json["bufferViews"].get(view)?;
    if view["buffer"].as_u64() != Some(0) || json["buffers"][0].get("uri").is_some() {
        return None;
    }
    bin.get(view_range(view)?)
}

fn textures(json: &Value, bin: &[u8]) -> Vec<Texture> {
    let images = json["images"].as_array().into_iter().flatten();
    images
        .enumerate()
        .map(|(at, image)| {
            let data = index(&image["bufferView"]).and_then(|v| view(json, bin, v));
            // Only the header is read; the pixels stay compressed.
            let dimensions = data.and_then(|data| {
                ImageReader::new(Cursor::new(data)).with_guessed_format().ok()?.into_dimensions().ok()
            });
            Texture {
                image: at,
                mime: image["mimeType"].as_str().map(str::to_owned),
                width: dimensions.map(|(width, _)| width),
                height: dimensions.map(|(_, height)| height),
                bytes: data.map(<[u8]>::len),
            }
        })
        .collect()
}

/// Everything the import report shows about a GLB; None unless `bytes` is a whole binary glTF 2.0 file whose first
/// chunk is its JSON.
pub fn details(bytes: &[u8]) -> Option<Details> {
    let (json, bin) = split(bytes)?;
    let Summary { skinned, clips } = summarize(&json);
    let (triangles, vertices, size) = placed(&json);
    let count = |key: &str| json[key].as_array().map_or(0, Vec::len);
    Some(Details {
        skinned,
        joints: json["skins"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|skin| skin["joints"].as_array().map_or(0, Vec::len))
            .max()
            .unwrap_or(0),
        clips,
        animations: json["animations"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(at, animation)| animation["name"].as_str().map_or_else(|| format!("#{at}"), str::to_owned))
            .collect(),
        meshes: count("meshes"),
        materials: count("materials"),
        triangles,
        vertices,
        size,
        textures: textures(&json, bin),
    })
}

/// A GLB of `json` and, when there is any, a binary chunk of `bin`, each padded to four bytes.
pub fn join(json: &Value, bin: &[u8]) -> Vec<u8> {
    let mut chunk = serde_json::to_vec(json).unwrap_or_default();
    while !chunk.len().is_multiple_of(4) {
        chunk.push(b' ');
    }
    let mut data = bin.to_vec();
    pad(&mut data);
    let total = 12 + 8 + chunk.len() + if data.is_empty() { 0 } else { 8 + data.len() };
    let mut bytes = Vec::with_capacity(total);
    for value in [MAGIC, VERSION, total as u32, chunk.len() as u32, JSON_CHUNK] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&chunk);
    if !data.is_empty() {
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&BIN_CHUNK.to_le_bytes());
        bytes.extend_from_slice(&data);
    }
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

    fn summary(json: &Value) -> Summary {
        details(&join(json, &[])).unwrap().summary()
    }

    #[test]
    fn a_rigged_model_with_idle_and_walk_is_playable() {
        let rigged = summary(&json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}],
            "animations": [{"name": "Idle"}, {"name": "Walking"}, {"name": "Running"}, {"name": "Walking"}]}));
        assert_eq!(rigged.clips, ["idle", "run", "walk"]);
        assert!(rigged.playable());
        let statue = json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]});
        assert!(!summary(&statue).playable());
        let still = json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}], "animations": [{"name": "Idle"}]});
        let still = summary(&still);
        assert!(!still.playable());
        assert_eq!(still.missing_clips(), ["walk"]);
    }

    #[test]
    fn anything_but_a_whole_glb_is_refused() {
        let bytes = join(&json!({"asset": {"version": "2.0"}}), &[]);
        assert!(details(&bytes).is_some());
        assert!(details(&bytes[..bytes.len() - 1]).is_none());
        assert!(details(b"not a model at all").is_none());
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::RgbaImage::new(width, height).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn details_count_placed_geometry_measure_the_pose_and_read_texture_headers() {
        let picture = png(300, 200);
        // A centimetre-scale body under a 0.01 root, placed three times: as is, as a strip, and quarter-turned about Y
        // five metres back. Node 4 is in no scene, so nothing draws it.
        let turn = std::f64::consts::FRAC_1_SQRT_2;
        let json = json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"scale": [0.01, 0.01, 0.01], "children": [1, 2, 3]}, {"mesh": 0},
                {"mesh": 0, "translation": [0, 0, 500], "rotation": [0, turn, 0, turn]}, {"mesh": 1},
                {"mesh": 0, "translation": [0, 900, 0]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]},
                {"primitives": [{"attributes": {"POSITION": 0}, "mode": 5}]}],
            "accessors": [{"count": 30, "min": [-20, 0, -10], "max": [20, 170, 10]}, {"count": 36}],
            "skins": [{"joints": [0, 1, 2]}, {"joints": [0]}],
            "materials": [{}, {}],
            "buffers": [{"byteLength": picture.len()}],
            "bufferViews": [{"buffer": 0, "byteLength": picture.len()}],
            "images": [{"bufferView": 0, "mimeType": "image/png"}, {"uri": "outside.png"}],
            "animations": [{"name": "Armature|Idle"}, {"name": "Dance"}, {}],
        });
        let details = details(&join(&json, &picture)).unwrap();
        assert_eq!((details.triangles, details.vertices), (12 + 12 + 28, 90));
        let [width, height, depth] = details.size.unwrap();
        assert!((height - 1.7).abs() < 1e-6, "{height}");
        // The turned copy spans z 4.8..5.2 m (its 40 cm width now runs along z); unturned it would stop at 5.1.
        assert!((width - 0.4).abs() < 1e-6 && (depth - 5.3).abs() < 1e-6, "{width} {depth}");
        assert_eq!((details.joints, details.meshes, details.materials), (3, 2, 2));
        assert_eq!(details.clips, ["idle"]);
        assert_eq!(details.animations, ["Armature|Idle", "Dance", "#2"]);
        assert_eq!(details.textures[0].edge(), Some(300));
        assert_eq!(details.textures[0].bytes, Some(picture.len()));
        assert_eq!(details.textures[1], Texture { image: 1, mime: None, width: None, height: None, bytes: None });
    }

    #[test]
    fn a_model_without_positions_has_no_size() {
        let json = json!({"asset": {"version": "2.0"}, "nodes": [{"mesh": 0}], "meshes": [{"primitives": [{"attributes": {}}]}]});
        let details = details(&join(&json, &[])).unwrap();
        assert_eq!(details.size, None);
        assert_eq!(details.triangles, 0);
    }
}
