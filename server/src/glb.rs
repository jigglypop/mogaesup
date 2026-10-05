//! What a GLB carries, read from its JSON chunk: whether it is rigged, and which animations gaesup-world can play.
//! [`details`] also measures it for the import report: geometry, rest-pose size and the embedded textures. [`split`] and
//! [`join`] take the container apart and put it back together.

use image::ImageReader;
use serde::Serialize;
use serde_json::Value;
use std::io::Cursor;

pub use crate::glb_validation::Problem;
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
    /// Why the data cannot back a playable character; None when it can (it is skinned).
    pub problem: Option<Problem>,
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
    if json_end % 4 != 0 {
        return None;
    }
    let json: Value = serde_json::from_slice(bytes.get(20..json_end)?).ok()?;
    if json["asset"]["version"].as_str() != Some("2.0") {
        return None;
    }
    let mut bin = &[][..];
    let mut at = json_end;
    while at < bytes.len() {
        let length = word(bytes, at)? as usize;
        let kind = word(bytes, at.checked_add(4)?)?;
        let start = at.checked_add(8)?;
        let end = start.checked_add(length)?;
        if !length.is_multiple_of(4) || kind == JSON_CHUNK {
            return None;
        }
        let data = bytes.get(start..end)?;
        if kind == BIN_CHUNK {
            if at != json_end || !bin.is_empty() {
                return None;
            }
            bin = data;
        }
        at = end;
    }
    Some((json, bin))
}

fn summarize(json: &Value, bin: &[u8]) -> Summary {
    match crate::glb_validation::character(json, bin) {
        Ok(clips) => Summary { skinned: true, clips, problem: None },
        Err(problem) => Summary { skinned: false, clips: Vec::new(), problem: Some(problem) },
    }
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
    /// Why the data cannot back a playable character, as in [`Summary`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<Problem>,
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
    /// The glTF extensions a reader must know to draw the model (`extensionsRequired`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
}

/// Draco mesh compression: browsers decode it with a script from Google's servers, which the app's CSP does not allow.
pub const DRACO: &str = "KHR_draco_mesh_compression";

impl Details {
    pub fn summary(&self) -> Summary {
        Summary { skinned: self.skinned, clips: self.clips.clone(), problem: self.problem }
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
    let mut totals = (0u64, 0u64);
    for primitive in mesh["primitives"].as_array().into_iter().flatten() {
        let vertices = accessor_count(json, &primitive["attributes"]["POSITION"]);
        let elements =
            if primitive["indices"].is_null() { vertices } else { accessor_count(json, &primitive["indices"]) };
        totals.0 = totals.0.saturating_add(match primitive["mode"].as_u64().unwrap_or(4) {
            4 => elements / 3,
            5 | 6 => elements.saturating_sub(2),
            _ => 0,
        });
        totals.1 = totals.1.saturating_add(vertices);
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
    let (mut triangles, mut vertices, mut meshes_placed) = (0u64, 0u64, 0u64);
    let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    walk(json, |_, node, world| {
        let mesh = index(&node["mesh"]).and_then(|mesh| json["meshes"].get(mesh));
        if let Some(mesh) = mesh {
            let (t, v) = mesh_counts(json, mesh);
            (triangles, vertices, meshes_placed) =
                (triangles.saturating_add(t), vertices.saturating_add(v), meshes_placed.saturating_add(1));
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
            (triangles, vertices) = (triangles.saturating_add(t), vertices.saturating_add(v));
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
    let Summary { skinned, clips, problem } = summarize(&json, bin);
    let (triangles, vertices, size) = placed(&json);
    let count = |key: &str| json[key].as_array().map_or(0, Vec::len);
    Some(Details {
        skinned,
        problem,
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
        required: json["extensionsRequired"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|name| name.as_str().map(str::to_owned))
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
        let rigged =
            details(&crate::test_glb::character(&["Idle", "Walking", "Running", "Walking"])).unwrap().summary();
        assert_eq!(rigged.clips, ["idle", "run", "walk"]);
        assert!(rigged.playable());
        let statue = json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]});
        assert!(!summary(&statue).playable());
        let still = details(&crate::test_glb::character(&["Idle"])).unwrap().summary();
        assert!(!still.playable());
        assert_eq!(still.missing_clips(), ["walk"]);
    }

    #[test]
    fn anything_but_a_whole_glb_is_refused() {
        let bytes = join(&json!({"asset": {"version": "2.0"}}), &[]);
        assert!(details(&bytes).is_some());
        assert!(details(&bytes[..bytes.len() - 1]).is_none());
        assert!(details(b"not a model at all").is_none());
        let mut bad = crate::test_glb::character(&["Idle", "Walking"]);
        let json_end = 20 + word(&bad, 12).unwrap() as usize;
        bad[json_end..json_end + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(details(&bad).is_none(), "a truncated BIN chunk must not become an empty buffer");
    }

    #[test]
    fn labels_empty_rigs_broken_buffers_and_invalid_animation_targets_are_not_playable() {
        let forged =
            json!({"asset": {"version": "2.0"}, "skins": [{}], "animations": [{"name": "idle"}, {"name": "walk"}]});
        assert!(!summary(&forged).playable());
        let (valid, bin) = crate::test_glb::document(&["Idle", "Walking"]);
        assert!(details(&join(&valid, &bin)).unwrap().summary().playable());
        for case in 0..13 {
            let mut invalid = valid.clone();
            let mut data = bin.clone();
            match case {
                0 => invalid["skins"][0]["joints"] = json!([]),
                1 => invalid["nodes"][2].as_object_mut().unwrap().remove("skin").map(|_| ()).unwrap(),
                2 => invalid["bufferViews"][0]["byteOffset"] = u64::MAX.into(),
                3 => invalid["accessors"][0]["count"] = u64::MAX.into(),
                4 => invalid["animations"][1]["channels"] = json!([]),
                5 => invalid["animations"][1]["channels"][0]["target"]["node"] = 900.into(),
                6 => invalid["animations"][1]["samplers"][0]["output"] = 999.into(),
                7 => data[36] = 1, // A vertex refers to joint 1, but this skin only has joint 0.
                8 => data[48..52].copy_from_slice(&f32::NAN.to_le_bytes()),
                9 => invalid["nodes"][1]["children"] = json!([0]), // Two-node cycle, even when the scene names a root.
                10 => invalid["meshes"][0]["primitives"][0]["targets"] = json!([{"POSITION": 999}]),
                11 => invalid["meshes"][0]["primitives"][0]["material"] = 999.into(),
                12 => {
                    let mut extra = invalid["animations"][0].clone();
                    extra["name"] = "Dance".into();
                    extra["samplers"][0]["output"] = 999.into();
                    invalid["animations"].as_array_mut().unwrap().push(extra);
                }
                _ => unreachable!(),
            }
            assert!(!details(&join(&invalid, &data)).unwrap().summary().playable(), "case {case}");
        }
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
        // Labels without readable animation data are report metadata, never certified clips.
        assert!(details.clips.is_empty());
        assert_eq!(details.animations, ["Armature|Idle", "Dance", "#2"]);
        assert_eq!(details.textures[0].edge(), Some(300));
        assert_eq!(details.textures[0].bytes, Some(picture.len()));
        assert_eq!(details.textures[1], Texture { image: 1, mime: None, width: None, height: None, bytes: None });
    }

    #[test]
    fn invalid_huge_counts_are_reported_without_overflow_or_becoming_small() {
        let primitive = json!({"attributes": {"POSITION": 0}, "mode": 5});
        let mut json = json!({
            "asset": {"version": "2.0"}, "accessors": [{"count": u64::MAX}],
            "meshes": [{"primitives": [primitive.clone(), primitive]}],
        });
        for nodes in [None, Some(json!([{"mesh": 0}, {"mesh": 0}]))] {
            if let Some(nodes) = nodes {
                json["nodes"] = nodes;
            }
            let details = details(&join(&json, &[])).unwrap();
            assert!(!details.summary().playable());
            assert_eq!(details.vertices, u64::MAX);
            assert_eq!(details.triangles, u64::MAX);
        }
    }

    #[test]
    fn a_model_without_positions_has_no_size() {
        let json = json!({"asset": {"version": "2.0"}, "nodes": [{"mesh": 0}], "meshes": [{"primitives": [{"attributes": {}}]}]});
        let details = details(&join(&json, &[])).unwrap();
        assert_eq!(details.size, None);
        assert_eq!(details.triangles, 0);
    }
}
