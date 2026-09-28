use anyhow::{Context, bail};
use std::env;

use crate::models::Models;

/// Where the character server (gaesup-character) listens, and how this server signs in to it as the operator.
#[derive(Clone)]
pub struct Factory {
    pub url: String,
    pub api_key: Option<String>,
    pub token: Option<FactoryToken>,
    /// What the studio screens may do through this server: `FACTORY_ACCESS`, read unless set.
    pub access: FactoryAccess,
    /// Paid studio requests allowed per calendar month (UTC): `FACTORY_PAID_MONTHLY`, none unless set.
    pub paid_monthly: i64,
    /// Sent as `x-gateway-key` on every request, so a studio closed to the public can still let this server in:
    /// `FACTORY_GATEWAY_KEY`.
    pub gateway_key: Option<String>,
}

/// How far the studio screens reach through this server. Each level includes the ones before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FactoryAccess {
    /// Reading only: browsing the wardrobe and the admins' libraries.
    Read,
    /// Admins also change the studio's records (uploads, catalog, outfits), but start nothing that costs money.
    Write,
    /// Admins may start paid work (generation, rigging, retries) within the monthly budget.
    Paid,
}

impl std::str::FromStr for FactoryAccess {
    type Err = anyhow::Error;
    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "paid" => Ok(Self::Paid),
            other => bail!("FACTORY_ACCESS must be read, write or paid, not {other}"),
        }
    }
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
    /// Catalog models and pictures: `MODEL_STORE`, an `s3://bucket/prefix` or a local directory.
    pub models: Models,
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
            Ok(Factory {
                url: url.trim_end_matches('/').to_owned(),
                api_key: var("FACTORY_API_KEY"),
                token,
                access: var("FACTORY_ACCESS").map_or(Ok(FactoryAccess::Read), |value| value.parse())?,
                paid_monthly: var("FACTORY_PAID_MONTHLY")
                    .map_or(Ok(0), |n| n.parse())
                    .context("FACTORY_PAID_MONTHLY")?,
                gateway_key: var("FACTORY_GATEWAY_KEY"),
            })
        });
        Ok(Self {
            origins,
            cookie_secure: var("COOKIE_SECURE").is_none_or(|value| value != "false"),
            ticket_secret,
            models: Models::open(&var("MODEL_STORE").unwrap_or_else(|| "data/local/models".into()))
                .context("MODEL_STORE")?,
            factory: factory.transpose()?,
        })
    }
}
