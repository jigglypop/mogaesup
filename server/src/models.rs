//! Where catalog models and their pictures live: an S3 prefix that CloudFront serves at `/models/*` in production, a
//! local directory in development and tests. Files are named by the SHA-256 of their bytes, so a URL never changes
//! meaning and caches forever.

use axum::{
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
};
use object_store::{
    Attribute, AttributeValue, Attributes, ObjectStore, PutOptions, PutPayload, aws::AmazonS3Builder,
    local::LocalFileSystem, path::Path as StorePath, prefix::PrefixStore,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{
    AppState,
    error::{ApiResult, internal, not_found},
};

/// Where the site serves stored files.
const URL_PREFIX: &str = "/models";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// File kinds the store takes, by extension.
const TYPES: [(&str, &str); 4] =
    [("glb", "model/gltf-binary"), ("png", "image/png"), ("webp", "image/webp"), ("jpg", "image/jpeg")];

#[derive(Clone)]
pub struct Models {
    store: Arc<dyn ObjectStore>,
    /// S3 keeps Content-Type and Cache-Control with the object; a local directory has no place for them.
    attributes: bool,
}

fn content_type(extension: &str) -> Option<&'static str> {
    TYPES.iter().find(|(known, _)| *known == extension).map(|(_, kind)| *kind)
}

/// `<64 lowercase hex>.<known extension>`, the only names the store holds.
fn stored_name(file: &str) -> Option<(&str, &'static str)> {
    let (sha, extension) = file.split_once('.')?;
    let valid = sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    Some((sha, content_type(extension).filter(|_| valid)?))
}

/// Whether `url` is the site path of a stored model: `/models/<sha256>.glb`.
pub fn is_model_url(url: &str) -> bool {
    url.strip_prefix(URL_PREFIX)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(stored_name)
        .is_some_and(|(_, kind)| kind == "model/gltf-binary")
}

impl Models {
    /// `s3://bucket/prefix` (region and credentials from the environment or the EC2 instance role) or a local
    /// directory.
    pub fn open(location: &str) -> anyhow::Result<Self> {
        if let Some(rest) = location.strip_prefix("s3://") {
            let (bucket, prefix) = rest.split_once('/').unwrap_or((rest, ""));
            let s3 = AmazonS3Builder::from_env().with_bucket_name(bucket).build()?;
            let prefix = prefix.trim_matches('/');
            let store: Arc<dyn ObjectStore> =
                if prefix.is_empty() { Arc::new(s3) } else { Arc::new(PrefixStore::new(s3, prefix)) };
            return Ok(Self { store, attributes: true });
        }
        std::fs::create_dir_all(location)?;
        Ok(Self { store: Arc::new(LocalFileSystem::new_with_prefix(location)?), attributes: false })
    }

    /// Stores `bytes` under their hash and returns the site URL. A file already stored is not written again.
    pub async fn put(&self, extension: &str, bytes: Vec<u8>) -> ApiResult<String> {
        let kind = content_type(extension).ok_or_else(|| internal("unknown model file kind"))?;
        let name = format!("{}.{extension}", hex::encode(Sha256::digest(&bytes)));
        let path = StorePath::from(name.as_str());
        if self.store.head(&path).await.is_err() {
            let attributes = if self.attributes {
                Attributes::from_iter([
                    (Attribute::ContentType, AttributeValue::from(kind)),
                    (Attribute::CacheControl, AttributeValue::from(IMMUTABLE)),
                ])
            } else {
                Attributes::new()
            };
            self.store
                .put_opts(&path, PutPayload::from(bytes), PutOptions { attributes, ..Default::default() })
                .await
                .map_err(internal)?;
        }
        Ok(format!("{URL_PREFIX}/{name}"))
    }
}

/// `GET /models/{file}` for development and tests; in production CloudFront answers this path from S3 itself.
pub async fn serve(State(state): State<AppState>, Path(file): Path<String>) -> ApiResult<Response> {
    const MISSING: crate::error::ApiError = not_found("not_found", "찾을 수 없습니다.");
    let (_, kind) = stored_name(&file).ok_or(MISSING)?;
    let object = state.config.models.store.get(&StorePath::from(file.as_str())).await.map_err(|_| MISSING)?;
    let bytes = object.bytes().await.map_err(internal)?;
    Ok(([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, IMMUTABLE)], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_hash_names_of_known_kinds_are_served() {
        let sha = "a".repeat(64);
        assert_eq!(stored_name(&format!("{sha}.glb")).map(|(_, kind)| kind), Some("model/gltf-binary"));
        assert_eq!(stored_name(&format!("{sha}.webp")).map(|(_, kind)| kind), Some("image/webp"));
        assert!(stored_name(&format!("{sha}.exe")).is_none());
        assert!(stored_name(&format!("{}.glb", "A".repeat(64))).is_none());
        assert!(stored_name("../secret.glb").is_none());
    }

    #[tokio::test]
    async fn a_local_store_keeps_each_file_once_under_its_hash() {
        let dir = std::env::temp_dir().join(format!("models-{}", uuid::Uuid::new_v4().simple()));
        let models = Models::open(dir.to_str().unwrap()).unwrap();
        let first = models.put("glb", b"glTF-bytes".to_vec()).await.unwrap();
        let again = models.put("glb", b"glTF-bytes".to_vec()).await.unwrap();
        assert_eq!(first, again);
        assert!(first.starts_with("/models/") && first.ends_with(".glb"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
