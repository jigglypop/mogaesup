//! Offline inspection of an existing model: no database, provider, upload or model mutation.
use gltf_json::validation::Validate;
use mogaesup_server::{glb, slim};
use serde::Deserialize;
use serde_json::json;

fn main() -> anyhow::Result<()> {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path)?;
        let details = glb::details(&bytes);
        let web = slim::slim(&bytes).unwrap_or_else(|| bytes.clone());
        let web_details = glb::details(&web);
        let mut schema_errors = Vec::new();
        if let Some((document, _)) = glb::split(&bytes) {
            match gltf_json::Root::deserialize(&document) {
                Ok(root) => root.validate(&root, gltf_json::Path::new, &mut |path, error| {
                    schema_errors.push(format!("{}: {error:?}", path()));
                }),
                Err(error) => schema_errors.push(error.to_string()),
            }
        }
        println!(
            "{}",
            json!({"file": path, "playable": details.as_ref().is_some_and(|d| d.summary().playable()),
            "schemaErrors": schema_errors, "details": details, "bytes": bytes.len(), "webBytes": web.len(),
            "webPlayable": web_details.as_ref().is_some_and(|d| d.summary().playable()),
            "webTextureEdge": web_details.as_ref().and_then(|d| d.textures.iter().filter_map(glb::Texture::edge).max())})
        );
    }
    Ok(())
}
