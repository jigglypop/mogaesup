//! Web-sized textures for models copied into the catalog. The character server bakes 2048 px maps, mostly lossless PNG:
//! about 7 MB a character and over 100 MB of GPU memory once mipmapped, for a figure the minihome camera shows a hand's
//! width tall. Colour maps shrink to 1024 px and the other maps to 512 px, and opaque maps become JPEG. Geometry, skins
//! and animations are copied byte for byte.

use image::{DynamicImage, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::Value;
use std::{collections::HashMap, io::Cursor};

const MAGIC: u32 = 0x4654_6c67; // "glTF"
const JSON_CHUNK: u32 = 0x4e4f_534a; // "JSON"
const BIN_CHUNK: u32 = 0x004e_4942; // "BIN\0"
/// Base colour and emissive maps.
const COLOR_EDGE: u32 = 1024;
/// Normal, metallic-roughness and occlusion maps.
const DETAIL_EDGE: u32 = 512;
const JPEG_QUALITY: u8 = 88;

fn word(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// The JSON and binary chunks of a GLB.
fn split(bytes: &[u8]) -> Option<(Value, &[u8])> {
    if word(bytes, 0)? != MAGIC || word(bytes, 8)? as usize != bytes.len() || word(bytes, 16)? != JSON_CHUNK {
        return None;
    }
    let json_end = 20 + word(bytes, 12)? as usize;
    let json = serde_json::from_slice(bytes.get(20..json_end)?).ok()?;
    if json_end == bytes.len() {
        return Some((json, &[]));
    }
    if word(bytes, json_end + 4)? != BIN_CHUNK {
        return None;
    }
    let bin_start = json_end + 8;
    Some((json, bytes.get(bin_start..bin_start + word(bytes, json_end)? as usize)?))
}

fn join(json: &Value, bin: &[u8]) -> Vec<u8> {
    let mut chunk = serde_json::to_vec(json).unwrap_or_default();
    while !chunk.len().is_multiple_of(4) {
        chunk.push(b' ');
    }
    let mut data = bin.to_vec();
    while !data.len().is_multiple_of(4) {
        data.push(0);
    }
    let total = 12 + 8 + chunk.len() + if data.is_empty() { 0 } else { 8 + data.len() };
    let mut out = Vec::with_capacity(total);
    for value in [MAGIC, 2, total as u32, chunk.len() as u32, JSON_CHUNK] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&chunk);
    if !data.is_empty() {
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&BIN_CHUNK.to_le_bytes());
        out.extend_from_slice(&data);
    }
    out
}

/// The longest edge each image may keep, by what the materials sample it for; images no material uses keep theirs.
fn edges(json: &Value) -> Vec<Option<u32>> {
    let mut edges = vec![None; json["images"].as_array().map_or(0, Vec::len)];
    let source = |reference: &Value| -> Option<usize> {
        let texture = json["textures"].get(usize::try_from(reference["index"].as_u64()?).ok()?)?;
        usize::try_from(texture["source"].as_u64()?).ok()
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

fn decode(bytes: &[u8], format: ImageFormat) -> Option<DynamicImage> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(512 * 1024 * 1024);
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
    let image = decode(bytes, format)?;
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
    if json["buffers"].as_array().map_or(0, Vec::len) != 1 || views.iter().any(|view| view["buffer"].as_u64() != Some(0)) {
        return None;
    }
    let range = |view: &Value| -> Option<std::ops::Range<usize>> {
        let start = usize::try_from(view["byteOffset"].as_u64().unwrap_or(0)).ok()?;
        Some(start..start + usize::try_from(view["byteLength"].as_u64()?).ok()?)
    };
    let edges = edges(&json);
    let mut replaced: HashMap<usize, (Vec<u8>, &'static str, usize)> = HashMap::new();
    for (index, image) in json["images"].as_array()?.iter().enumerate() {
        let (Some(edge), Some(view)) = (edges[index], image["bufferView"].as_u64().and_then(|v| usize::try_from(v).ok()))
        else {
            continue;
        };
        if replaced.contains_key(&view) {
            continue;
        }
        let original = bin.get(range(views.get(view)?)?)?;
        if let Some((smaller, kind)) = reencode(original, image["mimeType"].as_str().unwrap_or_default(), edge) {
            replaced.insert(view, (smaller, kind, index));
        }
    }
    if replaced.is_empty() {
        return None;
    }
    // Every view restarts on a four-byte boundary, which keeps each accessor aligned to its component size.
    let mut packed = Vec::with_capacity(bin.len());
    for (index, view) in views.iter().enumerate() {
        while !packed.len().is_multiple_of(4) {
            packed.push(0);
        }
        let data = match replaced.get(&index) {
            Some((bytes, _, _)) => bytes.as_slice(),
            None => bin.get(range(view)?)?,
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
        let kinds: Vec<&str> = json["images"].as_array().unwrap().iter().map(|i| i["mimeType"].as_str().unwrap()).collect();
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
        let bare = json!({"asset": {"version": "2.0"}, "images": [], "bufferViews": [], "buffers": [{"byteLength": 0}]});
        assert!(slim(&join(&bare, &[])).is_none());
    }
}
