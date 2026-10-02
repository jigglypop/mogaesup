//! A member's look as one GLB: the wardrobe body with the studio parts they chose, put together the way the studio's
//! wardrobe shows them (`frontend/src/character/native-wardrobe.ts`), so the island's player, and everyone in its live
//! room, loads a single model like any 미니미.
//!
//! Each part's skinned meshes join the body and bind to the body's bones by name; a part whose bones stand elsewhere
//! than the body's is refused. What the wardrobe does in its shaders and at runtime is baked in:
//! - body triangles under the worn garments are left out, and body materials a worn slot covers are dropped;
//! - an inner garment is pressed onto the skin where the outer garments worn with it cover the body (its tuck);
//! - hair takes the chosen hair colour and garments their chosen region colours, into new colour maps;
//! - a top that reaches past the waist like a dress takes the bottom off.

use image::{ImageFormat, RgbaImage};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::Cursor,
};

use crate::{
    glb::{join, split},
    gltf::{IDENTITY, Matrix, index, pad, walk},
    slim,
};

pub const HAIR_SLOTS: [&str; 3] = ["hair", "hairFront", "hairBack"];
/// Slots whose part covers some of the body: the wardrobe reads a coverage record for each.
pub const COVERED_SLOTS: [&str; 5] = ["top", "bottom", "shoes", "hat", "hair"];
/// Worn slots that never hide body materials: hair is open between strands, and the head stays.
const SKIN_STAYS: [&str; 4] = ["hair", "head", "hairFront", "hairBack"];
/// How far a part's bone may stand from the body's at rest, in the files' units, and still be the same bone.
const REST_TOLERANCE: f64 = 1e-3;
/// Colour maps a recolour decodes: at most this long a side and this many bytes.
const MAX_EDGE: u32 = 8192;
const MAX_ALLOC: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct BakeError {
    pub code: &'static str,
    pub message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> BakeError {
    BakeError { code, message: message.into() }
}

type Bits = BTreeMap<String, Vec<u8>>;

/// What one garment covers, as the character server's wardrobe coverage record says (`avatar_wardrobe_coverage.py`).
#[derive(Debug, Clone, Default)]
pub struct Coverage {
    /// Body triangles it hides, per body `mesh:primitive`: bit t is triangle t.
    pub hidden: Bits,
    /// For a part covering the head, the head triangles hair tucks under.
    pub over: Option<Bits>,
    pub covers_bottom: bool,
    pub covers_head: bool,
    /// Per part `mesh:primitive`, the body vertex under each vertex (`anchor_keys` index << 20 | vertex, -1 for none).
    pub anchors: BTreeMap<String, Vec<i32>>,
    /// Per part `mesh:primitive`, the move (x, y, z per vertex) that presses it onto the skin.
    pub tucks: BTreeMap<String, Vec<f32>>,
    pub anchor_keys: Vec<String>,
    /// The outer slots it tucks under.
    pub under: Vec<String>,
}

fn decode_base64(value: &Value) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(value.as_str()?).ok()
}

fn bits(value: &Value) -> Option<Bits> {
    value.as_object()?.iter().map(|(key, bits)| Some((key.clone(), decode_base64(bits)?))).collect()
}

fn words<T>(value: &Value, from: fn([u8; 4]) -> T) -> Option<BTreeMap<String, Vec<T>>> {
    value
        .as_object()?
        .iter()
        .map(|(key, data)| {
            let bytes = decode_base64(data)?;
            Some((key.clone(), bytes.chunks_exact(4).map(|word| from([word[0], word[1], word[2], word[3]])).collect()))
        })
        .collect()
}

impl Coverage {
    /// The coverage JSON; None when its `hidden` is missing or any of its bitsets is not base64: a record that cannot
    /// be read says nothing about what the garment covers.
    pub fn parse(value: &Value) -> Option<Self> {
        let strings = |key: &str| -> Vec<String> {
            value[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
        };
        let tuck = (value.get("anchors"), value.get("tucks"), value["anchor_keys"].as_array());
        let (anchors, tucks) = match tuck {
            (Some(anchors), Some(tucks), Some(_)) => {
                (words(anchors, i32::from_le_bytes)?, words(tucks, f32::from_le_bytes)?)
            }
            _ => Default::default(),
        };
        let over = match value.get("over").filter(|over| !over.is_null()) {
            Some(over) => Some(bits(over)?),
            None => None,
        };
        Some(Self {
            hidden: bits(&value["hidden"])?,
            over,
            covers_bottom: value["covers_bottom"].as_bool().unwrap_or(false),
            covers_head: value["covers_head"].as_bool().unwrap_or(false),
            anchors,
            tucks,
            anchor_keys: strings("anchor_keys"),
            under: strings("under"),
        })
    }

    fn tucks(&self) -> bool {
        !self.anchors.is_empty() && !self.tucks.is_empty() && !self.anchor_keys.is_empty()
    }

    /// What an outer garment covers for an inner one to tuck under: its `over`, or its hidden triangles.
    fn covering(&self) -> &Bits {
        self.over.as_ref().unwrap_or(&self.hidden)
    }
}

/// A garment's colour regions with the colours chosen for them (`region-color.ts`).
#[derive(Debug, Clone)]
pub struct Palette {
    /// The part's glTF material whose colour map the regions follow.
    pub material: usize,
    /// Mean linear luminance of each region, in the order the character server lists them.
    pub lights: Vec<f64>,
    /// Region i in channel i (r, g, b), the fourth stored inverted in alpha; in the colour map's UV layout.
    pub mask: RgbaImage,
    /// Linear target colour per region; None keeps a region's own colour.
    pub colors: [Option<[f64; 3]>; 4],
}

/// One worn part: its slot, its GLB and what the wardrobe knows about it.
pub struct Part<'a> {
    pub slot: String,
    pub glb: &'a [u8],
    pub coverage: Option<Coverage>,
    pub palette: Option<Palette>,
}

pub struct Baked {
    pub glb: Vec<u8>,
    /// What the bake did, kept with the look.
    pub report: Value,
}

/// A `#rrggbb` colour in linear light, as three.js reads a colour string.
pub fn linear_color(hex: &str) -> Option<[f64; 3]> {
    let digits =
        hex.strip_prefix('#').filter(|digits| digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let channel =
        |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok().map(|value| to_linear(f64::from(value) / 255.0));
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn to_linear(value: f64) -> f64 {
    if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
}

fn to_srgb(value: f64) -> f64 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 }
}

const LUMINANCE: [f64; 3] = [0.2126, 0.7152, 0.0722];
fn luminance(color: [f64; 3]) -> f64 {
    color.iter().zip(LUMINANCE).map(|(channel, weight)| channel * weight).sum()
}

/// A part's hair colour: the strand luminance times the target, as `hair-color.ts` shades it.
fn hair_shade(base: [f64; 3], target: [f64; 3]) -> [f64; 3] {
    let light = luminance(base) * 2.5;
    target.map(|channel| (channel * light).clamp(0.0, 1.0))
}

/// A texel's colour with each chosen region mixed in by its mask weight, as `region-color.ts` shades it.
fn region_shade(base: [f64; 3], weights: [f64; 4], palette: &Palette) -> [f64; 3] {
    let light = luminance(base);
    let mut color = base;
    for (region, weight) in weights.into_iter().enumerate() {
        let Some(target) = palette.colors[region] else { continue };
        let reference = palette.lights.get(region).copied().unwrap_or(0.5).max(0.02);
        for (channel, value) in color.iter_mut().enumerate() {
            let shaded = (target[channel] * light / reference).clamp(0.0, 1.0);
            *value += (shaded - *value) * weight;
        }
    }
    color
}

// --- reading and writing accessors -----------------------------------------------------------------------------

fn component_size(component: u64) -> Option<usize> {
    match component {
        5120 | 5121 => Some(1),
        5122 | 5123 => Some(2),
        5125 | 5126 => Some(4),
        _ => None,
    }
}

fn components(kind: &str) -> Option<usize> {
    Some(match kind {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" | "MAT2" => 4,
        "MAT3" => 9,
        "MAT4" => 16,
        _ => return None,
    })
}

fn number(value: &Value) -> usize {
    index(value).unwrap_or(0)
}

/// Elements (vertices, indices) one accessor may hold here, and the values they flatten to. A file's counts are its own
/// word, so they are checked before anything is allocated; a character has tens of thousands of vertices.
const MAX_ELEMENTS: usize = 4_000_000;
const MAX_VALUES: usize = 3 * MAX_ELEMENTS;

/// An accessor's elements, flattened, as f64; None when it cannot be read here (sparse, too large, or outside the
/// buffer).
fn read(json: &Value, bin: &[u8], accessor: usize) -> Option<Vec<f64>> {
    let accessor = json["accessors"].get(accessor)?;
    if accessor.get("sparse").is_some() {
        return None;
    }
    let count = number(&accessor["count"]);
    let component = accessor["componentType"].as_u64()?;
    let size = component_size(component)?;
    let width = components(accessor["type"].as_str()?)?;
    if count > MAX_ELEMENTS || count * width > MAX_VALUES {
        return None;
    }
    let Some(view) = index(&accessor["bufferView"]).and_then(|view| json["bufferViews"].get(view)) else {
        return Some(vec![0.0; count * width]);
    };
    let start = number(&view["byteOffset"]).checked_add(number(&accessor["byteOffset"]))?;
    // A stride of 0 is no stride: the elements follow each other.
    let stride = match number(&view["byteStride"]) {
        0 => size * width,
        stride => stride,
    };
    // The last element ends inside the chunk, so every element before it does.
    let end = match count.checked_sub(1) {
        Some(last) => last.checked_mul(stride)?.checked_add(start)?.checked_add(size * width)?,
        None => 0,
    };
    if end > bin.len() {
        return None;
    }
    let normalized = accessor["normalized"].as_bool().unwrap_or(false);
    let mut out = Vec::with_capacity(count * width);
    for element in 0..count {
        for part in 0..width {
            let at = start + element * stride + part * size;
            let bytes = bin.get(at..at + size)?;
            let value = match component {
                5126 => f64::from(f32::from_le_bytes(bytes.try_into().ok()?)),
                5125 => f64::from(u32::from_le_bytes(bytes.try_into().ok()?)),
                5123 => f64::from(u16::from_le_bytes(bytes.try_into().ok()?)) / if normalized { 65535.0 } else { 1.0 },
                5122 => f64::from(i16::from_le_bytes(bytes.try_into().ok()?)) / if normalized { 32767.0 } else { 1.0 },
                5121 => f64::from(bytes[0]) / if normalized { 255.0 } else { 1.0 },
                _ => f64::from(bytes[0] as i8) / if normalized { 127.0 } else { 1.0 },
            };
            out.push(value);
        }
    }
    Some(out)
}

/// A primitive's triangles as vertex indices (three per triangle) and its vertex count; None unless it draws plain
/// triangles that can be read.
fn triangles(json: &Value, bin: &[u8], primitive: &Value) -> Option<(Vec<u32>, usize)> {
    if primitive["mode"].as_u64().unwrap_or(4) != 4 {
        return None;
    }
    let vertices = number(&json["accessors"].get(index(&primitive["attributes"]["POSITION"])?)?["count"]);
    if vertices > MAX_ELEMENTS {
        return None;
    }
    let indices = match index(&primitive["indices"]) {
        Some(accessor) => read(json, bin, accessor)?.into_iter().map(|value| value as u32).collect(),
        None => (0..vertices as u32).collect(),
    };
    Some((indices, vertices))
}

fn primitive_at<'a>(json: &'a Value, key: &str) -> Option<&'a Value> {
    let (mesh, primitive) = key.split_once(':')?;
    json["meshes"].get(mesh.parse::<usize>().ok()?)?["primitives"].get(primitive.parse::<usize>().ok()?)
}

fn bit(bits: &[u8], at: usize) -> bool {
    bits.get(at >> 3).is_some_and(|byte| (byte >> (at & 7)) & 1 == 1)
}

fn union(into: &mut Bits, from: &Bits) {
    for (key, bits) in from {
        let target = into.entry(key.clone()).or_default();
        if target.len() < bits.len() {
            target.resize(bits.len(), 0);
        }
        for (byte, add) in target.iter_mut().zip(bits) {
            *byte |= add;
        }
    }
}

/// The merged file being written: its JSON and binary chunk.
struct Out {
    json: Value,
    bin: Vec<u8>,
}

impl Out {
    fn list(&mut self, key: &str) -> &mut Vec<Value> {
        if !self.json[key].is_array() {
            self.json[key] = json!([]);
        }
        self.json[key].as_array_mut().expect("an array was just put there")
    }

    fn count(&self, key: &str) -> usize {
        self.json[key].as_array().map_or(0, Vec::len)
    }

    fn push(&mut self, key: &str, value: Value) -> usize {
        let list = self.list(key);
        list.push(value);
        list.len() - 1
    }

    /// The default scene's root nodes, made when the file has no scene.
    fn scene_roots(&mut self) -> &mut Vec<Value> {
        let scenes = self.list("scenes");
        if scenes.is_empty() {
            scenes.push(json!({"nodes": []}));
        }
        let count = scenes.len();
        let at = self.json["scene"].as_u64().map_or(0, |at| (at as usize).min(count - 1));
        let roots = &mut self.json["scenes"][at]["nodes"];
        if !roots.is_array() {
            *roots = json!([]);
        }
        roots.as_array_mut().expect("an array was just put there")
    }

    fn align(&mut self) {
        pad(&mut self.bin);
    }

    fn push_view(&mut self, bytes: &[u8], target: Option<u64>) -> usize {
        self.align();
        let mut view = json!({"buffer": 0, "byteOffset": self.bin.len(), "byteLength": bytes.len()});
        if let Some(target) = target {
            view["target"] = target.into();
        }
        self.bin.extend_from_slice(bytes);
        self.push("bufferViews", view)
    }

    fn push_indices(&mut self, indices: &[u32], vertices: usize) -> usize {
        let (bytes, component): (Vec<u8>, u64) = if vertices <= usize::from(u16::MAX) {
            (indices.iter().flat_map(|&i| (i as u16).to_le_bytes()).collect(), 5123)
        } else {
            (indices.iter().flat_map(|i| i.to_le_bytes()).collect(), 5125)
        };
        let view = self.push_view(&bytes, Some(34963));
        self.push(
            "accessors",
            json!({"bufferView": view, "componentType": component, "count": indices.len(), "type": "SCALAR"}),
        )
    }

    fn push_positions(&mut self, positions: &[f32]) -> usize {
        let mut low = [f32::INFINITY; 3];
        let mut high = [f32::NEG_INFINITY; 3];
        for point in positions.chunks_exact(3) {
            for axis in 0..3 {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
        }
        let bytes: Vec<u8> = positions.iter().flat_map(|v| v.to_le_bytes()).collect();
        let view = self.push_view(&bytes, Some(34962));
        self.push(
            "accessors",
            json!({"bufferView": view, "componentType": 5126, "count": positions.len() / 3, "type": "VEC3",
                "min": low, "max": high}),
        )
    }
}

fn single_buffer(json: &Value, what: impl Fn() -> BakeError) -> Result<(), BakeError> {
    let buffers = json["buffers"].as_array().map_or(0, Vec::len);
    let external = json["buffers"].as_array().into_iter().flatten().any(|buffer| buffer.get("uri").is_some());
    let views = json["bufferViews"].as_array().into_iter().flatten();
    let packed = views.clone().any(|view| view.get("extensions").is_some() || view["buffer"].as_u64() != Some(0));
    let draco = json["meshes"].as_array().into_iter().flatten().any(|mesh| {
        mesh["primitives"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["extensions"].get("KHR_draco_mesh_compression").is_some())
    });
    let outside = json["images"].as_array().into_iter().flatten().any(|image| image.get("uri").is_some());
    if buffers > 1 || external || packed || draco || outside { Err(what()) } else { Ok(()) }
}

/// Every node's world matrix at rest in the default scene (the first, or all root nodes without scenes).
fn worlds(json: &Value) -> Vec<Option<Matrix>> {
    let mut out = vec![None; json["nodes"].as_array().map_or(0, Vec::len)];
    walk(json, |at, _, world| out[at] = Some(*world));
    out
}

fn parents(json: &Value) -> HashMap<usize, usize> {
    let mut out = HashMap::new();
    for (at, node) in json["nodes"].as_array().into_iter().flatten().enumerate() {
        for child in node["children"].as_array().into_iter().flatten().filter_map(index) {
            out.insert(child, at);
        }
    }
    out
}

fn node_name(json: &Value, node: usize) -> Option<&str> {
    json["nodes"].get(node)?["name"].as_str().filter(|name| !name.is_empty())
}

/// The body's bones by name, with where each stands at rest and its parent bone's name.
struct Rig {
    bones: HashMap<String, (usize, Matrix, Option<String>)>,
    skeleton: Option<usize>,
}

fn rig(json: &Value) -> Result<Rig, BakeError> {
    let world = worlds(json);
    let parent = parents(json);
    let mut bones = HashMap::new();
    for skin in json["skins"].as_array().into_iter().flatten() {
        for joint in skin["joints"].as_array().into_iter().flatten().filter_map(index) {
            let name = node_name(json, joint).ok_or_else(|| fail("look_body", "옷장 몸의 뼈에 이름이 없습니다."))?;
            let parent_name = parent.get(&joint).and_then(|at| node_name(json, *at)).map(str::to_owned);
            let rest = world.get(joint).copied().flatten().unwrap_or(IDENTITY);
            if let Some((known, _, _)) = bones.insert(name.to_owned(), (joint, rest, parent_name))
                && known != joint
            {
                return Err(fail("look_body", "옷장 몸의 뼈 이름이 겹쳐 파츠를 붙일 수 없습니다."));
            }
        }
    }
    if bones.is_empty() {
        return Err(fail("look_body", "옷장 몸에 리깅이 없습니다."));
    }
    let skeleton = json["skins"][0].get("skeleton").and_then(index);
    Ok(Rig { bones, skeleton })
}

fn same_rest(a: &Matrix, b: &Matrix) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= REST_TOLERANCE * x.abs().max(y.abs()).max(1.0))
}

/// Body vertices under the outer garments' covered triangles, grown by one ring so the press reaches just past a hem,
/// per body `mesh:primitive` (1 = covered). Read from the body as it was loaded, before any triangle was left out. The
/// count is of the body primitives that could not be read, which leaves what tucks under them untucked.
fn covered_vertices(json: &Value, bin: &[u8], outer: &Bits) -> (HashMap<String, Vec<u8>>, usize) {
    let mut out = HashMap::new();
    let mut unread = 0;
    for (key, bits) in outer {
        let Some((indices, vertices)) = primitive_at(json, key).and_then(|primitive| triangles(json, bin, primitive))
        else {
            unread += 1;
            continue;
        };
        let mut marked = vec![0u8; vertices];
        for (triangle, corners) in indices.chunks_exact(3).enumerate() {
            if bit(bits, triangle) {
                for &corner in corners {
                    if let Some(slot) = marked.get_mut(corner as usize) {
                        *slot = 1;
                    }
                }
            }
        }
        let mut grown = marked.clone();
        for corners in indices.chunks_exact(3) {
            if corners.iter().any(|&corner| marked.get(corner as usize) == Some(&1)) {
                for &corner in corners {
                    if let Some(slot) = grown.get_mut(corner as usize) {
                        *slot = 1;
                    }
                }
            }
        }
        out.insert(key.clone(), grown);
    }
    (out, unread)
}

/// Leaves the hidden triangles out of the body's primitives; the count left out, and the number of body primitives that
/// could not be read, whose triangles stay under the garment.
fn hide_triangles(out: &mut Out, hidden: &Bits) -> (usize, usize) {
    let mut left_out = 0;
    let mut unread = 0;
    for (key, bits) in hidden {
        let Some(primitive) = primitive_at(&out.json, key).cloned() else {
            unread += 1;
            continue;
        };
        let Some((indices, vertices)) = triangles(&out.json, &out.bin, &primitive) else {
            unread += 1;
            continue;
        };
        let kept: Vec<u32> = indices
            .chunks_exact(3)
            .enumerate()
            .filter(|(triangle, _)| !bit(bits, *triangle))
            .flat_map(|(_, corners)| corners.iter().copied())
            .collect();
        if kept.len() == indices.len() {
            continue;
        }
        left_out += (indices.len() - kept.len()) / 3;
        // An accessor holds at least one element: a fully covered primitive keeps one empty triangle.
        let kept = if kept.is_empty() { vec![0, 0, 0] } else { kept };
        let accessor = out.push_indices(&kept, vertices);
        let (mesh, at) = key.split_once(':').unwrap_or_default();
        out.json["meshes"][mesh.parse::<usize>().unwrap_or(0)]["primitives"][at.parse::<usize>().unwrap_or(0)]["indices"] =
            accessor.into();
    }
    (left_out, unread)
}

/// Drops the body's primitives whose material a worn slot covers (`hidden_by_slots`); the number dropped.
fn hide_covered_materials(out: &mut Out, worn: &BTreeSet<String>) -> usize {
    let covered: HashSet<usize> = out.json["materials"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, material)| {
            let slots: Vec<String> = match &material["extras"]["hidden_by_slots"] {
                Value::String(text) => text.split('+').map(str::to_owned).collect(),
                Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                _ => Vec::new(),
            };
            slots.iter().any(|slot| !SKIN_STAYS.contains(&slot.as_str()) && worn.contains(slot))
        })
        .map(|(at, _)| at)
        .collect();
    if covered.is_empty() {
        return 0;
    }
    let mut dropped = 0;
    let mut emptied = HashSet::new();
    for (at, mesh) in items_mut(&mut out.json, "meshes").enumerate() {
        let Some(primitives) = mesh.get_mut("primitives").and_then(Value::as_array_mut) else { continue };
        let before = primitives.len();
        primitives
            .retain(|primitive| index(&primitive["material"]).is_none_or(|material| !covered.contains(&material)));
        dropped += before - primitives.len();
        if primitives.is_empty() {
            emptied.insert(at);
        }
    }
    // A node whose mesh lost every primitive draws nothing; it keeps its place in the hierarchy.
    for node in items_mut(&mut out.json, "nodes") {
        if index(&node["mesh"]).is_some_and(|mesh| emptied.contains(&mesh))
            && let Some(node) = node.as_object_mut()
        {
            node.remove("mesh");
            node.remove("skin");
            node.remove("weights");
        }
    }
    dropped
}

fn remap_texture_refs(value: &mut Value, map: &dyn Fn(usize) -> Option<usize>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key.ends_with("Texture")
                    && let Some(at) = child.get("index").and_then(index)
                    && let Some(mapped) = map(at)
                {
                    child["index"] = mapped.into();
                }
                remap_texture_refs(child, map);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| remap_texture_refs(item, map)),
        _ => {}
    }
}

fn texture_refs(value: &Value, found: &mut BTreeSet<usize>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if key.ends_with("Texture")
                    && let Some(at) = child.get("index").and_then(index)
                {
                    found.insert(at);
                }
                texture_refs(child, found);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| texture_refs(item, found)),
        _ => {}
    }
}

/// Image sources a texture names: its own and its extensions' (WebP, KTX2).
fn texture_sources(texture: &mut Value) -> Vec<&mut Value> {
    let mut out = Vec::new();
    let Some(object) = texture.as_object_mut() else { return out };
    for (key, value) in object.iter_mut() {
        if key == "source" {
            out.push(value);
        } else if key == "extensions"
            && let Some(extensions) = value.as_object_mut()
        {
            for extension in extensions.values_mut() {
                if let Some(source) = extension.get_mut("source") {
                    out.push(source);
                }
            }
        }
    }
    out
}

fn shift(value: &mut Value, by: usize) {
    if let Some(at) = index(value) {
        *value = at.saturating_add(by).into();
    }
}

/// Shifts the index at `key` when there is one; indexing a JSON object mutably would add a null for a missing key.
fn shift_key(object: &mut Value, key: &str, by: usize) {
    if let Some(value) = object.get_mut(key) {
        shift(value, by);
    }
}

/// The items of the array at `key`, without adding the key when it is missing.
fn items_mut<'a>(value: &'a mut Value, key: &str) -> std::slice::IterMut<'a, Value> {
    value.get_mut(key).and_then(Value::as_array_mut).map(|items| items.iter_mut()).unwrap_or_default()
}

/// `materials[material]`'s `pbrMetallicRoughness`, added when the material has none; None when the material is not
/// there or either is not an object (indexing such a value mutably would panic).
fn pbr_of(out: &mut Out, material: usize) -> Option<&mut Value> {
    let material = out.json.get_mut("materials")?.get_mut(material)?.as_object_mut()?;
    let pbr = material.entry("pbrMetallicRoughness").or_insert_with(|| json!({}));
    pbr.is_object().then_some(pbr)
}

/// A new colour map for `material`: each texel of its current map (or its factor, without one) through `shade`, which
/// takes the texel's linear colour times the factor and its UV. The factor turns white, since the map now holds it.
/// None when the material is not there or the map cannot be decoded here.
fn repaint(out: &mut Out, material: usize, shade: &dyn Fn([f64; 3], f64, f64) -> [f64; 3]) -> Option<()> {
    let factor = {
        let values = &out.json["materials"][material]["pbrMetallicRoughness"]["baseColorFactor"];
        let mut factor = [1.0; 4];
        for (slot, value) in factor.iter_mut().zip(values.as_array().into_iter().flatten()) {
            *slot = value.as_f64().unwrap_or(1.0);
        }
        factor
    };
    let tint = [factor[0], factor[1], factor[2]];
    let reference = out.json["materials"][material]["pbrMetallicRoughness"]["baseColorTexture"].clone();
    let Some(texture) = index(&reference["index"]) else {
        let color = shade(tint, 0.5, 0.5);
        pbr_of(out, material)?["baseColorFactor"] = json!([color[0], color[1], color[2], factor[3]]);
        return Some(());
    };
    let texture_value = out.json["textures"].get(texture)?.clone();
    let image = index(&texture_value["source"])?;
    let image_value = out.json["images"].get(image)?;
    let format = match image_value["mimeType"].as_str()? {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        _ => return None,
    };
    let view = out.json["bufferViews"].get(index(&image_value["bufferView"])?)?;
    let start = number(&view["byteOffset"]);
    let bytes = out.bin.get(start..start.checked_add(number(&view["byteLength"]))?)?;
    let mut picture = slim::decode(bytes, format, MAX_EDGE, MAX_ALLOC)?.to_rgba8();
    let (width, height) = picture.dimensions();
    let table: Vec<f64> = (0..=255).map(|value| to_linear(f64::from(value) / 255.0)).collect();
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
        let base = [0, 1, 2].map(|channel| table[usize::from(pixel[channel])] * tint[channel]);
        let color = shade(base, (f64::from(x) + 0.5) / f64::from(width), (f64::from(y) + 0.5) / f64::from(height));
        for channel in 0..3 {
            pixel[channel] = (to_srgb(color[channel]) * 255.0).round() as u8;
        }
    }
    let mut png = Cursor::new(Vec::new());
    picture.write_to(&mut png, ImageFormat::Png).ok()?;
    let view = out.push_view(&png.into_inner(), None);
    let image = out.push("images", json!({"bufferView": view, "mimeType": "image/png"}));
    let mut texture_value = texture_value;
    if let Some(texture) = texture_value.as_object_mut() {
        texture.remove("extensions");
    }
    texture_value["source"] = image.into();
    let texture = out.push("textures", texture_value);
    let pbr = pbr_of(out, material)?;
    pbr["baseColorTexture"]["index"] = texture.into();
    pbr["baseColorFactor"] = json!([1.0, 1.0, 1.0, factor[3]]);
    Some(())
}

/// Per-part numbers for the report.
#[derive(Default)]
struct Added {
    meshes: usize,
    tucked: usize,
    recolored: usize,
    unreadable_maps: usize,
    /// Primitives whose tuck was left out because their positions could not be read or did not match the record.
    skipped_tucks: usize,
}

/// Copies one part's skinned meshes into `out`, bound to the body's bones, with its tuck and colours baked in.
fn add_part(
    out: &mut Out,
    part: &Part,
    rig: &Rig,
    hair: Option<[f64; 3]>,
    covered: Option<&HashMap<String, Vec<u8>>>,
) -> Result<Added, BakeError> {
    let slot = part.slot.as_str();
    let broken = || fail("look_part", format!("{slot} 파츠 파일을 읽지 못했습니다."));
    let (json, bin) = split(part.glb).ok_or_else(broken)?;
    single_buffer(&json, broken)?;
    // A primitive names one of the part's own materials: an index past them would land on another file's after the
    // merge.
    let own_materials = json["materials"].as_array().map_or(0, Vec::len);
    let mut named = json["meshes"].as_array().into_iter().flatten().flat_map(|mesh| {
        mesh["primitives"].as_array().into_iter().flatten().filter_map(|primitive| index(&primitive["material"]))
    });
    if named.any(|material| material >= own_materials) {
        return Err(broken());
    }
    let mut added = Added::default();

    // Which of its nodes are skinned meshes, where they stand, and whether its bones are the body's.
    let world = worlds(&json);
    let parent = parents(&json);
    let skinned: Vec<usize> = json["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(at, node)| {
            node.get("mesh").is_some() && node.get("skin").is_some() && world.get(*at).is_some_and(Option::is_some)
        })
        .map(|(at, _)| at)
        .collect();
    if skinned.is_empty() {
        return Err(fail("look_part_rig", format!("{slot} 파츠에 옷장 몸의 뼈에 맞춘 메시가 없습니다.")));
    }
    let misfit = || fail("look_part_rig", format!("{slot} 파츠의 뼈 위치·구조가 옷장 몸과 맞지 않습니다."));
    let mut skins: HashMap<usize, Vec<usize>> = HashMap::new();
    for &node in &skinned {
        let skin = index(&json["nodes"][node]["skin"]).ok_or_else(misfit)?;
        if skins.contains_key(&skin) {
            continue;
        }
        let mut joints = Vec::new();
        for joint in
            json["skins"].get(skin).ok_or_else(misfit)?["joints"].as_array().into_iter().flatten().filter_map(index)
        {
            let name = node_name(&json, joint).ok_or_else(misfit)?;
            let (body_joint, rest, body_parent) = rig.bones.get(name).ok_or_else(misfit)?;
            let parent_name = parent.get(&joint).and_then(|at| node_name(&json, *at));
            let part_rest = world.get(joint).copied().flatten().ok_or_else(misfit)?;
            if parent_name != body_parent.as_deref() || !same_rest(rest, &part_rest) {
                return Err(misfit());
            }
            joints.push(*body_joint);
        }
        skins.insert(skin, joints);
    }

    // Its buffers, accessors, pictures, materials and meshes, appended after the body's.
    out.align();
    let bin_base = out.bin.len();
    out.bin.extend_from_slice(bin);
    let base = |key: &str| out.count(key);
    let (views, accessors, images, samplers, textures, materials, meshes) = (
        base("bufferViews"),
        base("accessors"),
        base("images"),
        base("samplers"),
        base("textures"),
        base("materials"),
        base("meshes"),
    );
    for mut view in json["bufferViews"].as_array().cloned().unwrap_or_default() {
        view["byteOffset"] = number(&view["byteOffset"]).saturating_add(bin_base).into();
        out.push("bufferViews", view);
    }
    for mut accessor in json["accessors"].as_array().cloned().unwrap_or_default() {
        shift_key(&mut accessor, "bufferView", views);
        if let Some(sparse) = accessor.get_mut("sparse") {
            for part in ["indices", "values"] {
                if let Some(part) = sparse.get_mut(part) {
                    shift_key(part, "bufferView", views);
                }
            }
        }
        out.push("accessors", accessor);
    }
    for mut image in json["images"].as_array().cloned().unwrap_or_default() {
        shift_key(&mut image, "bufferView", views);
        out.push("images", image);
    }
    for sampler in json["samplers"].as_array().cloned().unwrap_or_default() {
        out.push("samplers", sampler);
    }
    for mut texture in json["textures"].as_array().cloned().unwrap_or_default() {
        shift_key(&mut texture, "sampler", samplers);
        for source in texture_sources(&mut texture) {
            shift(source, images);
        }
        out.push("textures", texture);
    }
    for mut material in json["materials"].as_array().cloned().unwrap_or_default() {
        remap_texture_refs(&mut material, &|at| Some(at.saturating_add(textures)));
        out.push("materials", material);
    }
    let tuck = part.coverage.as_ref().filter(|coverage| coverage.tucks());
    for (mesh_at, mut mesh) in json["meshes"].as_array().cloned().unwrap_or_default().into_iter().enumerate() {
        for (primitive_at, primitive) in items_mut(&mut mesh, "primitives").enumerate() {
            if let Some(attributes) = primitive.get_mut("attributes").and_then(Value::as_object_mut) {
                attributes.values_mut().for_each(|value| shift(value, accessors));
            }
            shift_key(primitive, "indices", accessors);
            shift_key(primitive, "material", materials);
            for target in items_mut(primitive, "targets") {
                target.as_object_mut().into_iter().flatten().for_each(|(_, value)| shift(value, accessors));
            }
            // The tuck: vertices over covered skin move by their press.
            let (Some(tuck), Some(covered)) = (tuck, covered) else { continue };
            let key = format!("{mesh_at}:{primitive_at}");
            let (Some(anchors), Some(moves), Some(position)) =
                (tuck.anchors.get(&key), tuck.tucks.get(&key), index(&primitive["attributes"]["POSITION"]))
            else {
                continue;
            };
            let float = out.json["accessors"][position]["componentType"].as_u64() == Some(5126);
            let positions = read(&out.json, &out.bin, position).filter(|_| float);
            // A tuck that does not fit its primitive (unreadable positions, another vertex count) is left out, and
            // counted in the report.
            let count = positions.as_ref().map_or(0, |values| values.len() / 3);
            let Some(values) = positions.filter(|_| anchors.len() == count && moves.len() == count * 3) else {
                added.skipped_tucks += 1;
                continue;
            };
            let mut points: Vec<f32> = values.iter().map(|&value| value as f32).collect();
            let mut moved = 0;
            for (vertex, &anchor) in anchors.iter().enumerate() {
                let Ok(anchor) = u32::try_from(anchor) else { continue };
                let Some(body_key) = tuck.anchor_keys.get((anchor >> 20) as usize) else { continue };
                if covered.get(body_key).and_then(|marks| marks.get((anchor & 0xfffff) as usize)) != Some(&1) {
                    continue;
                }
                for axis in 0..3 {
                    points[vertex * 3 + axis] += moves[vertex * 3 + axis];
                }
                moved += 1;
            }
            if moved > 0 {
                primitive["attributes"]["POSITION"] = out.push_positions(&points).into();
                added.tucked += moved;
            }
        }
        out.push("meshes", mesh);
    }

    // Colours: hair takes the chosen hair colour; a garment its chosen region colours.
    let used: BTreeSet<usize> = skinned
        .iter()
        .filter_map(|&node| index(&json["nodes"][node]["mesh"]))
        .flat_map(|mesh| json["meshes"][mesh]["primitives"].as_array().cloned().unwrap_or_default())
        .filter_map(|primitive| index(&primitive["material"]))
        .collect();
    if let Some(target) = hair.filter(|_| HAIR_SLOTS.contains(&slot)) {
        for material in &used {
            match repaint(out, material + materials, &|base, _, _| hair_shade(base, target)) {
                Some(()) => added.recolored += 1,
                None => added.unreadable_maps += 1,
            }
        }
    }
    if let Some(palette) = part
        .palette
        .as_ref()
        .filter(|palette| palette.colors.iter().any(Option::is_some) && !HAIR_SLOTS.contains(&slot))
    {
        let (mask_width, mask_height) = palette.mask.dimensions();
        let weights = |u: f64, v: f64| -> [f64; 4] {
            let x = ((u * f64::from(mask_width)) as u32).min(mask_width.saturating_sub(1));
            let y = ((v * f64::from(mask_height)) as u32).min(mask_height.saturating_sub(1));
            let pixel = palette.mask.get_pixel(x, y);
            [
                f64::from(pixel[0]) / 255.0,
                f64::from(pixel[1]) / 255.0,
                f64::from(pixel[2]) / 255.0,
                1.0 - f64::from(pixel[3]) / 255.0,
            ]
        };
        // A material without a colour map is shaded from its flat colour, as the wardrobe's shader does.
        if palette.material < own_materials && mask_width > 0 && mask_height > 0 {
            match repaint(out, palette.material + materials, &|base, u, v| region_shade(base, weights(u, v), palette)) {
                Some(()) => added.recolored += 1,
                None => added.unreadable_maps += 1,
            }
        } else {
            added.unreadable_maps += 1;
        }
    }

    // Its skinned meshes, each where it stood in the part's file, bound to the body's bones.
    let mut new_skins: HashMap<usize, usize> = HashMap::new();
    for &node in &skinned {
        let source = &json["nodes"][node];
        let skin = index(&source["skin"]).unwrap_or(0);
        let skin_at = match new_skins.get(&skin) {
            Some(at) => *at,
            None => {
                let mut value = json!({"joints": skins[&skin]});
                if let Some(matrices) = index(&json["skins"][skin]["inverseBindMatrices"]) {
                    value["inverseBindMatrices"] = matrices.saturating_add(accessors).into();
                }
                if let Some(skeleton) = rig.skeleton {
                    value["skeleton"] = skeleton.into();
                }
                let at = out.push("skins", value);
                new_skins.insert(skin, at);
                at
            }
        };
        let mut placed = Map::new();
        placed.insert("name".into(), format!("{slot}-{}", source["name"].as_str().unwrap_or("mesh")).into());
        placed.insert("mesh".into(), index(&source["mesh"]).unwrap_or(0).saturating_add(meshes).into());
        placed.insert("skin".into(), skin_at.into());
        let matrix = world[node].unwrap_or(IDENTITY);
        if matrix != IDENTITY {
            placed.insert("matrix".into(), json!(matrix));
        }
        if let Some(weights) = source.get("weights") {
            placed.insert("weights".into(), weights.clone());
        }
        placed.insert("extras".into(), json!({"standard_slot": slot}));
        let at = out.push("nodes", Value::Object(placed));
        out.scene_roots().push(at.into());
        added.meshes += 1;
    }
    for key in ["extensionsUsed", "extensionsRequired"] {
        for extension in json[key].as_array().into_iter().flatten() {
            if !out.json[key].as_array().is_some_and(|known| known.contains(extension)) {
                out.push(key, extension.clone());
            }
        }
    }
    Ok(added)
}

fn dangling() -> BakeError {
    fail("look_part", "합친 모델이 없는 데이터를 가리켜 만들지 못했습니다.")
}

/// The entries of `all` at `used`, in order; an index past its end is a reference to nothing.
fn picked(all: &Value, used: &BTreeSet<usize>) -> Result<Vec<Value>, BakeError> {
    let all = all.as_array().map_or(&[][..], Vec::as_slice);
    used.iter().map(|at| all.get(*at).cloned().ok_or_else(dangling)).collect()
}

/// Keeps only what the file still uses: accessors, textures, images and buffer views nothing points at go, and the
/// binary chunk is packed again. A reference to something that is not there, or to bytes past the chunk, is an error:
/// the model would play with parts of it missing.
fn compact(out: &mut Out) -> Result<(), BakeError> {
    let json = &mut out.json;
    // Accessors meshes, skins and animations read.
    let mut used = BTreeSet::new();
    for mesh in json["meshes"].as_array().into_iter().flatten() {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            used.extend(primitive["attributes"].as_object().into_iter().flatten().filter_map(|(_, v)| index(v)));
            used.extend(index(&primitive["indices"]));
            for target in primitive["targets"].as_array().into_iter().flatten() {
                used.extend(target.as_object().into_iter().flatten().filter_map(|(_, v)| index(v)));
            }
        }
    }
    for skin in json["skins"].as_array().into_iter().flatten() {
        used.extend(index(&skin["inverseBindMatrices"]));
    }
    for animation in json["animations"].as_array().into_iter().flatten() {
        for sampler in animation["samplers"].as_array().into_iter().flatten() {
            used.extend(index(&sampler["input"]));
            used.extend(index(&sampler["output"]));
        }
    }
    let accessor_map: HashMap<usize, usize> = used.iter().enumerate().map(|(new, old)| (*old, new)).collect();
    let remap = |value: &mut Value| {
        if let Some(mapped) = index(value).and_then(|old| accessor_map.get(&old)) {
            *value = (*mapped).into();
        }
    };
    for mesh in items_mut(json, "meshes") {
        for primitive in items_mut(mesh, "primitives") {
            primitive
                .get_mut("attributes")
                .and_then(Value::as_object_mut)
                .into_iter()
                .flatten()
                .for_each(|(_, v)| remap(v));
            if let Some(indices) = primitive.get_mut("indices") {
                remap(indices);
            }
            for target in items_mut(primitive, "targets") {
                target.as_object_mut().into_iter().flatten().for_each(|(_, v)| remap(v));
            }
        }
    }
    for skin in items_mut(json, "skins") {
        if let Some(matrices) = skin.get_mut("inverseBindMatrices") {
            remap(matrices);
        }
    }
    for animation in items_mut(json, "animations") {
        for sampler in items_mut(animation, "samplers") {
            for key in ["input", "output"] {
                if let Some(value) = sampler.get_mut(key) {
                    remap(value);
                }
            }
        }
    }
    json["accessors"] = picked(&json["accessors"], &used)?.into();

    // Textures materials name, and the images those textures show.
    let mut textures = BTreeSet::new();
    texture_refs(&json["materials"], &mut textures);
    let texture_map: HashMap<usize, usize> = textures.iter().enumerate().map(|(new, old)| (*old, new)).collect();
    for material in items_mut(json, "materials") {
        remap_texture_refs(material, &|old| texture_map.get(&old).copied());
    }
    let mut kept_textures = picked(&json["textures"], &textures)?;
    let mut images = BTreeSet::new();
    for texture in &mut kept_textures {
        images.extend(texture_sources(texture).into_iter().filter_map(|source| index(source)));
    }
    let image_map: HashMap<usize, usize> = images.iter().enumerate().map(|(new, old)| (*old, new)).collect();
    for texture in &mut kept_textures {
        for source in texture_sources(texture) {
            if let Some(mapped) = index(source).and_then(|old| image_map.get(&old)) {
                *source = (*mapped).into();
            }
        }
    }
    json["textures"] = kept_textures.into();
    json["images"] = picked(&json["images"], &images)?.into();

    // Buffer views accessors and images still read, packed into a new binary chunk.
    let mut views = BTreeSet::new();
    for accessor in json["accessors"].as_array().into_iter().flatten() {
        views.extend(index(&accessor["bufferView"]));
        views.extend(index(&accessor["sparse"]["indices"]["bufferView"]));
        views.extend(index(&accessor["sparse"]["values"]["bufferView"]));
    }
    for image in json["images"].as_array().into_iter().flatten() {
        views.extend(index(&image["bufferView"]));
    }
    let view_map: HashMap<usize, usize> = views.iter().enumerate().map(|(new, old)| (*old, new)).collect();
    let mut bin = Vec::with_capacity(out.bin.len());
    let mut kept_views = Vec::new();
    for old in &views {
        let mut view = json["bufferViews"].get(*old).cloned().ok_or_else(dangling)?;
        let start = number(&view["byteOffset"]);
        let data = start
            .checked_add(number(&view["byteLength"]))
            .and_then(|end| out.bin.get(start..end))
            .ok_or_else(|| fail("look_part", "합친 모델의 데이터가 파일 범위를 벗어나 만들지 못했습니다."))?;
        pad(&mut bin);
        view["byteOffset"] = bin.len().into();
        bin.extend_from_slice(data);
        kept_views.push(view);
    }
    json["bufferViews"] = kept_views.into();
    let remap_view = |value: &mut Value| {
        if let Some(mapped) = index(value).and_then(|old| view_map.get(&old)) {
            *value = (*mapped).into();
        }
    };
    for accessor in items_mut(json, "accessors") {
        if let Some(view) = accessor.get_mut("bufferView") {
            remap_view(view);
        }
        if let Some(sparse) = accessor.get_mut("sparse") {
            for part in ["indices", "values"] {
                if let Some(view) = sparse.get_mut(part).and_then(|part| part.get_mut("bufferView")) {
                    remap_view(view);
                }
            }
        }
    }
    for image in items_mut(json, "images") {
        if let Some(view) = image.get_mut("bufferView") {
            remap_view(view);
        }
    }
    pad(&mut bin);
    json["buffers"] = json!([{"byteLength": bin.len()}]);
    for key in ["textures", "images", "samplers"] {
        if json[key].as_array().is_some_and(Vec::is_empty)
            && let Some(object) = json.as_object_mut()
        {
            object.remove(key);
        }
    }
    out.bin = bin;
    Ok(())
}

/// The look: `body` (the wardrobe body's GLB) wearing `parts`, with `hair` (linear) on hair parts.
pub fn bake(body: &[u8], mut parts: Vec<Part>, hair: Option<[f64; 3]>) -> Result<Baked, BakeError> {
    let (json, bin) = split(body).ok_or_else(|| fail("look_body", "옷장 몸 파일을 읽지 못했습니다."))?;
    single_buffer(&json, || fail("look_body", "옷장 몸 파일을 읽지 못했습니다."))?;
    let rig = rig(&json)?;
    let original = json.clone();
    let mut out = Out { json, bin: bin.to_vec() };

    // A dress-length top is worn without a bottom, as the wardrobe takes the bottom off.
    let dress = parts.iter().any(|part| part.slot == "top" && part.coverage.as_ref().is_some_and(|c| c.covers_bottom));
    let mut dropped = Vec::new();
    if dress {
        parts.retain(|part| {
            let bottom = part.slot == "bottom";
            if bottom {
                dropped.push("bottom");
            }
            !bottom
        });
    }
    let worn: BTreeSet<String> = parts.iter().map(|part| part.slot.clone()).collect();
    let by_slot: HashMap<&str, &Coverage> =
        parts.iter().filter_map(|part| Some((part.slot.as_str(), part.coverage.as_ref()?))).collect();

    // Where each inner garment tucks: the body the outer garments worn with it cover. Hair tucks only under a top or hat
    // that covers the head.
    let mut tucked_under: HashMap<String, HashMap<String, Vec<u8>>> = HashMap::new();
    let mut skipped_tucks = 0;
    for part in &parts {
        let Some(coverage) = part.coverage.as_ref().filter(|coverage| coverage.tucks()) else { continue };
        let mut outer = Bits::new();
        for over in &coverage.under {
            let Some(covering) = by_slot.get(over.as_str()) else { continue };
            if part.slot != "hair" || covering.covers_head {
                union(&mut outer, covering.covering());
            }
        }
        if !outer.is_empty() {
            let (covered, unread) = covered_vertices(&original, bin, &outer);
            skipped_tucks += unread;
            tucked_under.insert(part.slot.clone(), covered);
        }
    }

    let mut hidden = Bits::new();
    for coverage in by_slot.values() {
        union(&mut hidden, &coverage.hidden);
    }
    let (hidden_triangles, skipped_hides) = hide_triangles(&mut out, &hidden);
    let hidden_primitives = hide_covered_materials(&mut out, &worn);

    let mut slots = Vec::new();
    let (mut tucked, mut recolored, mut unreadable) = (0, 0, 0);
    for part in &parts {
        let added = add_part(&mut out, part, &rig, hair, tucked_under.get(&part.slot))?;
        tucked += added.tucked;
        recolored += added.recolored;
        unreadable += added.unreadable_maps;
        skipped_tucks += added.skipped_tucks;
        slots.push(json!({"slot": part.slot, "meshes": added.meshes}));
    }
    compact(&mut out)?;
    out.json["asset"]["generator"] = "mogaesup look".into();
    let report = json!({
        "parts": slots,
        "dropped": dropped,
        "hiddenTriangles": hidden_triangles,
        "hiddenPrimitives": hidden_primitives,
        "tuckedVertices": tucked,
        "recoloredMaterials": recolored,
        "unreadableMaps": unreadable,
        // What was left out because a file could not be read: body triangles that stay under a garment, tucks not made.
        "skippedHides": skipped_hides,
        "skippedTucks": skipped_tucks,
    });
    Ok(Baked { glb: join(&out.json, &out.bin), report })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::glb;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn f32s(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        RgbaImage::from_pixel(width, height, image::Rgba(color)).write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// A GLB built from JSON and a list of binary pieces; each piece becomes buffer view i, four-byte aligned.
    pub(crate) fn build(mut json: Value, pieces: &[Vec<u8>]) -> Vec<u8> {
        let mut bin = Vec::new();
        let mut views = Vec::new();
        for piece in pieces {
            while bin.len() % 4 != 0 {
                bin.push(0);
            }
            views.push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": piece.len()}));
            bin.extend_from_slice(piece);
        }
        json["bufferViews"] = views.into();
        json["buffers"] = json!([{"byteLength": bin.len()}]);
        glb::join(&json, &bin)
    }

    /// Two bones (Hips, Head under it) under a root; `slot` names the part and `extra` adds a triangle to a mesh.
    fn skeleton_nodes() -> Vec<Value> {
        vec![
            json!({"name": "Root", "children": [1]}),
            json!({"name": "Hips", "translation": [0.0, 1.0, 0.0], "children": [2]}),
            json!({"name": "Head", "translation": [0.0, 0.5, 0.0]}),
        ]
    }

    /// A body: one skinned quad (two triangles, four vertices) with a hidden-by-hat skin material on a second primitive,
    /// idle and walk clips, and a white colour map.
    pub(crate) fn body() -> Vec<u8> {
        let positions = f32s(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
        let indices: Vec<u8> = [0u16, 1, 2, 0, 2, 3].iter().flat_map(|i| i.to_le_bytes()).collect();
        let joints: Vec<u8> = [0u8, 0, 0, 0].repeat(4);
        let weights = f32s(&[1.0, 0.0, 0.0, 0.0].repeat(4));
        let inverse = f32s(&[
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., -1., 0., 1., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0.,
            1., 0., 0., -1.5, 0., 1.,
        ]);
        let times = f32s(&[0.0, 1.0]);
        let rotations = f32s(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        let mut nodes = skeleton_nodes();
        nodes[0]["children"] = json!([1, 3]);
        nodes.push(json!({"name": "Body", "mesh": 0, "skin": 0}));
        let clip = |name: &str| json!({"name": name, "samplers": [{"input": 5, "output": 6}], "channels": [{"sampler": 0, "target": {"node": 2, "path": "rotation"}}]});
        build(
            json!({
                "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
                "meshes": [{"primitives": [
                    {"attributes": {"POSITION": 0, "JOINTS_0": 2, "WEIGHTS_0": 3}, "indices": 1, "material": 0},
                    {"attributes": {"POSITION": 0, "JOINTS_0": 2, "WEIGHTS_0": 3}, "indices": 1, "material": 1}]}],
                "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}},
                    {"extras": {"hidden_by_slots": "hat+hair"}}],
                "textures": [{"source": 0}], "images": [{"bufferView": 7, "mimeType": "image/png"}],
                "skins": [{"joints": [1, 2], "inverseBindMatrices": 4, "skeleton": 0}],
                "accessors": [
                    {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
                    {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"},
                    {"bufferView": 2, "componentType": 5121, "count": 4, "type": "VEC4"},
                    {"bufferView": 3, "componentType": 5126, "count": 4, "type": "VEC4"},
                    {"bufferView": 4, "componentType": 5126, "count": 2, "type": "MAT4"},
                    {"bufferView": 5, "componentType": 5126, "count": 2, "type": "SCALAR", "min": [0], "max": [1]},
                    {"bufferView": 6, "componentType": 5126, "count": 2, "type": "VEC4"}],
                "animations": [clip("Idle"), clip("Walking")],
            }),
            &[positions, indices, joints, weights, inverse, times, rotations, png(4, 4, [255, 255, 255, 255])],
        )
    }

    /// A part skinned to the head: one triangle with a grey colour map, in `slot`. `head` moves the part's head bone.
    pub(crate) fn part(slot: &str, head: f64) -> Vec<u8> {
        let positions = f32s(&[0.0, 1.5, 0.0, 1.0, 1.5, 0.0, 0.5, 2.0, 0.0]);
        let joints: Vec<u8> = [1u8, 0, 0, 0].repeat(3);
        let weights = f32s(&[1.0, 0.0, 0.0, 0.0].repeat(3));
        let inverse = f32s(&[
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., -1., 0., 1., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0.,
            1., 0., 0., -1.5, 0., 1.,
        ]);
        let mut nodes = skeleton_nodes();
        nodes[2]["translation"] = json!([0.0, head, 0.0]);
        nodes[0]["children"] = json!([1, 3]);
        nodes.push(json!({"name": "Piece", "mesh": 0, "skin": 0, "extras": {"standard_slot": slot}}));
        build(
            json!({
                "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
                "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}, "material": 0}]}],
                "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "baseColorFactor": [0.5, 0.5, 0.5, 1.0]}}],
                "textures": [{"source": 0}], "images": [{"bufferView": 4, "mimeType": "image/png"}],
                "skins": [{"joints": [1, 2], "inverseBindMatrices": 3}],
                "accessors": [
                    {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 1.5, 0], "max": [1, 2, 0]},
                    {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
                    {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
                    {"bufferView": 3, "componentType": 5126, "count": 2, "type": "MAT4"}],
                "animations": [{"name": "Idle", "samplers": [], "channels": []}],
            }),
            &[positions, joints, weights, inverse, png(2, 2, [128, 128, 128, 255])],
        )
    }

    fn map_color(glb_bytes: &[u8], material: usize) -> [u8; 4] {
        let (json, bin) = split(glb_bytes).unwrap();
        let texture = index(&json["materials"][material]["pbrMetallicRoughness"]["baseColorTexture"]["index"]).unwrap();
        let image = &json["images"][index(&json["textures"][texture]["source"]).unwrap()];
        let view = &json["bufferViews"][index(&image["bufferView"]).unwrap()];
        let start = number(&view["byteOffset"]);
        let picture = image::load_from_memory(&bin[start..start + number(&view["byteLength"])]).unwrap().to_rgba8();
        picture.get_pixel(0, 0).0
    }

    #[test]
    fn a_hat_joins_the_body_on_its_bones_and_the_look_still_plays() {
        let baked = bake(
            &body(),
            vec![Part { slot: "hat".into(), glb: &part("hat", 0.5), coverage: None, palette: None }],
            None,
        )
        .unwrap();
        let details = glb::details(&baked.glb).unwrap();
        assert!(details.summary().playable(), "{:?}", details.clips);
        assert_eq!((details.meshes, details.animations.len()), (2, 2));
        let (json, _) = split(&baked.glb).unwrap();
        // The hat binds to the body's own Hips and Head, not to copies of them.
        let hat =
            json["nodes"].as_array().unwrap().iter().find(|node| node["extras"]["standard_slot"] == "hat").unwrap();
        assert_eq!(json["skins"][index(&hat["skin"]).unwrap()]["joints"], json!([1, 2]));
        assert_eq!(json["nodes"].as_array().unwrap().len(), 5);
        // The body material a hat hides is gone; the part's idle clip is not copied.
        assert_eq!(json["meshes"][0]["primitives"].as_array().unwrap().len(), 1);
        assert_eq!(baked.report["hiddenPrimitives"], 1);
        assert_eq!(json["images"].as_array().unwrap().len(), 2);
        assert_eq!(json["buffers"][0]["byteLength"].as_u64().unwrap() as usize, split(&baked.glb).unwrap().1.len());
        // glTF has no nulls: a missing property stays missing (three.js fails on `"targets": null`).
        fn nulls(value: &Value) -> bool {
            match value {
                Value::Null => true,
                Value::Array(items) => items.iter().any(nulls),
                Value::Object(map) => map.values().any(nulls),
                _ => false,
            }
        }
        assert!(!nulls(&json), "{json}");
    }

    #[test]
    fn a_part_on_other_bones_is_refused() {
        let error = bake(
            &body(),
            vec![Part { slot: "hat".into(), glb: &part("hat", 0.7), coverage: None, palette: None }],
            None,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "look_part_rig");
        assert!(error.message.starts_with("hat"), "{}", error.message);
        let error = bake(b"nope", Vec::new(), None).err().unwrap();
        assert_eq!(error.code, "look_body");
        let error = bake(&body(), vec![Part { slot: "top".into(), glb: b"nope", coverage: None, palette: None }], None)
            .err()
            .unwrap();
        assert_eq!(error.code, "look_part");
    }

    #[test]
    fn covered_skin_is_left_out_and_a_dress_takes_the_bottom_off() {
        // The top hides the quad's second triangle and reaches past the waist.
        let coverage = Coverage::parse(&json!({"hidden": {"0:0": b64(&[0b10])}, "covers_bottom": true})).unwrap();
        let top = part("top", 0.5);
        let bottom = part("bottom", 0.5);
        let parts = vec![
            Part { slot: "top".into(), glb: &top, coverage: Some(coverage), palette: None },
            Part { slot: "bottom".into(), glb: &bottom, coverage: None, palette: None },
        ];
        let baked = bake(&body(), parts, None).unwrap();
        assert_eq!(baked.report["dropped"], json!(["bottom"]));
        assert_eq!(baked.report["hiddenTriangles"], 1);
        let (json, bin) = split(&baked.glb).unwrap();
        let (kept, _) = triangles(&json, bin, &json["meshes"][0]["primitives"][0]).unwrap();
        assert_eq!(kept, [0, 1, 2]);
        assert!(!json["nodes"].as_array().unwrap().iter().any(|node| node["extras"]["standard_slot"] == "bottom"));
    }

    #[test]
    fn an_inner_garment_tucks_only_where_the_outer_one_covers() {
        // The top covers the body's first triangle (vertices 0, 1, 2, grown to 3 through the second). The bottom's
        // first vertex sits over body vertex 1, its second over body vertex 3, its third over nothing.
        let top = Coverage::parse(&json!({"hidden": {"0:0": b64(&[0b01])}})).unwrap();
        let anchors: Vec<u8> = [1i32, 3, -1].iter().flat_map(|a| a.to_le_bytes()).collect();
        let moves = f32s(&[0.0, 0.0, -0.1, 0.0, 0.0, -0.2, 0.0, 0.0, -0.3]);
        let bottom =
            Coverage::parse(&json!({"hidden": {}, "anchors": {"0:0": b64(&anchors)}, "tucks": {"0:0": b64(&moves)},
            "anchor_keys": ["0:0"], "under": ["top"]}))
            .unwrap();
        let (top_glb, bottom_glb) = (part("top", 0.5), part("bottom", 0.5));
        let parts = vec![
            Part { slot: "top".into(), glb: &top_glb, coverage: Some(top.clone()), palette: None },
            Part { slot: "bottom".into(), glb: &bottom_glb, coverage: Some(bottom.clone()), palette: None },
        ];
        let baked = bake(&body(), parts, None).unwrap();
        assert_eq!(baked.report["tuckedVertices"], 2);
        let (json, bin) = split(&baked.glb).unwrap();
        let node =
            json["nodes"].as_array().unwrap().iter().find(|node| node["extras"]["standard_slot"] == "bottom").unwrap();
        let primitive = &json["meshes"][index(&node["mesh"]).unwrap()]["primitives"][0];
        let points = read(&json, bin, index(&primitive["attributes"]["POSITION"]).unwrap()).unwrap();
        let z: Vec<f64> = points.chunks(3).map(|p| (p[2] * 100.0).round() / 100.0).collect();
        assert_eq!(z, [-0.1, -0.2, 0.0]);
        // Worn alone, nothing covers it, so nothing moves.
        let alone = vec![Part { slot: "bottom".into(), glb: &bottom_glb, coverage: Some(bottom), palette: None }];
        assert_eq!(bake(&body(), alone, None).unwrap().report["tuckedVertices"], 0);
    }

    #[test]
    fn hair_and_garment_colours_are_baked_into_new_maps() {
        let hair = part("hair", 0.5);
        let blue = linear_color("#2040ff").unwrap();
        let baked =
            bake(&body(), vec![Part { slot: "hair".into(), glb: &hair, coverage: None, palette: None }], Some(blue))
                .unwrap();
        assert_eq!(baked.report["recoloredMaterials"], 1);
        let (json, _) = split(&baked.glb).unwrap();
        let material = json["materials"].as_array().unwrap().len() - 1;
        let texel = map_color(&baked.glb, material);
        assert!(texel[2] > texel[0] && texel[2] > texel[1], "{texel:?}");
        assert_eq!(json["materials"][material]["pbrMetallicRoughness"]["baseColorFactor"], json!([1.0, 1.0, 1.0, 1.0]));

        // A garment's first region (red channel of the mask) turns green; the body's own map is untouched.
        let top = part("top", 0.5);
        let palette = Palette {
            material: 0,
            lights: vec![0.5, 0.5],
            mask: RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255])),
            colors: [linear_color("#00ff00"), None, None, None],
        };
        let baked =
            bake(&body(), vec![Part { slot: "top".into(), glb: &top, coverage: None, palette: Some(palette) }], None)
                .unwrap();
        let (json, _) = split(&baked.glb).unwrap();
        let texel = map_color(&baked.glb, json["materials"].as_array().unwrap().len() - 1);
        assert!(texel[1] > 100 && texel[0] < 10 && texel[2] < 10, "{texel:?}");
        assert_eq!(map_color(&baked.glb, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn colours_are_read_like_three_js() {
        let white = linear_color("#ffffff").unwrap();
        assert!(white.iter().all(|c| (c - 1.0).abs() < 1e-9));
        assert!((linear_color("#808080").unwrap()[0] - 0.2158605).abs() < 1e-6);
        assert!(linear_color("#12345").is_none() && linear_color("red").is_none());
        assert!((to_srgb(to_linear(0.3)) - 0.3).abs() < 1e-9);
    }

    /// `glb_bytes` with its JSON changed by `change`.
    fn edited(glb_bytes: &[u8], change: impl FnOnce(&mut Value)) -> Vec<u8> {
        let (mut json, bin) = split(glb_bytes).unwrap();
        change(&mut json);
        glb::join(&json, bin)
    }

    fn wear(slot: &str, glb_bytes: &[u8], hair: Option<[f64; 3]>) -> Result<Baked, BakeError> {
        let part = Part { slot: slot.into(), glb: glb_bytes, coverage: None, palette: None };
        bake(&body(), vec![part], hair)
    }

    #[test]
    fn an_accessor_is_read_only_as_far_as_the_file_really_goes() {
        let bytes = f32s(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let read_with = |count: u64, view: Value| {
            let accessor = json!({"bufferView": 0, "componentType": 5126, "type": "VEC3", "count": count});
            read(&json!({"accessors": [accessor], "bufferViews": [view]}), &bytes, 0)
        };
        let all = Some(vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(read_with(2, json!({"byteLength": 24})), all);
        // A stride of zero is no stride at all: the elements follow each other.
        assert_eq!(read_with(2, json!({"byteLength": 24, "byteStride": 0})), all);
        assert_eq!(read_with(1, json!({"byteLength": 24, "byteOffset": 12})), Some(vec![4.0, 5.0, 6.0]));
        // What the file only claims: more elements than bytes, a stride that runs past the end, offsets that wrap.
        assert_eq!(read_with(3, json!({"byteLength": 24})), None);
        assert_eq!(read_with(2, json!({"byteLength": 24, "byteStride": 16})), None);
        assert_eq!(read_with(1, json!({"byteLength": 24, "byteOffset": u64::MAX})), None);
        // Counts no character has, with a stride of zero that would never leave the first element: refused before any
        // element is read or anything allocated.
        for count in [MAX_ELEMENTS as u64 + 1, 4_000_000_000, u64::MAX] {
            assert_eq!(read_with(count, json!({"byteLength": 24, "byteStride": 0})), None, "{count}");
        }
        let without_view =
            |count: u64| read(&json!({"accessors": [{"componentType": 5126, "type": "VEC3", "count": count}]}), &[], 0);
        assert_eq!(without_view(2), Some(vec![0.0; 6]));
        assert_eq!(without_view(MAX_ELEMENTS as u64 + 1), None);
        assert_eq!(without_view(u64::MAX), None);
        let sparse =
            json!({"accessors": [{"componentType": 5126, "type": "VEC3", "count": 1, "sparse": {"count": 1}}]});
        assert_eq!(read(&sparse, &bytes, 0), None);
    }

    #[test]
    fn a_primitive_has_no_more_vertices_than_a_character_can() {
        let primitive = json!({"attributes": {"POSITION": 0}});
        let huge = json!({"accessors": [{"componentType": 5126, "type": "VEC3", "count": 4_000_000_000u64}]});
        assert!(triangles(&huge, &[], &primitive).is_none());
        let outer = Bits::from([("0:0".to_owned(), vec![1u8])]);
        let huge_body = json!({"accessors": [{"count": 4_000_000_000u64}],
            "meshes": [{"primitives": [primitive.clone()]}]});
        let (covered, unread) = covered_vertices(&huge_body, &[], &outer);
        assert_eq!((covered.len(), unread), (0, 1));
        let three = json!({"accessors": [{"componentType": 5126, "type": "VEC3", "count": 3}]});
        assert_eq!(triangles(&three, &[], &primitive), Some((vec![0, 1, 2], 3)));
    }

    #[test]
    fn a_part_pointing_outside_itself_is_refused_without_a_panic() {
        let hat = part("hat", 0.5);
        let refused = |glb_bytes: Vec<u8>, hair: Option<[f64; 3]>| {
            let error = wear("hat", &glb_bytes, hair).err().unwrap();
            assert_eq!(error.code, "look_part", "{}", error.message);
        };
        // A material past the part's own, with and without hair to recolour it.
        let stray =
            |material: u64| edited(&hat, |json| json["meshes"][0]["primitives"][0]["material"] = material.into());
        refused(stray(7), None);
        refused(stray(u64::MAX), linear_color("#2040ff"));
        // Bytes past the binary chunk, offsets that wrap, buffer views and accessors that are not there.
        refused(edited(&hat, |json| json["bufferViews"][0]["byteLength"] = 1_000_000.into()), None);
        refused(edited(&hat, |json| json["bufferViews"][0]["byteOffset"] = u64::MAX.into()), None);
        refused(edited(&hat, |json| json["accessors"][1]["bufferView"] = 99.into()), None);
        refused(edited(&hat, |json| json["meshes"][0]["primitives"][0]["attributes"]["POSITION"] = 50.into()), None);
        refused(
            edited(&hat, |json| json["meshes"][0]["primitives"][0]["attributes"]["POSITION"] = u64::MAX.into()),
            None,
        );
        assert!(wear("hat", &hat, None).is_ok());
    }

    #[test]
    fn a_material_that_cannot_be_painted_is_counted_not_trusted() {
        let hair = part("hair", 0.5);
        let blue = linear_color("#2040ff");
        // Not an object: nothing to recolour, and no panic reaching for its colour.
        let odd = edited(&hair, |json| json["materials"] = json!([5]));
        assert_eq!(wear("hair", &odd, blue).unwrap().report["unreadableMaps"], 1);
        let flat = edited(&hair, |json| json["materials"] = json!([{"pbrMetallicRoughness": 5}]));
        assert_eq!(wear("hair", &flat, blue).unwrap().report["unreadableMaps"], 1);
        // A colour set for a material the part does not have is counted too.
        let top = part("top", 0.5);
        let palette = |material: usize| Palette {
            material,
            lights: vec![0.5],
            mask: RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255])),
            colors: [linear_color("#00ff00"), None, None, None],
        };
        let worn = |material: usize| {
            let part = Part { slot: "top".into(), glb: &top, coverage: None, palette: Some(palette(material)) };
            bake(&body(), vec![part], None).unwrap().report
        };
        assert_eq!((worn(0)["recoloredMaterials"].clone(), worn(0)["unreadableMaps"].clone()), (json!(1), json!(0)));
        assert_eq!((worn(5)["recoloredMaterials"].clone(), worn(5)["unreadableMaps"].clone()), (json!(0), json!(1)));
    }

    #[test]
    fn what_is_left_out_because_a_file_cannot_be_read_is_counted_in_the_report() {
        let top_glb = part("top", 0.5);
        let bottom_glb = part("bottom", 0.5);
        let top = Coverage::parse(&json!({"hidden": {"0:0": b64(&[0b01])}})).unwrap();
        let bottom_with = |anchors: &[i32], moves: &[f32]| {
            let anchors: Vec<u8> = anchors.iter().flat_map(|a| a.to_le_bytes()).collect();
            Coverage::parse(
                &json!({"hidden": {}, "anchors": {"0:0": b64(&anchors)}, "tucks": {"0:0": b64(&f32s(moves))},
                "anchor_keys": ["0:0"], "under": ["top"]}),
            )
            .unwrap()
        };
        let worn = |top: Coverage, bottom: Coverage, bottom_glb: &[u8]| {
            let parts = vec![
                Part { slot: "top".into(), glb: &top_glb, coverage: Some(top), palette: None },
                Part { slot: "bottom".into(), glb: bottom_glb, coverage: Some(bottom), palette: None },
            ];
            bake(&body(), parts, None).unwrap().report
        };
        // A tuck for three vertices fits the part's three; one for two does not and is left out.
        let fits = worn(top.clone(), bottom_with(&[1, 3, -1], &[0.0; 9]), &bottom_glb);
        assert_eq!((fits["skippedTucks"].clone(), fits["tuckedVertices"].clone()), (json!(0), json!(2)));
        let short = worn(top.clone(), bottom_with(&[1, 3], &[0.0; 6]), &bottom_glb);
        assert_eq!((short["skippedTucks"].clone(), short["tuckedVertices"].clone()), (json!(1), json!(0)));
        // Positions that cannot be read (a sparse accessor) leave the tuck out as well.
        let sparse = edited(&bottom_glb, |json| json["accessors"][0]["sparse"] = json!({"count": 1}));
        let unread = worn(top.clone(), bottom_with(&[1, 3, -1], &[0.0; 9]), &sparse);
        assert_eq!((unread["skippedTucks"].clone(), unread["tuckedVertices"].clone()), (json!(1), json!(0)));
        // Coverage of a body primitive the body does not have hides nothing, and says so.
        let elsewhere = Coverage::parse(&json!({"hidden": {"3:0": b64(&[1])}})).unwrap();
        let part = Part { slot: "top".into(), glb: &top_glb, coverage: Some(elsewhere), palette: None };
        let report = bake(&body(), vec![part], None).unwrap().report;
        assert_eq!((report["skippedHides"].clone(), report["hiddenTriangles"].clone()), (json!(1), json!(0)));
    }

    #[test]
    fn a_coverage_record_that_cannot_be_read_is_not_taken_for_an_empty_one() {
        assert!(Coverage::parse(&json!({"hidden": {"0:0": b64(&[1])}, "covers_bottom": false})).is_some());
        assert!(Coverage::parse(&json!({"hidden": {}, "over": null})).is_some());
        for broken in [
            json!({"hidden": {"0:0": "not base64!"}}),
            json!({"hidden": {"0:0": 7}}),
            json!({"hidden": "x"}),
            json!({"covers_bottom": false}),
            json!({"hidden": {}, "over": {"0:0": "not base64!"}}),
            json!({"hidden": {}, "anchors": {"0:0": "!"}, "tucks": {}, "anchor_keys": []}),
        ] {
            assert!(Coverage::parse(&broken).is_none(), "{broken}");
        }
    }
}
