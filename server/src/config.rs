use anyhow::{Context, bail};
use std::{env, path::PathBuf};

/// Where the character server (gaesup-character) listens, and how this server signs in to it as the operator.
#[derive(Clone)]
pub struct Factory {
    pub url: String,
    pub api_key: Option<String>,
    pub token: Option<FactoryToken>,
}

/// HS256 settings the character server's `auth.py` accepts; its data is kept per owner id, so every admin works in
/// `owner_id`'s workspace.
#[derive(Clone)]
pub struct FactoryToken {
    pub key: Vec<u8>,
    pub issuer: String,
    pub audience: String,
    pub owner_id: i64,
}

#[derive(Clone)]
pub struct Config {
    pub origins: Vec<String>,
    pub cookie_secure: bool,
    pub ticket_secret: Vec<u8>,
    pub blob_dir: PathBuf,
    pub factory: Option<Factory>,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let origins = var("APP_ORIGIN")
            .unwrap_or_else(|| "http://127.0.0.1:5180,http://localhost:5180".into())
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        let ticket_secret = var("REALTIME_TICKET_SECRET").context("REALTIME_TICKET_SECRET is required")?.into_bytes();
        if ticket_secret.len() < 32 {
            bail!("REALTIME_TICKET_SECRET must be at least 32 bytes");
        }
        let factory = var("FACTORY_URL").map(|url| -> anyhow::Result<Factory> {
            let token = var("FACTORY_JWT_SECRET")
                .map(|secret| -> anyhow::Result<FactoryToken> {
                    Ok(FactoryToken {
                        key: crate::factory::hmac_key(&secret),
                        issuer: var("FACTORY_JWT_ISSUER").unwrap_or_else(|| "mogaesup".into()),
                        audience: var("FACTORY_JWT_AUDIENCE").unwrap_or_else(|| "mogaesup-client".into()),
                        owner_id: var("FACTORY_OWNER_ID").map_or(Ok(1), |id| id.parse()).context("FACTORY_OWNER_ID")?,
                    })
                })
                .transpose()?;
            Ok(Factory { url: url.trim_end_matches('/').to_owned(), api_key: var("FACTORY_API_KEY"), token })
        });
        Ok(Self {
            origins,
            cookie_secure: var("COOKIE_SECURE").is_none_or(|value| value != "false"),
            ticket_secret,
            blob_dir: var("BLOB_DIR").map_or_else(|| PathBuf::from("data/blobs"), PathBuf::from),
            factory: factory.transpose()?,
        })
    }
}
