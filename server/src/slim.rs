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
/// Repacking overlapping source views must never grow an accepted download without a fixed bound.
const MAX_PACKED_BYTES: usize = 64 * 1024 * 1024;

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
    let image = decode(bytes, format, 4096, 64 * 1024 * 1024)?;
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
    if bytes.len() > MAX_PACKED_BYTES {
        return None;
    }
    let (mut json, bin) = split(bytes)?;
    let views = json["bufferViews"].as_array()?.clone();
    // The buffer must be an object: its byteLength is written below.
    if json["buffers"].as_array().map_or(0, Vec::len) != 1
        || !json["buffers"][0].is_object()
        || views.iter().any(|view| view["buffer"].as_u64() != Some(0))
    {
        return None;
    }
    let ranges: Vec<(usize, usize)> = views
        .iter()
        .map(|view| {
            let range = view_range(view)?;
            bin.get(range.clone())?;
            Some((range.start, range.end))
        })
        .collect::<Option<_>>()?;
    let edges = edges(&json);
    // Image entries and even distinct buffer views may share the same source bytes. Choose the largest requested
    // size before decoding, so a normal map cannot accidentally shrink a colour map which aliases it.
    let mut uses: HashMap<(usize, usize), (u32, &str)> = HashMap::new();
    for (at, image) in json["images"].as_array()?.iter().enumerate() {
        let (Some(edge), Some(view)) = (edges[at], index(&image["bufferView"])) else { continue };
        let range = *ranges.get(view)?;
        let mime = image["mimeType"].as_str().unwrap_or_default();
        let (kept, prior_mime) = uses.entry(range).or_insert((edge, mime));
        if *prior_mime != mime {
            return None;
        }
        *kept = (*kept).max(edge);
    }
    let mut replaced: HashMap<(usize, usize), (Vec<u8>, &'static str)> = HashMap::new();
    let mut replacement_bytes = 0usize;
    for (&(start, end), &(edge, mime)) in &uses {
        if let Some((smaller, kind)) = reencode(&bin[start..end], mime, edge) {
            replacement_bytes = replacement_bytes.checked_add(smaller.len())?;
            if replacement_bytes > MAX_PACKED_BYTES {
                return None;
            }
            replaced.insert((start, end), (smaller, kind));
        }
    }
    if replaced.is_empty() {
        return None;
    }
    // Plan the complete allocation before copying. Exact source aliases share an output offset; partially
    // overlapping views stay independent but their aggregate size has to fit the same download budget.
    let mut offsets = HashMap::new();
    let mut length = 0usize;
    for &(start, end) in &ranges {
        if offsets.contains_key(&(start, end)) {
            continue;
        }
        let offset = length.checked_add(3)? & !3;
        let data_length = replaced.get(&(start, end)).map_or(end - start, |(data, _)| data.len());
        length = offset.checked_add(data_length)?;
        if length > MAX_PACKED_BYTES {
            return None;
        }
        offsets.insert((start, end), offset);
    }
    let mut packed = Vec::with_capacity(length);
    for (index, &(start, end)) in ranges.iter().enumerate() {
        let offset = offsets[&(start, end)];
        let data = match replaced.get(&(start, end)) {
            Some((bytes, _)) => bytes.as_slice(),
            None => &bin[start..end],
        };
        if offset >= packed.len() {
            pad(&mut packed);
            packed.extend_from_slice(data);
        }
        json["bufferViews"][index]["byteOffset"] = offset.into();
        json["bufferViews"][index]["byteLength"] = data.len().into();
    }
    for image in json["images"].as_array_mut()? {
        if let Some((_, kind)) =
            index(&image["bufferView"]).and_then(|view| ranges.get(view)).and_then(|range| replaced.get(range))
        {
            image["mimeType"] = (*kind).into();
        }
    }
    json["buffers"][0]["byteLength"] = packed.len().into();
    // Include JSON, chunk headers and padding in the final file limit as well.
    let json_bytes = serde_json::to_vec(&json).ok()?.len().checked_add(3)? & !3;
    let bin_bytes = packed.len().checked_add(3)? & !3;
    if 28usize.checked_add(json_bytes)?.checked_add(bin_bytes)? > MAX_PACKED_BYTES {
        return None;
    }
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
    fn shared_images_keep_the_largest_use_and_all_mime_types_follow_the_bytes() {
        let bin = picture(1200, false);
        let range = json!({"buffer": 0, "byteLength": bin.len()});
        let json = json!({
            "asset": {"version": "2.0"}, "buffers": [{"byteLength": bin.len()}],
            "bufferViews": [range.clone(), range],
            "images": [{"bufferView": 0, "mimeType": "image/png"},
                {"bufferView": 0, "mimeType": "image/png"}, {"bufferView": 1, "mimeType": "image/png"}],
            "textures": [{"source": 0}, {"source": 1}],
            "materials": [{"normalTexture": {"index": 0},
                "pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}}],
        });
        let slimmed = slim(&join(&json, &bin)).unwrap();
        let (json, bin) = split(&slimmed).unwrap();
        assert_eq!(json["bufferViews"][0]["byteOffset"], json["bufferViews"][1]["byteOffset"]);
        for image in json["images"].as_array().unwrap() {
            assert_eq!(image["mimeType"], "image/jpeg");
            let bytes = view(&json, bin, index(&image["bufferView"]).unwrap());
            assert_eq!(image::guess_format(bytes).unwrap(), ImageFormat::Jpeg);
            assert_eq!(image::load_from_memory(bytes).unwrap().width(), 1024);
        }
        assert_eq!(bin.len(), view(&json, bin, 0).len().next_multiple_of(4));
    }

    #[test]
    fn duplicate_source_ranges_are_stored_once_instead_of_expanding_the_model() {
        let geometry = vec![0xa5; 1024 * 1024];
        let picture = picture(64, false);
        let mut bin = geometry.clone();
        bin.extend_from_slice(&picture);
        let mut views = vec![json!({"buffer": 0, "byteLength": geometry.len()}); 100];
        views.push(json!({"buffer": 0, "byteOffset": geometry.len(), "byteLength": picture.len()}));
        let json = json!({
            "asset": {"version": "2.0"}, "buffers": [{"byteLength": bin.len()}], "bufferViews": views,
            "images": [{"bufferView": 100, "mimeType": "image/png"}], "textures": [{"source": 0}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
        });
        let original = join(&json, &bin);
        let slimmed = slim(&original).unwrap();
        assert!(slimmed.len() < original.len());
        let (json, bin) = split(&slimmed).unwrap();
        for at in 0..100 {
            assert_eq!(json["bufferViews"][at]["byteOffset"], 0);
            assert_eq!(view(&json, bin, at), geometry.as_slice());
        }
    }

    #[test]
    fn partially_overlapping_views_cannot_expand_beyond_the_download_budget() {
        let geometry_bytes = 8 * 1024 * 1024;
        let picture = picture(64, false);
        let mut bin = vec![0; geometry_bytes];
        bin.extend_from_slice(&picture);
        let mut views: Vec<_> = (0..16)
            .map(|at| json!({"buffer": 0, "byteOffset": at * 4, "byteLength": geometry_bytes - at * 4}))
            .collect();
        views.push(json!({"buffer": 0, "byteOffset": geometry_bytes, "byteLength": picture.len()}));
        let json = json!({
            "asset": {"version": "2.0"}, "buffers": [{"byteLength": bin.len()}], "bufferViews": views,
            "images": [{"bufferView": 16, "mimeType": "image/png"}], "textures": [{"source": 0}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
        });
        let original = join(&json, &bin);
        assert!(original.len() < MAX_PACKED_BYTES);
        assert!(slim(&original).is_none(), "leave the bounded original intact before allocating an expanded BIN");
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
        // A buffer that is not an object is left alone rather than written into.
        let mut odd = json.clone();
        odd["buffers"] = json!([bin.len()]);
        assert!(slim(&join(&odd, &bin)).is_none());
    }
}
