//! Validate the binary data used by a playable character, rather than trusting skin and clip labels.
use gltf_json::validation::Validate;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

use crate::gltf::{index, walk};

// Overlapping accessors, instances and reused animation samplers must not turn a small BIN into unbounded work.
const MAX_SCALAR_READS: usize = 64 * 1024 * 1024;

struct ScanBudget {
    remaining: usize,
}

impl ScanBudget {
    fn charge(&mut self, count: usize, components: usize) -> bool {
        let Some(cost) = count.checked_mul(components) else { return false };
        let Some(remaining) = self.remaining.checked_sub(cost) else { return false };
        self.remaining = remaining;
        true
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

fn primitive_valid(json: &Value, bin: &[u8], p: &Value, joints: Option<&[usize]>, budget: &mut ScanBudget) -> bool {
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
        4 if elements >= 3 && elements.is_multiple_of(3) => {}
        5 | 6 if elements >= 3 => {}
        _ => return false,
    }
    if let Some(joints) = joints {
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
        if !budget.charge(position.count, 12)
            || !(0..position.count).all(|at| {
                let sum: f64 = (0..4).map(|c| weights.value(at, c)).sum();
                sum.is_finite()
                    && sum > 0.0
                    && (0..4).all(|c| ids.value(at, c) < joints.len() as f64 && weights.value(at, c) >= 0.0)
            })
        {
            return false;
        }
    }
    true
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

pub(crate) fn character(json: &Value, bin: &[u8]) -> (bool, Vec<String>) {
    character_with_budget(json, bin, ScanBudget { remaining: MAX_SCALAR_READS })
}

fn character_with_budget(json: &Value, bin: &[u8], mut budget: ScanBudget) -> (bool, Vec<String>) {
    // Typed schema validation covers all glTF references, including morphs, materials, textures and images.
    let Ok(root) = gltf_json::Root::deserialize(json) else { return (false, vec![]) };
    let mut valid = true;
    root.validate(&root, gltf_json::Path::new, &mut |_, _| valid = false);
    if !valid {
        return (false, vec![]);
    }
    let Some(nodes) = json["nodes"].as_array() else { return (false, vec![]) };
    let mut parents: Vec<Option<usize>> = vec![None; nodes.len()];
    for (at, node) in nodes.iter().enumerate() {
        if node.get("matrix").is_some()
            && ["translation", "rotation", "scale"].iter().any(|key| node.get(key).is_some())
        {
            return (false, vec![]);
        }
        if node.get("children").is_some_and(|v| !v.is_array()) {
            return (false, vec![]);
        }
        for child in node["children"].as_array().into_iter().flatten() {
            let Some(child) = index(child).filter(|c| *c < nodes.len() && *c != at) else { return (false, vec![]) };
            if parents[child].replace(at).is_some() {
                return (false, vec![]);
            }
        }
        for (key, length) in [("matrix", 16), ("translation", 3), ("rotation", 4), ("scale", 3)] {
            if let Some(value) = node.get(key)
                && !value
                    .as_array()
                    .is_some_and(|v| v.len() == length && v.iter().all(|n| n.as_f64().is_some_and(f64::is_finite)))
            {
                return (false, vec![]);
            }
        }
        if let Some(rotation) = node["rotation"].as_array() {
            let norm = rotation.iter().map(|value| value.as_f64().unwrap().powi(2)).sum::<f64>();
            if (norm - 1.0).abs() > 0.01 {
                return (false, vec![]);
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
                1 => return (false, vec![]),
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
        let Some(scenes) = scenes.as_array() else { return (false, vec![]) };
        if json.get("scene").is_some_and(|scene| index(scene).is_none_or(|s| s >= scenes.len())) {
            return (false, vec![]);
        }
        if scenes.iter().any(|s| {
            !s["nodes"].as_array().is_some_and(|roots| {
                roots.iter().all(|r| index(r).is_some_and(|n| n < nodes.len() && parents[n].is_none()))
            })
        }) {
            return (false, vec![]);
        }
    }
    let mut active = HashSet::new();
    walk(json, |at, _, _| {
        active.insert(at);
    });
    let mut joints = HashSet::<usize>::new();
    let mut skinned = false;
    for at in &active {
        let node = &json["nodes"][*at];
        if let Some(mesh) = node.get("mesh") {
            let Some(mesh) = index(mesh).and_then(|i| json["meshes"].get(i)) else { return (false, vec![]) };
            let skin = if let Some(reference) = node.get("skin") {
                let Some(skin) = skin_joints(json, bin, reference, &active, &mut budget) else {
                    return (false, vec![]);
                };
                skinned = true;
                joints.extend(skin.iter().copied());
                Some(skin)
            } else {
                None
            };
            let Some(primitives) = mesh["primitives"].as_array().filter(|p| !p.is_empty()) else {
                return (false, vec![]);
            };
            if !primitives.iter().all(|p| primitive_valid(json, bin, p, skin.as_deref(), &mut budget)) {
                return (false, vec![]);
            }
        }
    }
    if !skinned {
        return (false, vec![]);
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
        let Some(moves_rig) = clip_valid(json, bin, animation, &joints, &mut budget) else { return (false, vec![]) };
        if moves_rig && let Some(clip) = animation["name"].as_str().and_then(crate::glb::engine_clip) {
            clips.push(clip.to_owned());
        }
    }
    clips.sort();
    clips.dedup();
    (true, clips)
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
        assert!(!character(&zero_rotation, &bin).0);
        let mut conflicting = document.clone();
        conflicting["nodes"][2]["matrix"] = matrix.clone();
        conflicting["nodes"][2]["translation"] = json!([0, 0, 0]);
        assert!(!character(&conflicting, &bin).0);
        let mut animated_matrix = document;
        let target = index(&animated_matrix["animations"][0]["channels"][0]["target"]["node"]).unwrap();
        animated_matrix["nodes"][target]["matrix"] = matrix;
        assert!(!character(&animated_matrix, &bin).0);
    }

    #[test]
    fn instances_and_reused_accessors_share_a_scan_budget() {
        let (mut document, bin) = crate::test_glb::document(&["Idle", "Walking"]);
        assert!(character_with_budget(&document, &bin, ScanBudget { remaining: 512 }).0);
        for _ in 0..20 {
            let at = document["nodes"].as_array().unwrap().len();
            document["nodes"].as_array_mut().unwrap().push(json!({"mesh": 0, "skin": 0}));
            document["scenes"][0]["nodes"].as_array_mut().unwrap().push(at.into());
        }
        assert!(character(&document, &bin).0, "ordinary instances remain supported");
        assert!(!character_with_budget(&document, &bin, ScanBudget { remaining: 512 }).0);
        assert_eq!(bin.len(), crate::test_glb::document(&["Idle", "Walking"]).1.len());
    }
}
