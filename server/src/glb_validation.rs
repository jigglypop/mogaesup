//! Validate the binary data used by a playable character, rather than trusting skin and clip labels.
use gltf_json::validation::Validate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, panic::AssertUnwindSafe};

use crate::gltf::{index, walk};

// Overlapping accessors, instances and reused animation samplers must not turn a small BIN into unbounded work.
const MAX_SCALAR_READS: usize = 64 * 1024 * 1024;

/// Why a model's data cannot back a playable character.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// The glTF JSON breaks the schema or names something it does not have.
    Schema,
    /// A node's transform or its place in the tree.
    Nodes,
    /// A scene names a node that does not exist or is not a root.
    Scenes,
    /// Vertices, indices or morph targets of a mesh.
    Geometry,
    /// A skin's joints or inverse bind matrices, or the joints and weights its vertices are bound with.
    Skin,
    /// Nothing drawn is skinned.
    NoSkin,
    /// An animation's channels or samplers.
    Animation,
    /// Reading it all would take more work than any character needs.
    TooComplex,
}

impl Problem {
    /// The reason, as the import report and the wardrobe show it.
    pub fn message(self) -> &'static str {
        match self {
            Self::Schema => "glTF 구조가 규격에 맞지 않거나 없는 항목을 가리킵니다.",
            Self::Nodes => "노드의 변환(행렬·이동·회전·크기)이나 부모 관계가 올바르지 않습니다.",
            Self::Scenes => "장면이 없는 노드나 루트가 아닌 노드를 가리킵니다.",
            Self::Geometry => "메시의 정점·인덱스·모프 데이터를 읽을 수 없습니다.",
            Self::Skin => "스킨의 관절·역바인드 행렬이나 정점의 관절·가중치를 읽을 수 없습니다.",
            Self::NoSkin => "리깅(스킨)이 없습니다.",
            Self::Animation => "애니메이션의 채널이나 샘플러 데이터를 읽을 수 없습니다.",
            Self::TooComplex => "검사할 데이터가 너무 많습니다.",
        }
    }
}

struct ScanBudget {
    remaining: usize,
    /// Set once a charge did not fit: what failed then is the size, not the data.
    spent: bool,
}

impl ScanBudget {
    fn new(remaining: usize) -> Self {
        Self { remaining, spent: false }
    }

    fn charge(&mut self, count: usize, components: usize) -> bool {
        let fits = count.checked_mul(components).and_then(|cost| self.remaining.checked_sub(cost));
        match fits {
            Some(remaining) => self.remaining = remaining,
            None => self.spent = true,
        }
        fits.is_some()
    }

    /// `problem`, unless the budget ran out on the way to it.
    fn or(&self, problem: Problem) -> Problem {
        if self.spent { Problem::TooComplex } else { problem }
    }

    fn finite(&mut self, accessor: &Accessor<'_>) -> bool {
        self.charge(accessor.count, accessor.components) && accessor.finite()
    }
}

struct Accessor<'a> {
    data: &'a [u8],
    count: usize,
    stride: usize,
    width: usize,
    components: usize,
    kind: u64,
    normalized: bool,
}

impl Accessor<'_> {
    fn value(&self, at: usize, component: usize) -> f64 {
        let start = at * self.stride + component * self.width;
        let bytes = &self.data[start..start + self.width];
        let value = match self.kind {
            5121 => f64::from(bytes[0]),
            5123 => f64::from(u16::from_le_bytes(bytes.try_into().unwrap())),
            5125 => f64::from(u32::from_le_bytes(bytes.try_into().unwrap())),
            5126 => f64::from(f32::from_le_bytes(bytes.try_into().unwrap())),
            _ => unreachable!(),
        };
        if self.normalized { value / if self.kind == 5121 { 255.0 } else { 65535.0 } } else { value }
    }

    fn finite(&self) -> bool {
        (0..self.count).all(|at| (0..self.components).all(|c| self.value(at, c).is_finite()))
    }
}

fn accessor<'a>(json: &Value, bin: &'a [u8], reference: &Value) -> Option<Accessor<'a>> {
    let a = json["accessors"].get(index(reference)?)?;
    // The assembly path only supports embedded, dense accessors; it must not certify data it cannot read.
    if a.get("sparse").is_some() {
        return None;
    }
    let view = json["bufferViews"].get(index(&a["bufferView"])?)?;
    if view["buffer"].as_u64() != Some(0) || json["buffers"][0].get("uri").is_some() {
        return None;
    }
    let buffer_length = index(&json["buffers"][0]["byteLength"])?;
    if buffer_length > bin.len() || bin.len() - buffer_length > 3 {
        return None;
    }
    let kind = a["componentType"].as_u64()?;
    let width = match kind {
        5121 => 1,
        5123 => 2,
        5125 | 5126 => 4,
        _ => return None,
    };
    let components: usize = match a["type"].as_str()? {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        "MAT4" => 16,
        _ => return None,
    };
    let count = index(&a["count"])?;
    if count == 0 {
        return None;
    }
    let normalized = a["normalized"].as_bool().unwrap_or(false);
    if normalized && !matches!(kind, 5121 | 5123) {
        return None;
    }
    let offset = a.get("byteOffset").map_or(Some(0), index)?;
    let view_offset = view.get("byteOffset").map_or(Some(0), index)?;
    let view_length = index(&view["byteLength"])?;
    let element = width * components;
    let stride = view.get("byteStride").map_or(Some(element), index)?;
    if stride < element || stride % width != 0 || view_offset.checked_add(offset)? % width != 0 {
        return None;
    }
    if view.get("byteStride").is_some() && !(4..=252).contains(&stride) {
        return None;
    }
    let length = (count - 1).checked_mul(stride)?.checked_add(element)?;
    if offset.checked_add(length)? > view_length || view_offset.checked_add(view_length)? > buffer_length {
        return None;
    }
    let start = view_offset.checked_add(offset)?;
    Some(Accessor {
        data: bin.get(start..start.checked_add(length)?)?,
        count,
        stride,
        width,
        components,
        kind,
        normalized,
    })
}

fn skin_joints(
    json: &Value,
    bin: &[u8],
    reference: &Value,
    active: &HashSet<usize>,
    budget: &mut ScanBudget,
) -> Option<Vec<usize>> {
    let skin = json["skins"].get(index(reference)?)?;
    let joints: Vec<_> = skin["joints"].as_array()?.iter().map(index).collect::<Option<_>>()?;
    if joints.is_empty()
        || joints.iter().any(|j| !active.contains(j))
        || joints.iter().collect::<HashSet<_>>().len() != joints.len()
    {
        return None;
    }
    if let Some(reference) = skin.get("inverseBindMatrices") {
        let a = accessor(json, bin, reference)?;
        if a.kind != 5126 || a.components != 16 || a.count < joints.len() || !budget.finite(&a) {
            return None;
        }
    }
    Some(joints)
}

/// Whether a primitive's geometry can be read, and with `joints` its skinning: `Geometry` or `Skin` when not.
fn primitive_valid(
    json: &Value,
    bin: &[u8],
    p: &Value,
    joints: Option<&[usize]>,
    budget: &mut ScanBudget,
) -> Result<(), Problem> {
    if !geometry_valid(json, bin, p, budget) {
        return Err(budget.or(Problem::Geometry));
    }
    if let Some(joints) = joints
        && !skinning_valid(json, bin, p, joints, budget)
    {
        return Err(budget.or(Problem::Skin));
    }
    Ok(())
}

fn geometry_valid(json: &Value, bin: &[u8], p: &Value, budget: &mut ScanBudget) -> bool {
    let Some(position) = accessor(json, bin, &p["attributes"]["POSITION"]) else { return false };
    if position.components != 3 || position.kind != 5126 || position.count < 3 || !budget.finite(&position) {
        return false;
    }
    if !p["attributes"].as_object().is_some_and(|attributes| {
        attributes.values().all(|reference| {
            accessor(json, bin, reference).is_some_and(|a| a.count == position.count && budget.finite(&a))
        })
    }) {
        return false;
    }
    if let Some(targets) = p.get("targets")
        && !targets.as_array().is_some_and(|targets| {
            targets.iter().all(|target| {
                target.as_object().is_some_and(|attributes| {
                    !attributes.is_empty()
                        && attributes.iter().all(|(key, reference)| {
                            matches!(key.as_str(), "POSITION" | "NORMAL" | "TANGENT")
                                && accessor(json, bin, reference).is_some_and(|a| {
                                    a.kind == 5126
                                        && a.components == 3
                                        && a.count == position.count
                                        && budget.finite(&a)
                                })
                        })
                })
            })
        })
    {
        return false;
    }
    let elements = if let Some(reference) = p.get("indices") {
        let Some(indices) = accessor(json, bin, reference) else { return false };
        if indices.components != 1
            || !matches!(indices.kind, 5121 | 5123 | 5125)
            || indices.normalized
            || !budget.charge(indices.count, 1)
            || (0..indices.count).any(|at| indices.value(at, 0) >= position.count as f64)
        {
            return false;
        }
        indices.count
    } else {
        position.count
    };
    match p["mode"].as_u64().unwrap_or(4) {
        4 => elements >= 3 && elements.is_multiple_of(3),
        5 | 6 => elements >= 3,
        _ => false,
    }
}

/// The joints and weights of a primitive whose geometry was read: four of each per vertex, naming joints of the skin.
fn skinning_valid(json: &Value, bin: &[u8], p: &Value, joints: &[usize], budget: &mut ScanBudget) -> bool {
    let Some(vertices) = accessor(json, bin, &p["attributes"]["POSITION"]).map(|position| position.count) else {
        return false;
    };
    let Some(ids) = accessor(json, bin, &p["attributes"]["JOINTS_0"]) else { return false };
    let Some(weights) = accessor(json, bin, &p["attributes"]["WEIGHTS_0"]) else { return false };
    if ids.components != 4
        || !matches!(ids.kind, 5121 | 5123)
        || ids.normalized
        || weights.components != 4
        || !(weights.kind == 5126 || weights.normalized)
    {
        return false;
    }
    budget.charge(vertices, 12)
        && (0..vertices).all(|at| {
            let sum: f64 = (0..4).map(|c| weights.value(at, c)).sum();
            sum.is_finite()
                && sum > 0.0
                && (0..4).all(|c| ids.value(at, c) < joints.len() as f64 && weights.value(at, c) >= 0.0)
        })
}

fn clip_valid(
    json: &Value,
    bin: &[u8],
    animation: &Value,
    affected: &HashSet<usize>,
    budget: &mut ScanBudget,
) -> Option<bool> {
    let channels = animation["channels"].as_array().filter(|c| !c.is_empty())?;
    let mut moves_rig = false;
    let mut targets = HashSet::new();
    for channel in channels {
        let node = index(&channel["target"]["node"]).filter(|n| json["nodes"].get(*n).is_some())?;
        if json["nodes"][node].get("matrix").is_some() {
            return None;
        }
        let path = channel["target"]["path"].as_str()?;
        if !targets.insert((node, path)) {
            return None;
        }
        let sampler = index(&channel["sampler"]).and_then(|s| animation["samplers"].get(s))?;
        let input = accessor(json, bin, &sampler["input"])?;
        let output = accessor(json, bin, &sampler["output"])?;
        if input.kind != 5126
            || input.components != 1
            || !budget.finite(&input)
            || !budget.finite(&output)
            || output.kind != 5126
            || !budget.charge(input.count, 3)
            || (0..input.count)
                .any(|i| input.value(i, 0) < 0.0 || (i > 0 && input.value(i, 0) <= input.value(i - 1, 0)))
        {
            return None;
        }
        let factor = match sampler["interpolation"].as_str().unwrap_or("LINEAR") {
            "LINEAR" | "STEP" => 1,
            "CUBICSPLINE" => 3,
            _ => return None,
        };
        let frames = input.count.checked_mul(factor)?;
        let components = match path {
            "translation" | "scale" => 3,
            "rotation" => 4,
            "weights" => 1,
            _ => return None,
        };
        if output.components != components
            || (path != "weights" && output.count != frames)
            || (path == "weights" && !output.count.is_multiple_of(frames))
        {
            return None;
        }
        if path == "weights" {
            let primitives =
                index(&json["nodes"][node]["mesh"]).and_then(|m| json["meshes"][m]["primitives"].as_array())?;
            let morphs = primitives.first().and_then(|p| p["targets"].as_array()).map_or(0, Vec::len);
            if morphs == 0
                || primitives.iter().any(|p| p["targets"].as_array().map_or(0, Vec::len) != morphs)
                || frames.checked_mul(morphs) != Some(output.count)
            {
                return None;
            }
        }
        if path == "rotation"
            && (!budget.charge(input.count, 4)
                || (0..input.count).any(|i| {
                    let frame = i * factor + usize::from(factor == 3);
                    let norm: f64 = (0..4).map(|c| output.value(frame, c).powi(2)).sum();
                    (norm - 1.0).abs() > 0.01
                }))
        {
            return None;
        }
        moves_rig |= affected.contains(&node) && path != "weights";
    }
    Some(moves_rig)
}

/// The engine clips a playable character's data certifies, or why its data cannot back one.
pub(crate) fn character(json: &Value, bin: &[u8]) -> Result<Vec<String>, Problem> {
    character_with_budget(json, bin, ScanBudget::new(MAX_SCALAR_READS))
}

/// Typed schema validation, which covers every glTF reference, including morphs, materials, textures and images.
fn schema_valid(json: &Value) -> bool {
    let Ok(root) = gltf_json::Root::deserialize(json) else { return false };
    // gltf-json reads each primitive's POSITION accessor by index before it checks indices; one out of range would
    // panic there, so every attribute index is checked first.
    let in_range = root
        .meshes
        .iter()
        .flat_map(|mesh| &mesh.primitives)
        .all(|primitive| primitive.attributes.values().all(|accessor| accessor.value() < root.accessors.len()));
    if !in_range {
        return false;
    }
    let mut valid = true;
    let checked = std::panic::catch_unwind(AssertUnwindSafe(|| {
        root.validate(&root, gltf_json::Path::new, &mut |_, _| valid = false);
    }));
    checked.is_ok() && valid
}

fn character_with_budget(json: &Value, bin: &[u8], mut budget: ScanBudget) -> Result<Vec<String>, Problem> {
    if !schema_valid(json) {
        return Err(Problem::Schema);
    }
    let Some(nodes) = json["nodes"].as_array() else { return Err(Problem::NoSkin) };
    let mut parents: Vec<Option<usize>> = vec![None; nodes.len()];
    for (at, node) in nodes.iter().enumerate() {
        if node.get("matrix").is_some()
            && ["translation", "rotation", "scale"].iter().any(|key| node.get(key).is_some())
        {
            return Err(Problem::Nodes);
        }
        if node.get("children").is_some_and(|v| !v.is_array()) {
            return Err(Problem::Nodes);
        }
        for child in node["children"].as_array().into_iter().flatten() {
            let Some(child) = index(child).filter(|c| *c < nodes.len() && *c != at) else { return Err(Problem::Nodes) };
            if parents[child].replace(at).is_some() {
                return Err(Problem::Nodes);
            }
        }
        for (key, length) in [("matrix", 16), ("translation", 3), ("rotation", 4), ("scale", 3)] {
            if let Some(value) = node.get(key)
                && !value
                    .as_array()
                    .is_some_and(|v| v.len() == length && v.iter().all(|n| n.as_f64().is_some_and(f64::is_finite)))
            {
                return Err(Problem::Nodes);
            }
        }
        if let Some(rotation) = node["rotation"].as_array() {
            let norm = rotation.iter().map(|value| value.as_f64().unwrap().powi(2)).sum::<f64>();
            if (norm - 1.0).abs() > 0.01 {
                return Err(Problem::Nodes);
            }
        }
    }
    // glTF nodes form trees; silently cutting a cycle while walking must never certify it.
    let mut visited = vec![0u8; nodes.len()];
    for start in 0..nodes.len() {
        let mut path = Vec::new();
        let mut cursor = Some(start);
        while let Some(at) = cursor {
            match visited[at] {
                1 => return Err(Problem::Nodes),
                2 => break,
                _ => {
                    visited[at] = 1;
                    path.push(at);
                    cursor = parents[at];
                }
            }
        }
        for at in path {
            visited[at] = 2;
        }
    }
    if let Some(scenes) = json.get("scenes") {
        let Some(scenes) = scenes.as_array() else { return Err(Problem::Scenes) };
        if json.get("scene").is_some_and(|scene| index(scene).is_none_or(|s| s >= scenes.len())) {
            return Err(Problem::Scenes);
        }
        if scenes.iter().any(|s| {
            !s["nodes"].as_array().is_some_and(|roots| {
                roots.iter().all(|r| index(r).is_some_and(|n| n < nodes.len() && parents[n].is_none()))
            })
        }) {
            return Err(Problem::Scenes);
        }
    }
    let mut active = HashSet::new();
    walk(json, |at, _, _| {
        active.insert(at);
    });
    // In node order, so a model with several problems always reports the same one.
    let mut drawn: Vec<usize> = active.iter().copied().collect();
    drawn.sort_unstable();
    let mut joints = HashSet::<usize>::new();
    let mut skinned = false;
    for at in drawn {
        let node = &json["nodes"][at];
        if let Some(mesh) = node.get("mesh") {
            let Some(mesh) = index(mesh).and_then(|i| json["meshes"].get(i)) else { return Err(Problem::Geometry) };
            let skin = if let Some(reference) = node.get("skin") {
                let Some(skin) = skin_joints(json, bin, reference, &active, &mut budget) else {
                    return Err(budget.or(Problem::Skin));
                };
                skinned = true;
                joints.extend(skin.iter().copied());
                Some(skin)
            } else {
                None
            };
            let Some(primitives) = mesh["primitives"].as_array().filter(|p| !p.is_empty()) else {
                return Err(Problem::Geometry);
            };
            for primitive in primitives {
                primitive_valid(json, bin, primitive, skin.as_deref(), &mut budget)?;
            }
        }
    }
    if !skinned {
        return Err(Problem::NoSkin);
    }
    // Armature/root motion affects its descendant joints too.
    let mut pending: Vec<_> = joints.iter().copied().collect();
    while let Some(at) = pending.pop() {
        if let Some(parent) = parents[at].filter(|p| active.contains(p))
            && joints.insert(parent)
        {
            pending.push(parent);
        }
    }
    let mut clips = Vec::new();
    for animation in json["animations"].as_array().into_iter().flatten() {
        let Some(moves_rig) = clip_valid(json, bin, animation, &joints, &mut budget) else {
            return Err(budget.or(Problem::Animation));
        };
        if moves_rig && let Some(clip) = animation["name"].as_str().and_then(crate::glb::engine_clip) {
            clips.push(clip.to_owned());
        }
    }
    clips.sort();
    clips.dedup();
    Ok(clips)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn invalid_or_conflicting_node_transforms_are_not_playable() {
        let (document, bin) = crate::test_glb::document(&["Idle", "Walking"]);
        let matrix = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        let mut zero_rotation = document.clone();
        zero_rotation["nodes"][0]["rotation"] = json!([0, 0, 0, 0]);
        assert_eq!(character(&zero_rotation, &bin), Err(Problem::Nodes));
        let mut conflicting = document.clone();
        conflicting["nodes"][2]["matrix"] = matrix.clone();
        conflicting["nodes"][2]["translation"] = json!([0, 0, 0]);
        assert_eq!(character(&conflicting, &bin), Err(Problem::Nodes));
        let mut animated_matrix = document;
        let target = index(&animated_matrix["animations"][0]["channels"][0]["target"]["node"]).unwrap();
        animated_matrix["nodes"][target]["matrix"] = matrix;
        assert_eq!(character(&animated_matrix, &bin), Err(Problem::Animation));
    }

    #[test]
    fn instances_and_reused_accessors_share_a_scan_budget() {
        let (mut document, bin) = crate::test_glb::document(&["Idle", "Walking"]);
        assert!(character_with_budget(&document, &bin, ScanBudget::new(512)).is_ok());
        for _ in 0..20 {
            let at = document["nodes"].as_array().unwrap().len();
            document["nodes"].as_array_mut().unwrap().push(json!({"mesh": 0, "skin": 0}));
            document["scenes"][0]["nodes"].as_array_mut().unwrap().push(at.into());
        }
        assert!(character(&document, &bin).is_ok(), "ordinary instances remain supported");
        assert_eq!(character_with_budget(&document, &bin, ScanBudget::new(512)), Err(Problem::TooComplex));
        assert_eq!(bin.len(), crate::test_glb::document(&["Idle", "Walking"]).1.len());
    }

    #[test]
    fn indices_out_of_range_are_refused_as_schema_errors_without_a_panic() {
        let (document, bin) = crate::test_glb::document(&["Idle", "Walking"]);
        for attribute in ["POSITION", "NORMAL", "JOINTS_0"] {
            let mut broken = document.clone();
            broken["meshes"][0]["primitives"][0]["attributes"][attribute] = 999.into();
            assert_eq!(character(&broken, &bin), Err(Problem::Schema), "{attribute}");
        }
        let mut no_skin = document.clone();
        no_skin["nodes"][2].as_object_mut().unwrap().remove("skin");
        assert_eq!(character(&no_skin, &bin), Err(Problem::NoSkin));
        let mut unread_weights = document.clone();
        let weights = index(&unread_weights["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"]).unwrap();
        unread_weights["accessors"][weights]["componentType"] = 5121.into();
        assert_eq!(character(&unread_weights, &bin), Err(Problem::Skin));
    }
}
