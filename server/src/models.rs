//! Where catalog models and their pictures live: an S3 prefix that CloudFront serves at `/models/*` in production, a
//! local directory in development and tests. Files are named by the SHA-256 of their bytes, so a URL never changes
//! meaning and caches forever.

use axum::{
    extract::{Path, State},
    http::header,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use futures_util::StreamExt;
use object_store::{
    Attribute, AttributeValue, Attributes, ObjectStore, PutOptions, PutPayload, aws::AmazonS3Builder,
    local::LocalFileSystem, path::Path as StorePath, prefix::PrefixStore,
};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{collections::HashSet, sync::Arc, time::Duration};

use crate::{
    AppState,
    error::{ApiResult, internal, not_found},
};

/// How old a stored file nothing refers to must be before a sweep deletes it: a file is stored before the row that
/// refers to it is written (a bake, an import, a picture), so a young one may not be referred to yet.
pub const SWEEP_AGE: chrono::Duration = chrono::Duration::days(1);
/// A file this old that is stored again is written again, so its age starts over: a sweep never takes a file just
/// handed out to a new look or picture.
const REFRESH_AFTER: chrono::Duration = chrono::Duration::hours(12);
/// When the first sweep runs after the server starts, and how often after that.
const SWEEP_FIRST: Duration = Duration::from_secs(10 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Files one sweep deletes at most.
const SWEEP_MOST: usize = 1000;

/// Every stored file's site path the database refers to: catalog items and every version kept of them, members' looks,
/// islands' link pictures, and the models placed on saved islands.
const REFERENCED: &str = r"SELECT url FROM (
    SELECT model_url AS url FROM catalog_items UNION SELECT thumbnail_url FROM catalog_items
    UNION SELECT model_url FROM catalog_versions UNION SELECT thumbnail_url FROM catalog_versions
    UNION SELECT model_url FROM user_looks UNION SELECT thumbnail_url FROM homes
    UNION SELECT '/models/' || found[1]
      FROM home_worlds, regexp_matches(data::text, '/models/([0-9a-f]{64}\.[a-z]+)', 'g') AS found
  ) refs WHERE url LIKE '/models/%'";

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

/// Whether `value` is a SHA-256 as 64 lowercase hex digits.
pub(crate) fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `bytes` with their SHA-256 in hex, hashed on a blocking thread: a model is up to 64 MiB.
pub(crate) async fn sha256(bytes: Vec<u8>) -> ApiResult<(Vec<u8>, String)> {
    tokio::task::spawn_blocking(move || {
        let sha = hex::encode(Sha256::digest(&bytes));
        (bytes, sha)
    })
    .await
    .map_err(internal)
}

/// `<64 lowercase hex>.<known extension>`, the only names the store holds.
fn stored_name(file: &str) -> Option<(&str, &'static str)> {
    let (sha, extension) = file.split_once('.')?;
    Some((sha, content_type(extension).filter(|_| is_sha256(sha))?))
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

    /// Stores `bytes` under their hash and returns the site URL. A file already stored is not written again, unless it
    /// was stored long enough ago that a sweep could take it (see [`REFRESH_AFTER`]).
    pub async fn put(&self, extension: &str, bytes: Vec<u8>) -> ApiResult<String> {
        let kind = content_type(extension).ok_or_else(|| internal("unknown model file kind"))?;
        let (bytes, sha) = sha256(bytes).await?;
        let name = format!("{sha}.{extension}");
        let path = StorePath::from(name.as_str());
        let fresh = self.store.head(&path).await.is_ok_and(|meta| Utc::now() - meta.last_modified < REFRESH_AFTER);
        if !fresh {
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

    /// Deletes the stored files older than `age` that nothing in `db` refers to ([`REFERENCED`]): the models of looks
    /// baked again, pictures replaced, imports that failed after storing their files. Returns how many went. The files
    /// are listed before the references are read, and each is looked at again just before it is deleted, so a file
    /// stored or stored again meanwhile stays.
    pub async fn sweep(&self, db: &PgPool, age: chrono::Duration) -> anyhow::Result<usize> {
        let before = Utc::now() - age;
        let mut old = Vec::new();
        let mut listing = self.store.list(None);
        while let Some(meta) = listing.next().await {
            let meta = meta?;
            if meta.last_modified < before && stored_name(meta.location.as_ref()).is_some() {
                old.push(meta.location);
            }
        }
        drop(listing);
        if old.is_empty() {
            return Ok(0);
        }
        let referenced: HashSet<String> = sqlx::query_scalar::<_, String>(REFERENCED)
            .fetch_all(db)
            .await?
            .into_iter()
            .filter_map(|url| url.strip_prefix(&format!("{URL_PREFIX}/")).map(str::to_owned))
            .collect();
        let mut deleted = 0;
        for location in old.into_iter().filter(|location| !referenced.contains(location.as_ref())).take(SWEEP_MOST) {
            let still_old = self.store.head(&location).await.is_ok_and(|meta| meta.last_modified < before);
            if still_old && self.store.delete(&location).await.is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    }
}

/// Sweeps the model store ([`Models::sweep`]) a while after the server starts and then every few hours. A sweep that
/// fails (the database or the store unreachable) deletes nothing and is tried again at the next.
pub fn spawn_sweep(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(SWEEP_FIRST).await;
        loop {
            match state.config.models.sweep(&state.db, SWEEP_AGE).await {
                Ok(0) => {}
                Ok(deleted) => tracing::info!(deleted, "Swept stored files nothing refers to"),
                Err(error) => tracing::warn!(%error, "Could not sweep the model store"),
            }
            tokio::time::sleep(SWEEP_EVERY).await;
        }
    });
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
