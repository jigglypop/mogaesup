//! An island's link preview. Chat apps (KakaoTalk and the like) read Open Graph tags without running scripts, and the
//! app's index.html is one static file for every island, so `/api/share/@<username>` answers a small page of its own:
//! the island's title, its owner and status, and the picture the owner chose (a 1200×630 JPEG kept in the model store),
//! then a browser goes on to the island. An island an anonymous visitor may not see gets only the site's own title and
//! picture. The page is its own `og:url`: a crawler that reads tags from `og:url` (KakaoTalk does) stays on it, and it
//! moves on by script rather than a refresh, which crawlers follow.

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{
    AppState,
    auth::username,
    error::{ApiError, ApiResult, bad, internal},
    homes::visible_home,
};

/// The picture's size: what link previews show (1.91:1).
pub const WIDTH: u32 = 1200;
pub const HEIGHT: u32 = 630;
/// A sent picture's bytes at most, before it is decoded; the app sends a JPEG of about 600 KB at most.
pub const MAX_PICTURE_BYTES: usize = 1024 * 1024;
/// A sent picture's longest side at most, read from its header before it is decoded.
pub const MAX_EDGE: u32 = 4096;
const JPEG_QUALITY: u8 = 86;
/// What decoding a picture may hold at once: a 4096 px one with alpha takes 64 MiB.
const MAX_DECODE_BYTES: u64 = 96 * 1024 * 1024;
/// Pictures decoded at once, across the server.
static DECODING: Semaphore = Semaphore::const_new(2);
/// Pictures waiting for a decoding slot at most, each holding its request's body, and how long one waits: past either,
/// the sender is told to try again instead of the bodies piling up.
const MAX_WAITING: usize = 6;
const DECODE_WAIT: Duration = Duration::from_secs(10);
static WAITING: AtomicUsize = AtomicUsize::new(0);
/// The site's own picture (frontend/public), for the site and every island without one of its own.
pub const SITE_PICTURE: &str = "/share.jpg";
const SITE_NAME: &str = "모개숲";
/// The script that sends a browser on to the island: the page's one link. Its hash is all the page's policy allows.
const ONWARD: &str = "location.replace(document.querySelector('a').href)";
static POLICY: LazyLock<String> = LazyLock::new(|| {
    let hash = STANDARD.encode(Sha256::digest(ONWARD));
    format!(
        "default-src 'none'; script-src 'sha256-{hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
});

pub const INVALID_PICTURE: ApiError = bad("invalid_picture", "JPEG나 PNG 사진만 올릴 수 있어요.");
pub const PICTURE_TOO_LARGE: ApiError =
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "picture_too_large", "사진이 너무 커요.");
const PICTURE_BUSY: ApiError = ApiError::new(
    StatusCode::SERVICE_UNAVAILABLE,
    "picture_busy",
    "사진을 올리는 사람이 많아요. 잠시 뒤에 다시 올려 주세요.",
);

/// The page's routes. They answer HTML with headers of their own, so they stay outside the API's JSON middleware.
pub fn router(state: AppState) -> Router {
    Router::new().route("/api/share/{handle}", get(page)).with_state(state)
}

/// The picture in `data`, a `data:image/jpeg;base64,` or `data:image/png;base64,` URL, as the preview's JPEG: scaled
/// and cropped about its centre to fill [`WIDTH`]×[`HEIGHT`]. Its size is checked before anything is decoded, and the
/// work runs on a blocking thread, a few at a time.
pub async fn picture(data: String) -> ApiResult<Vec<u8>> {
    let encoded = ["data:image/jpeg;base64,", "data:image/png;base64,"]
        .iter()
        .find_map(|prefix| data.strip_prefix(prefix))
        .ok_or(INVALID_PICTURE)?;
    if encoded.len() > MAX_PICTURE_BYTES.div_ceil(3) * 4 {
        return Err(PICTURE_TOO_LARGE);
    }
    let permit = decoding_slot(DECODE_WAIT).await?;
    let start = data.len() - encoded.len();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let bytes = STANDARD.decode(&data[start..]).map_err(|_| INVALID_PICTURE)?;
        fill(&bytes)
    })
    .await
    .map_err(internal)?
}

/// One place waiting for a decoding slot, given back when dropped.
struct Waiting;

impl Waiting {
    fn take() -> Option<Self> {
        WAITING
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < MAX_WAITING).then_some(n + 1))
            .ok()
            .map(|_| Self)
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        WAITING.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A decoding slot, waited for at most `wait` and by at most [`MAX_WAITING`] pictures at once; [`PICTURE_BUSY`] past
/// either.
async fn decoding_slot(wait: Duration) -> ApiResult<SemaphorePermit<'static>> {
    if let Ok(permit) = DECODING.try_acquire() {
        return Ok(permit);
    }
    let _waiting = Waiting::take().ok_or(PICTURE_BUSY)?;
    match tokio::time::timeout(wait, DECODING.acquire()).await {
        Ok(permit) => permit.map_err(internal),
        Err(_) => Err(PICTURE_BUSY),
    }
}

/// [`picture`]'s work on the decoded bytes.
fn fill(bytes: &[u8]) -> ApiResult<Vec<u8>> {
    if bytes.len() > MAX_PICTURE_BYTES {
        return Err(PICTURE_TOO_LARGE);
    }
    let format = match image::guess_format(bytes) {
        Ok(format @ (ImageFormat::Jpeg | ImageFormat::Png)) => format,
        _ => return Err(INVALID_PICTURE),
    };
    let (width, height) =
        ImageReader::with_format(Cursor::new(bytes), format).into_dimensions().map_err(|_| INVALID_PICTURE)?;
    if width > MAX_EDGE || height > MAX_EDGE {
        return Err(PICTURE_TOO_LARGE);
    }
    let picture = crate::slim::decode(bytes, format, MAX_EDGE, MAX_DECODE_BYTES).ok_or(INVALID_PICTURE)?;
    let filled = opaque(picture).resize_to_fill(WIDTH, HEIGHT, FilterType::Triangle);
    let mut out = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&filled.to_rgb8()).map_err(internal)?;
    Ok(out.into_inner())
}

/// `picture` on white where it is see-through: a JPEG keeps no alpha, and dropping it would bare whatever colour the
/// clear pixels hold.
fn opaque(picture: DynamicImage) -> DynamicImage {
    if !picture.color().has_alpha() {
        return picture;
    }
    let mut pixels = picture.to_rgba8();
    for pixel in pixels.pixels_mut() {
        let alpha = u16::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u16::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = u8::MAX;
    }
    DynamicImage::ImageRgba8(pixels)
}

/// `text` for an HTML attribute or text node, on one line.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// What the preview says: the island, or only the site's own name and picture.
struct Preview {
    title: String,
    description: Option<String>,
    /// The picture's site path.
    picture: String,
    /// Where the page sends people, a site path.
    onward: String,
}

/// The owner's name and status message on one line.
fn description(owner: &str, status: &str) -> String {
    let status = status.split_whitespace().collect::<Vec<_>>().join(" ");
    if status.is_empty() { owner.trim().to_owned() } else { format!("{} · {status}", owner.trim()) }
}

fn html(origin: &str, own_url: &str, preview: &Preview) -> String {
    let title = escape(&preview.title);
    let picture = escape(&format!("{origin}{}", preview.picture));
    let mut head = vec![
        "<meta charset=\"utf-8\">".to_owned(),
        format!("<title>{title}</title>"),
        "<meta property=\"og:type\" content=\"website\">".to_owned(),
        format!("<meta property=\"og:site_name\" content=\"{SITE_NAME}\">"),
        format!("<meta property=\"og:title\" content=\"{title}\">"),
        format!("<meta property=\"og:url\" content=\"{}\">", escape(own_url)),
        format!("<meta property=\"og:image\" content=\"{picture}\">"),
        "<meta property=\"og:image:type\" content=\"image/jpeg\">".to_owned(),
        format!("<meta property=\"og:image:width\" content=\"{WIDTH}\">"),
        format!("<meta property=\"og:image:height\" content=\"{HEIGHT}\">"),
        "<meta name=\"twitter:card\" content=\"summary_large_image\">".to_owned(),
        format!("<meta name=\"twitter:title\" content=\"{title}\">"),
        format!("<meta name=\"twitter:image\" content=\"{picture}\">"),
    ];
    if let Some(description) = &preview.description {
        let description = escape(description);
        head.push(format!("<meta name=\"description\" content=\"{description}\">"));
        head.push(format!("<meta property=\"og:description\" content=\"{description}\">"));
        head.push(format!("<meta name=\"twitter:description\" content=\"{description}\">"));
    }
    format!(
        "<!doctype html>\n<html lang=\"ko\">\n<head>\n{}\n</head>\n<body>\n<a href=\"{}\">{title}</a>\n<script>{ONWARD}</script>\n</body>\n</html>\n",
        head.join("\n"),
        escape(&preview.onward),
    )
}

/// `GET /api/share/@{username}`: the island's link preview as a page (see the module). The same page for everyone,
/// read as an anonymous visitor, so a cache may keep it a few minutes.
async fn page(State(state): State<AppState>, Path(handle): Path<String>) -> ApiResult<Response> {
    let origin = state.config.origins.first().map(String::as_str).unwrap_or_default();
    let site =
        |onward: String| Preview { title: SITE_NAME.into(), description: None, picture: SITE_PICTURE.into(), onward };
    let Some(name) = handle.strip_prefix('@').and_then(|name| username(name).ok()) else {
        return Ok(answer(StatusCode::NOT_FOUND, html(origin, &format!("{origin}/"), &site("/".into()))));
    };
    let own_url = format!("{origin}/api/share/@{name}");
    let island = format!("/@{name}");
    let (status, preview) = match visible_home(&state, &name, None).await {
        Ok((home, _)) => (
            StatusCode::OK,
            Preview {
                title: home.title.clone(),
                description: Some(description(&home.owner_name, &home.status_message)),
                picture: home.thumbnail_url.clone().unwrap_or_else(|| SITE_PICTURE.into()),
                onward: island,
            },
        ),
        Err(error) if error.status == StatusCode::FORBIDDEN => (StatusCode::OK, site(island)),
        Err(error) if error.status == StatusCode::NOT_FOUND => (StatusCode::NOT_FOUND, site(island)),
        Err(error) => return Err(error),
    };
    Ok(answer(status, html(origin, &own_url, &preview)))
}

fn answer(status: StatusCode, body: String) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=300"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&POLICY).expect("a header value"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn encoded(picture: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        picture.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn pictures_fill_the_preview_about_their_centre() {
        // A tall picture: red above, blue below. The middle band is kept, so both colours meet at mid-height.
        let mut tall = RgbImage::from_pixel(600, 1200, Rgb([220, 30, 30]));
        for y in 600..1200 {
            for x in 0..600 {
                tall.put_pixel(x, y, Rgb([30, 30, 220]));
            }
        }
        let jpeg = fill(&encoded(DynamicImage::ImageRgb8(tall), ImageFormat::Png)).unwrap();
        assert_eq!(image::guess_format(&jpeg).unwrap(), ImageFormat::Jpeg);
        let out = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (WIDTH, HEIGHT));
        assert!(out.get_pixel(600, 10)[0] > 150, "the top of the kept band is red");
        assert!(out.get_pixel(600, HEIGHT - 10)[2] > 150, "its bottom is blue");
    }

    #[test]
    fn clear_pixels_become_white() {
        let clear = RgbaImage::from_pixel(40, 21, Rgba([0, 0, 0, 0]));
        let jpeg = fill(&encoded(DynamicImage::ImageRgba8(clear), ImageFormat::Png)).unwrap();
        let out = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert!(out.pixels().all(|pixel| pixel.0.iter().all(|channel| *channel > 240)));
    }

    #[test]
    fn only_small_enough_jpeg_and_png_pictures_are_read() {
        assert_eq!(fill(b"GIF89a....").unwrap_err().code, "invalid_picture");
        assert_eq!(fill(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap_err().code, "invalid_picture");
        let wide = encoded(DynamicImage::ImageRgb8(RgbImage::new(MAX_EDGE + 1, 2)), ImageFormat::Png);
        assert_eq!(fill(&wide).unwrap_err().code, "picture_too_large");
        assert_eq!(fill(&vec![0u8; MAX_PICTURE_BYTES + 1]).unwrap_err().code, "picture_too_large");
    }

    #[test]
    fn page_text_is_escaped_and_kept_on_one_line() {
        assert_eq!(escape(r#"<b>"섬" & 'x'</b>"#), "&lt;b&gt;&quot;섬&quot; &amp; &#39;x&#39;&lt;/b&gt;");
        assert_eq!(escape("두 줄\n상태"), "두 줄 상태");
        assert_eq!(description(" 모개 ", "  두 줄\n 상태  "), "모개 · 두 줄 상태");
        assert_eq!(description("모개", " \n "), "모개");
    }

    #[tokio::test]
    async fn pictures_wait_for_a_decoding_slot_only_so_long_and_only_so_many() {
        // Both slots busy: a picture waits its time, then is turned away.
        let held = DECODING.acquire_many(2).await.unwrap();
        let started = std::time::Instant::now();
        let error = decoding_slot(Duration::from_millis(50)).await.unwrap_err();
        assert_eq!((error.status, error.code), (StatusCode::SERVICE_UNAVAILABLE, "picture_busy"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(WAITING.load(Ordering::Acquire), 0, "the waiting place is given back");
        // Once the queue is full, the next one is turned away at once, and a slot set free goes to one waiting.
        let waiters: Vec<_> = (0..MAX_WAITING).map(|_| tokio::spawn(decoding_slot(Duration::from_secs(30)))).collect();
        while WAITING.load(Ordering::Acquire) < MAX_WAITING {
            tokio::task::yield_now().await;
        }
        let started = std::time::Instant::now();
        assert_eq!(decoding_slot(Duration::from_secs(30)).await.unwrap_err().code, "picture_busy");
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(held);
        for waiter in waiters {
            drop(waiter.await.unwrap().unwrap());
        }
        assert_eq!(WAITING.load(Ordering::Acquire), 0);
        drop(decoding_slot(Duration::from_millis(50)).await.unwrap());
    }

    #[test]
    fn the_policy_allows_the_onward_script_alone() {
        let hash = STANDARD.encode(Sha256::digest(ONWARD.as_bytes()));
        assert!(POLICY.contains(&format!("script-src 'sha256-{hash}';")));
        assert!(POLICY.starts_with("default-src 'none';"));
    }
}
