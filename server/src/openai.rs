//! The OpenAI API as this server calls it: the Responses API writes a 사주 home's reading and `/images/edits` draws its
//! island again (`saju_made`). What a call came to is kept only as a code of this server's own ([`Failure`]), never as
//! the provider's words. The key travels in each request's header and nowhere else, and no request or answer body is
//! logged.

use axum::http::header::CONTENT_TYPE;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use uuid::Uuid;

use crate::config::OpenAi;

/// The largest answer read: a reading is some tens of kilobytes, a picture a few megabytes of base64.
const MAX_ANSWER_BYTES: usize = 40 * 1024 * 1024;
/// Error codes and types the API answers a request its safety systems block with.
const BLOCKED: [&str; 4] = ["moderation_blocked", "content_policy_violation", "content_filter", "safety"];

/// Why a call made nothing; [`Failure::code`] is what a failed reading or picture says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// No answer in time.
    Timeout,
    /// The model declined, or a safety system blocked the request or its answer.
    Refused,
    /// The answer stopped before its end: its output budget ran out.
    Incomplete,
    /// An answer that is not what was asked for: not JSON, the wrong shape or lengths, no picture.
    BadOutput,
    /// The API turns requests away for now (429).
    Busy,
    /// The API could not be reached, or answered with an error of its own.
    Unavailable,
    /// This server failed with the answer in hand (storing it).
    Internal,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Refused => "refused",
            Self::Incomplete => "incomplete",
            Self::BadOutput => "bad_output",
            Self::Busy => "provider_busy",
            Self::Unavailable => "provider_unavailable",
            Self::Internal => "internal",
        }
    }
}

/// What a Responses API call wrote: its output text, and the tokens it used (for the log).
pub struct Written {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// `POST {base}/responses` with `request`: the text the model wrote, or why there is none.
pub async fn respond(http: &reqwest::Client, openai: &OpenAi, key: &str, request: &Value) -> Result<Written, Failure> {
    let body = serde_json::to_vec(request).map_err(|_| Failure::Internal)?;
    let call = http
        .post(format!("{}/responses", openai.base_url))
        .bearer_auth(key)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(openai.reading_timeout);
    written(&answer(call, "responses").await?)
}

/// The text of a Responses API answer: the `output_text` parts of its messages, joined. A refusal part, an answer cut
/// short or one that failed makes nothing.
fn written(answer: &Value) -> Result<Written, Failure> {
    match answer["status"].as_str() {
        Some("completed") => {}
        Some("incomplete") if answer["incomplete_details"]["reason"] == "content_filter" => {
            return Err(Failure::Refused);
        }
        Some("incomplete") => return Err(Failure::Incomplete),
        _ => return Err(Failure::Unavailable),
    }
    let mut text = String::new();
    let messages = answer["output"].as_array().into_iter().flatten().filter(|item| item["type"] == "message");
    for part in messages.flat_map(|message| message["content"].as_array().into_iter().flatten()) {
        match part["type"].as_str() {
            Some("refusal") => return Err(Failure::Refused),
            Some("output_text") => text.push_str(part["text"].as_str().unwrap_or_default()),
            _ => {}
        }
    }
    if text.trim().is_empty() {
        return Err(Failure::BadOutput);
    }
    let usage = &answer["usage"];
    Ok(Written {
        text,
        input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
    })
}

/// A picture to draw again from, as sent: its bytes, file name and media type.
pub struct Image<'a> {
    pub bytes: &'a [u8],
    pub file_name: &'a str,
    pub media_type: &'a str,
}

/// `POST {base}/images/edits` (multipart): `image` drawn again after `prompt`, 1024×1024 at high quality, as WebP. The
/// picture's bytes, or why there are none.
pub async fn edit_image(
    http: &reqwest::Client,
    openai: &OpenAi,
    key: &str,
    image: Image<'_>,
    prompt: &str,
) -> Result<Vec<u8>, Failure> {
    let fields = [
        ("model", openai.picture_model.as_str()),
        ("prompt", prompt),
        ("size", "1024x1024"),
        ("quality", "high"),
        ("output_format", "webp"),
    ];
    let (content_type, body) = multipart(&fields, "image", &image);
    let call = http
        .post(format!("{}/images/edits", openai.base_url))
        .bearer_auth(key)
        .header(CONTENT_TYPE, content_type)
        .body(body)
        .timeout(openai.picture_timeout);
    let answer = answer(call, "images/edits").await?;
    let encoded = answer["data"][0]["b64_json"].as_str().ok_or(Failure::BadOutput)?;
    STANDARD.decode(encoded).map_err(|_| Failure::BadOutput)
}

/// A `multipart/form-data` body of text `fields` and one file under `name`, with its Content-Type. The boundary is
/// random, so no part holds it.
fn multipart(fields: &[(&str, &str)], name: &str, file: &Image<'_>) -> (String, Vec<u8>) {
    let boundary = format!("mogaesup-{}", Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(file.bytes.len() + 4096);
    for (field, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            file.file_name, file.media_type
        )
        .as_bytes(),
    );
    body.extend_from_slice(file.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// Sends `call` and reads its JSON answer, at most [`MAX_ANSWER_BYTES`]. An error answer is logged by its status and
/// the API's own code and type only (its message can quote a part of the key).
async fn answer(call: reqwest::RequestBuilder, endpoint: &'static str) -> Result<Value, Failure> {
    let lost = |error: reqwest::Error| {
        let failure = if error.is_timeout() { Failure::Timeout } else { Failure::Unavailable };
        tracing::warn!(endpoint, error = %error.without_url(), "OpenAI call failed");
        failure
    };
    let mut response = call.send().await.map_err(lost)?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(lost)? {
        if chunk.len() > MAX_ANSWER_BYTES.saturating_sub(bytes.len()) {
            tracing::warn!(endpoint, "OpenAI answer too large");
            return Err(Failure::BadOutput);
        }
        bytes.extend_from_slice(&chunk);
    }
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(|_| Failure::BadOutput);
    }
    let error = serde_json::from_slice::<Value>(&bytes).unwrap_or_default();
    let code = error["error"]["code"].as_str().unwrap_or_default();
    let kind = error["error"]["type"].as_str().unwrap_or_default();
    tracing::warn!(endpoint, status = status.as_u16(), code, kind, "OpenAI refused a call");
    Err(match status.as_u16() {
        429 if code != "insufficient_quota" => Failure::Busy,
        400 if BLOCKED.iter().any(|blocked| code == *blocked || kind.contains(blocked)) => Failure::Refused,
        408 | 504 => Failure::Timeout,
        _ => Failure::Unavailable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn only_a_completed_answer_with_text_is_written() {
        let message = |content: Value| {
            json!({"status": "completed", "output": [{"type": "reasoning", "summary": []},
                {"type": "message", "role": "assistant", "content": content}], "usage": {"input_tokens": 9, "output_tokens": 4}})
        };
        let done = written(&message(
            json!([{"type": "output_text", "text": "{\"a\":"}, {"type": "output_text", "text": "1}"}]),
        ));
        let done = done.ok().unwrap();
        assert_eq!((done.text.as_str(), done.input_tokens, done.output_tokens), ("{\"a\":1}", 9, 4));
        let refused = message(json!([{"type": "refusal", "refusal": "I can't help with that."}]));
        assert_eq!(written(&refused).err(), Some(Failure::Refused));
        assert_eq!(written(&message(json!([]))).err(), Some(Failure::BadOutput));
        let cut = json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []});
        assert_eq!(written(&cut).err(), Some(Failure::Incomplete));
        let filtered =
            json!({"status": "incomplete", "incomplete_details": {"reason": "content_filter"}, "output": []});
        assert_eq!(written(&filtered).err(), Some(Failure::Refused));
        assert_eq!(
            written(&json!({"status": "failed", "error": {"code": "server_error"}})).err(),
            Some(Failure::Unavailable)
        );
    }

    #[test]
    fn a_multipart_body_holds_each_field_and_the_file_between_its_boundaries() {
        let image = Image { bytes: b"RIFF\x00\x00WEBP", file_name: "island.webp", media_type: "image/webp" };
        let (content_type, body) = multipart(&[("model", "m"), ("size", "1024x1024")], "image", &image);
        let boundary = content_type.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nm\r\n"))
        );
        assert!(text.contains("name=\"size\"\r\n\r\n1024x1024\r\n"));
        assert!(text.contains(
            "name=\"image\"; filename=\"island.webp\"\r\nContent-Type: image/webp\r\n\r\nRIFF\u{0}\u{0}WEBP\r\n"
        ));
        assert!(text.ends_with(&format!("\r\n--{boundary}--\r\n")));
        assert_eq!(text.matches(&format!("--{boundary}\r\n")).count(), 3);
    }

    #[tokio::test]
    async fn an_api_that_does_not_answer_in_time_is_a_timeout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _taken = listener.accept().await;
            std::future::pending::<()>().await
        });
        let openai = OpenAi { base_url: url, reading_timeout: Duration::from_millis(200), ..OpenAi::default() };
        let failure = respond(&reqwest::Client::new(), &openai, "test-key", &json!({})).await.err();
        assert_eq!(failure, Some(Failure::Timeout));
    }
}
