use crate::glb;
use serde_json::{Value, json};

pub fn document(names: &[&str]) -> (Value, Vec<u8>) {
    let mut bin = Vec::new();
    let mut views = Vec::new();
    let pieces = [
        [-20.0f32, 0.0, -10.0, 20.0, 0.0, 10.0, 0.0, 170.0, 0.0]
            .iter()
            .flat_map(|n| n.to_le_bytes())
            .collect::<Vec<_>>(),
        vec![0u8; 12],
        [1.0f32, 0.0, 0.0, 0.0].repeat(3).iter().flat_map(|n| n.to_le_bytes()).collect(),
        [0.0f32, 1.0].iter().flat_map(|n| n.to_le_bytes()).collect(),
        [0.0f32, 0.0, 0.0, 1.0].repeat(2).iter().flat_map(|n| n.to_le_bytes()).collect(),
    ];
    for piece in pieces {
        views.push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": piece.len()}));
        bin.extend(piece);
    }
    let clip = |name: &&str| {
        json!({"name": name, "samplers": [{"input": 3, "output": 4}],
        "channels": [{"sampler": 0, "target": {"node": 1, "path": "rotation"}}]})
    };
    (
        json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"name": "Armature", "scale": [0.01, 0.01, 0.01], "children": [1, 2]}, {"name": "Hips"}, {"mesh": 0, "skin": 0}],
            "skins": [{"joints": [1]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}}]}],
            "buffers": [{"byteLength": bin.len()}], "bufferViews": views,
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [-20, 0, -10], "max": [20, 170, 10]},
                {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
                {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
                {"bufferView": 3, "componentType": 5126, "count": 2, "type": "SCALAR", "min": [0], "max": [1]},
                {"bufferView": 4, "componentType": 5126, "count": 2, "type": "VEC4"}],
            "animations": names.iter().map(clip).collect::<Vec<_>>(),
        }),
        bin,
    )
}

#[allow(dead_code)] // Some integration tests customize the document before joining it.
pub fn character(names: &[&str]) -> Vec<u8> {
    let (json, bin) = document(names);
    glb::join(&json, &bin)
}
