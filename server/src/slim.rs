//! Web-sized textures for models copied into the catalog. The character server bakes 2048 px maps, mostly lossless PNG:
//! about 7 MB a character and over 100 MB of GPU memory once mipmapped, for a figure the minihome camera shows a hand's
//! width tall. Colour maps shrink to 1024 px and the other maps to 512 px, and opaque maps become JPEG. Geometry, skins
//! and animations are copied byte for byte.

use image::{DynamicImage, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::Value;
use std::{collections::HashMap, io::Cursor};

use crate::{
    glb::{join, split},
    gltf::{index, pad, view_range},
};

/// Base colour and emissive maps.
const COLOR_EDGE: u32 = 1024;
/// Normal, metallic-roughness and occlusion maps.
const DETAIL_EDGE: u32 = 512;
const JPEG_QUALITY: u8 = 88;

/// The longest edge each image may keep, by what the materials sample it for; images no material uses keep theirs.
fn edges(json: &Value) -> Vec<Option<u32>> {
    let mut edges = vec![None; json["images"].as_array().map_or(0, Vec::len)];
    let source = |reference: &Value| -> Option<usize> {
        let texture = json["textures"].get(index(&reference["index"])?)?;
        index(&texture["source"])
    };
    for material in json["materials"].as_array().into_iter().flatten() {
        let pbr = &material["pbrMetallicRoughness"];
        let uses = [
            (&pbr["baseColorTexture"], COLOR_EDGE),
            (&material["emissiveTexture"], COLOR_EDGE),
            (&pbr["metallicRoughnessTexture"], DETAIL_EDGE),
            (&material["normalTexture"], DETAIL_EDGE),
            (&material["occlusionTexture"], DETAIL_EDGE),
        ];
        for (reference, edge) in uses {
            if let Some(slot) = source(reference).and_then(|image| edges.get_mut(image)) {
                *slot = Some(slot.map_or(edge, |kept: u32| kept.max(edge)));
            }
        }
    }
    edges
}

/// The picture in `bytes`, decoded only while it is at most `edge` px a side and needs at most `alloc` bytes.
pub fn decode(bytes: &[u8], format: ImageFormat, edge: u32, alloc: u64) -> Option<DynamicImage> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(edge);
    limits.max_image_height = Some(edge);
    limits.max_alloc = Some(alloc);
    reader.limits(limits);
    reader.decode().ok()
}

/// The image at most `edge` px on its longer side, as JPEG when fully opaque and PNG otherwise. None when it was not
/// shrunk and would not get smaller.
fn reencode(bytes: &[u8], mime: &str, edge: u32) -> Option<(Vec<u8>, &'static str)> {
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        _ => return None,
    };
    let image = decode(bytes, format, 8192, 512 * 1024 * 1024)?;
    let shrunk = image.width().max(image.height()) > edge;
    let image = if shrunk { image.resize(edge, edge, FilterType::Triangle) } else { image };
    let opaque = !image.color().has_alpha() || image.to_rgba8().pixels().all(|pixel| pixel[3] == u8::MAX);
    let mut out = Cursor::new(Vec::new());
    let kind = if opaque {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&image.to_rgb8()).ok()?;
        "image/jpeg"
    } else {
        image.write_to(&mut out, ImageFormat::Png).ok()?;
        "image/png"
    };
    let out = out.into_inner();
    (shrunk || out.len() < bytes.len()).then_some((out, kind))
}

/// The model with web-sized textures, or None when nothing changed or the file is not a single-buffer GLB.
pub fn slim(bytes: &[u8]) -> Option<Vec<u8>> {
    let (mut json, bin) = split(bytes)?;
    let views = json["bufferViews"].as_array()?.clone();
    if json["buffers"].as_array().map_or(0, Vec::len) != 1
        || views.iter().any(|view| view["buffer"].as_u64() != Some(0))
    {
        return None;
    }
    let edges = edges(&json);
    let mut replaced: HashMap<usize, (Vec<u8>, &'static str, usize)> = HashMap::new();
    for (at, image) in json["images"].as_array()?.iter().enumerate() {
        let (Some(edge), Some(view)) = (edges[at], index(&image["bufferView"])) else { continue };
        if replaced.contains_key(&view) {
            continue;
        }
        let original = bin.get(view_range(views.get(view)?)?)?;
        if let Some((smaller, kind)) = reencode(original, image["mimeType"].as_str().unwrap_or_default(), edge) {
            replaced.insert(view, (smaller, kind, at));
        }
    }
    if replaced.is_empty() {
        return None;
    }
    // Every view restarts on a four-byte boundary, which keeps each accessor aligned to its component size.
    let mut packed = Vec::with_capacity(bin.len());
    for (index, view) in views.iter().enumerate() {
        pad(&mut packed);
        let data = match replaced.get(&index) {
            Some((bytes, _, _)) => bytes.as_slice(),
            None => bin.get(view_range(view)?)?,
        };
        json["bufferViews"][index]["byteOffset"] = packed.len().into();
        json["bufferViews"][index]["byteLength"] = data.len().into();
        packed.extend_from_slice(data);
    }
    for (_, kind, image) in replaced.values() {
        json["images"][*image]["mimeType"] = (*kind).into();
    }
    json["buffers"][0]["byteLength"] = packed.len().into();
    Some(join(&json, &packed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use serde_json::json;

    /// Noise, so PNG cannot shrink it much; `alpha` leaves some pixels see-through.
    fn picture(edge: u32, alpha: bool) -> Vec<u8> {
        let mut seed = 0x2545_f491_u32;
        let image = RgbaImage::from_fn(edge, edge, |x, y| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let [r, g, b, _] = seed.to_le_bytes();
            Rgba([r, g, b, if alpha && (x + y).is_multiple_of(7) { 0 } else { 255 }])
        });
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// Vertex bytes, then a colour map, a see-through colour map and a normal map, each in its own view.
    fn model() -> (Vec<u8>, Vec<u8>) {
        let vertices: Vec<u8> = (0..=255).cycle().take(1002).collect();
        let parts = [vertices.clone(), picture(1200, false), picture(600, true), picture(800, false)];
        let mut bin = Vec::new();
        let mut views = Vec::new();
        for part in &parts {
            while !bin.len().is_multiple_of(4) {
                bin.push(0);
            }
            views.push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": part.len()}));
            bin.extend_from_slice(part);
        }
        let json = json!({
            "asset": {"version": "2.0"}, "buffers": [{"byteLength": bin.len()}], "bufferViews": views,
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": 83, "type": "VEC3"}],
            "images": [{"bufferView": 1, "mimeType": "image/png"}, {"bufferView": 2, "mimeType": "image/png"},
                {"bufferView": 3, "mimeType": "image/png"}],
            "textures": [{"source": 0}, {"source": 1}, {"source": 2}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "normalTexture": {"index": 2}},
                {"pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}}],
        });
        (join(&json, &bin), vertices)
    }

    fn view<'a>(json: &Value, bin: &'a [u8], index: usize) -> &'a [u8] {
        let start = json["bufferViews"][index]["byteOffset"].as_u64().unwrap() as usize;
        &bin[start..start + json["bufferViews"][index]["byteLength"].as_u64().unwrap() as usize]
    }

    #[test]
    fn maps_shrink_by_use_and_everything_else_is_copied() {
        let (original, vertices) = model();
        let slimmed = slim(&original).unwrap();
        assert!(slimmed.len() < original.len() / 2, "{} → {}", original.len(), slimmed.len());
        let (json, bin) = split(&slimmed).unwrap();
        assert_eq!(view(&json, bin, 0), vertices.as_slice());
        assert_eq!(json["buffers"][0]["byteLength"].as_u64().unwrap() as usize, bin.len());
        let kinds: Vec<&str> =
            json["images"].as_array().unwrap().iter().map(|i| i["mimeType"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["image/jpeg", "image/png", "image/jpeg"]);
        let size = |index: usize| image::load_from_memory(view(&json, bin, index)).unwrap().width();
        assert_eq!((size(1), size(2), size(3)), (1024, 600, 512));
        assert!(slim(&slimmed).is_none_or(|again| again.len() <= slimmed.len()));
    }

    #[test]
    fn files_it_cannot_repack_are_left_alone() {
        assert!(slim(b"not a model").is_none());
        let (json, bin) = split(&model().0).map(|(json, bin)| (json, bin.to_vec())).unwrap();
        let mut two_buffers = json.clone();
        two_buffers["buffers"] = json!([{"byteLength": bin.len()}, {"byteLength": 4, "uri": "extra.bin"}]);
        assert!(slim(&join(&two_buffers, &bin)).is_none());
        let bare =
            json!({"asset": {"version": "2.0"}, "images": [], "bufferViews": [], "buffers": [{"byteLength": 0}]});
        assert!(slim(&join(&bare, &[])).is_none());
    }
}
