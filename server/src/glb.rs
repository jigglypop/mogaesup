//! What a GLB carries, read from its JSON chunk: whether it is rigged, and which animations gaesup-world can play.
//! [`details`] also measures it for the import report: geometry, rest-pose size and the embedded textures.

use image::ImageReader;
use serde::Serialize;
use serde_json::Value;
use std::io::Cursor;

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
        REQUIRED_CLIPS.into_iter().filter(|clip| !self.clips.iter().any(|have| have == clip)).collect()
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
fn read(bytes: &[u8]) -> Option<(Value, &[u8])> {
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

/// None unless `bytes` is a whole binary glTF 2.0 file whose first chunk is its JSON.
pub fn inspect(bytes: &[u8]) -> Option<Summary> {
    read(bytes).map(|(json, _)| summarize(&json))
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

fn index(value: &Value) -> Option<usize> {
    usize::try_from(value.as_u64()?).ok()
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

/// Column-major 4×4, as glTF writes node matrices.
type Matrix = [f64; 16];
const IDENTITY: Matrix = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

fn numbers<const N: usize>(value: &Value, default: [f64; N]) -> [f64; N] {
    let mut out = default;
    if let Some(items) = value.as_array().filter(|items| items.len() == N) {
        for (slot, item) in out.iter_mut().zip(items) {
            *slot = item.as_f64().unwrap_or(*slot);
        }
    }
    out
}

/// A node's own transform: its matrix, or translation × rotation × scale.
fn local(node: &Value) -> Matrix {
    if node["matrix"].as_array().is_some_and(|matrix| matrix.len() == 16) {
        return numbers(&node["matrix"], IDENTITY);
    }
    let [tx, ty, tz] = numbers(&node["translation"], [0.0; 3]);
    let [x, y, z, w] = numbers(&node["rotation"], [0.0, 0.0, 0.0, 1.0]);
    let [sx, sy, sz] = numbers(&node["scale"], [1.0; 3]);
    [
        (1.0 - 2.0 * (y * y + z * z)) * sx,
        2.0 * (x * y + z * w) * sx,
        2.0 * (x * z - y * w) * sx,
        0.0,
        2.0 * (x * y - z * w) * sy,
        (1.0 - 2.0 * (x * x + z * z)) * sy,
        2.0 * (y * z + x * w) * sy,
        0.0,
        2.0 * (x * z + y * w) * sz,
        2.0 * (y * z - x * w) * sz,
        (1.0 - 2.0 * (x * x + y * y)) * sz,
        0.0,
        tx,
        ty,
        tz,
        1.0,
    ]
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
    let nodes = json["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let scene = &json["scenes"][json["scene"].as_u64().unwrap_or(0) as usize]["nodes"];
    let roots: Vec<usize> = match scene.as_array() {
        Some(roots) => roots.iter().filter_map(index).collect(),
        None => {
            let children: Vec<usize> = nodes
                .iter()
                .flat_map(|node| node["children"].as_array().into_iter().flatten().filter_map(index))
                .collect();
            (0..nodes.len()).filter(|node| !children.contains(node)).collect()
        }
    };
    let (mut triangles, mut vertices, mut meshes_placed) = (0, 0, 0);
    let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    // A node has at most one parent, so each is visited once; a malformed cycle cannot loop.
    let mut seen = vec![false; nodes.len()];
    let mut stack: Vec<(usize, Matrix)> = roots.into_iter().map(|root| (root, IDENTITY)).collect();
    while let Some((at, parent)) = stack.pop() {
        let Some(node) = nodes.get(at).filter(|_| !std::mem::replace(&mut seen[at], true)) else { continue };
        let world = multiply(&parent, &local(node));
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
                for (axis, value) in transform(&world, point).into_iter().enumerate() {
                    low[axis] = low[axis].min(value);
                    high[axis] = high[axis].max(value);
                }
            }
        }
        stack.extend(node["children"].as_array().into_iter().flatten().filter_map(index).map(|child| (child, world)));
    }
    if nodes.is_empty() && meshes_placed == 0 {
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
    let start = usize::try_from(view["byteOffset"].as_u64().unwrap_or(0)).ok()?;
    bin.get(start..start.checked_add(usize::try_from(view["byteLength"].as_u64()?).ok()?)?)
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

/// Everything the import report shows about a GLB; None when [`inspect`] would refuse it.
pub fn details(bytes: &[u8]) -> Option<Details> {
    let (json, bin) = read(bytes)?;
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

#[cfg(test)]
pub fn build(json: &serde_json::Value) -> Vec<u8> {
    build_with(json, &[])
}

/// A GLB of `json` and, when there is any, a binary chunk of `bin`.
#[cfg(test)]
pub fn build_with(json: &serde_json::Value, bin: &[u8]) -> Vec<u8> {
    let mut chunk = serde_json::to_vec(json).unwrap();
    while !chunk.len().is_multiple_of(4) {
        chunk.push(b' ');
    }
    let mut data = bin.to_vec();
    while !data.len().is_multiple_of(4) {
        data.push(0);
    }
    let total = 12 + 8 + chunk.len() + if data.is_empty() { 0 } else { 8 + data.len() };
    let mut bytes = Vec::new();
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

    #[test]
    fn a_rigged_model_with_idle_and_walk_is_playable() {
        let rigged = json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}],
            "animations": [{"name": "Idle"}, {"name": "Walking"}, {"name": "Running"}, {"name": "Walking"}]});
        let summary = inspect(&build(&rigged)).unwrap();
        assert_eq!(summary.clips, ["idle", "run", "walk"]);
        assert!(summary.playable());
        let statue = json!({"asset": {"version": "2.0"}, "animations": [{"name": "idle"}, {"name": "walk"}]});
        assert!(!inspect(&build(&statue)).unwrap().playable());
        let still = json!({"asset": {"version": "2.0"}, "skins": [{"joints": [0]}], "animations": [{"name": "Idle"}]});
        let still = inspect(&build(&still)).unwrap();
        assert!(!still.playable());
        assert_eq!(still.missing_clips(), ["walk"]);
    }

    #[test]
    fn anything_but_a_whole_glb_is_refused() {
        let bytes = build(&json!({"asset": {"version": "2.0"}}));
        assert!(inspect(&bytes).is_some());
        assert!(inspect(&bytes[..bytes.len() - 1]).is_none());
        assert!(inspect(b"not a model at all").is_none());
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
        let details = details(&build_with(&json, &picture)).unwrap();
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
        let details = details(&build(&json)).unwrap();
        assert_eq!(details.size, None);
        assert_eq!(details.triangles, 0);
    }
}
