//! What [`glb`](crate::glb), [`slim`](crate::slim) and [`look_bake`](crate::look_bake) share about glTF JSON: indices,
//! buffer view ranges, node transforms, the default scene's node walk and the four-byte alignment of the binary chunk.

use serde_json::Value;
use std::{collections::HashSet, ops::Range};

pub(crate) fn index(value: &Value) -> Option<usize> {
    usize::try_from(value.as_u64()?).ok()
}

/// The span of the binary chunk a buffer view covers; None when its length is missing or too large.
pub(crate) fn view_range(view: &Value) -> Option<Range<usize>> {
    let start = usize::try_from(view["byteOffset"].as_u64().unwrap_or(0)).ok()?;
    Some(start..start.checked_add(usize::try_from(view["byteLength"].as_u64()?).ok()?)?)
}

/// Pads with zeros to the next four-byte boundary, where every buffer view and chunk starts.
pub(crate) fn pad(bytes: &mut Vec<u8>) {
    while !bytes.len().is_multiple_of(4) {
        bytes.push(0);
    }
}

/// Column-major 4×4, as glTF writes node matrices.
pub(crate) type Matrix = [f64; 16];
pub(crate) const IDENTITY: Matrix = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

pub(crate) fn numbers<const N: usize>(value: &Value, default: [f64; N]) -> [f64; N] {
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

/// Calls `visit` with each node's index, the node and its world matrix at rest, once per node and parents first, in the
/// default scene (the one `scene` names, else the first); without a node list in the scene, its roots are the nodes no
/// other node lists as a child.
pub(crate) fn walk(json: &Value, mut visit: impl FnMut(usize, &Value, &Matrix)) {
    let nodes = json["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let scene = &json["scenes"][json["scene"].as_u64().unwrap_or(0) as usize]["nodes"];
    let roots: Vec<usize> = match scene.as_array() {
        Some(roots) => roots.iter().filter_map(index).collect(),
        None => {
            let children: HashSet<usize> = nodes
                .iter()
                .flat_map(|node| node["children"].as_array().into_iter().flatten().filter_map(index))
                .collect();
            (0..nodes.len()).filter(|node| !children.contains(node)).collect()
        }
    };
    // A node has at most one parent, so each is visited once; a malformed cycle cannot loop.
    let mut seen = vec![false; nodes.len()];
    let mut stack: Vec<(usize, Matrix)> = roots.into_iter().map(|root| (root, IDENTITY)).collect();
    while let Some((at, parent)) = stack.pop() {
        let Some(node) = nodes.get(at).filter(|_| !std::mem::replace(&mut seen[at], true)) else { continue };
        let world = multiply(&parent, &local(node));
        visit(at, node, &world);
        stack.extend(node["children"].as_array().into_iter().flatten().filter_map(index).map(|child| (child, world)));
    }
}
