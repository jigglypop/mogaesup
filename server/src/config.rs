use anyhow::{Context, bail};
use std::env;

use crate::models::Models;

/// Where the character server (backend/) listens, and how this server signs in to it as the operator.
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
    /// The character server's EC2 instance, which powers itself off when idle: `STUDIO_INSTANCE_ID`. Unset, the
    /// character server is taken to be always on (local runs).
    pub instance: Option<StudioInstance>,
}

/// Where this server starts the sleeping character server (see `studio_power`).
#[derive(Clone, Debug)]
pub struct StudioInstance {
    pub id: String,
    /// `STUDIO_REGION`, else `AWS_REGION`, else ap-northeast-2.
    pub region: String,
    /// The EC2 Query API: `STUDIO_EC2_ENDPOINT`, `https://ec2.<region>.amazonaws.com` unless set.
    pub ec2_endpoint: String,
    /// Instance metadata (IMDSv2) for the role's credentials: `STUDIO_IMDS_URL`, `http://169.254.169.254` unless set.
    pub imds_url: String,
}

impl StudioInstance {
    /// Settings for instance `id` in `region` with the real AWS endpoints.
    pub fn new(id: &str, region: &str) -> anyhow::Result<Self> {
        let hex = id.strip_prefix("i-").unwrap_or_default();
        if !(8..=17).contains(&hex.len()) || !hex.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
            bail!("STUDIO_INSTANCE_ID must be an EC2 instance id (i-…), not {id}");
        }
        if region.is_empty()
            || !region.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            bail!("STUDIO_REGION must be an AWS region name, not {region}");
        }
        Ok(Self {
            id: id.to_owned(),
            region: region.to_owned(),
            ec2_endpoint: format!("https://ec2.{region}.amazonaws.com"),
            imds_url: "http://169.254.169.254".into(),
        })
    }

    fn from_env() -> anyhow::Result<Option<Self>> {
        let Some(id) = var("STUDIO_INSTANCE_ID") else { return Ok(None) };
        let region = var("STUDIO_REGION").or_else(|| var("AWS_REGION")).unwrap_or_else(|| "ap-northeast-2".into());
        let mut instance = Self::new(&id, &region)?;
        if let Some(endpoint) = var("STUDIO_EC2_ENDPOINT") {
            instance.ec2_endpoint = endpoint;
        }
        if let Some(imds) = var("STUDIO_IMDS_URL") {
            instance.imds_url = imds;
        }
        Ok(Some(instance))
    }
}

/// How far the studio screens reach through this server. Each level includes the ones before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
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
                instance: StudioInstance::from_env()?,
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
