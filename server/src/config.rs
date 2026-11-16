use anyhow::{Context, bail};
use std::{env, time::Duration};

use crate::models::Models;

/// The OpenAI API, which writes a 사주 home's reading and draws its island again (`saju_made`).
#[derive(Clone)]
pub struct OpenAi {
    /// `OPENAI_API_KEY`. Without it neither is made: their requests answer `reading_unavailable` and
    /// `picture_unavailable`.
    pub api_key: Option<String>,
    /// `OPENAI_BASE_URL` without a trailing slash, `https://api.openai.com/v1` unless set.
    pub base_url: String,
    /// `OPENAI_READING_MODEL`: the Responses API model a reading is written with.
    pub reading_model: String,
    /// `OPENAI_PICTURE_MODEL`: the image model an island is drawn again with, on `/images/edits`.
    pub picture_model: String,
    /// Paid calls of each kind allowed per calendar month (UTC) across all members: `READINGS_MONTHLY`,
    /// `PICTURES_MONTHLY`.
    pub readings_monthly: i64,
    pub pictures_monthly: i64,
    /// How long one call may take before it is given up. Not read from the environment: a call must end well inside
    /// the ten minutes after which a pending reading or picture reads as interrupted.
    pub reading_timeout: Duration,
    pub picture_timeout: Duration,
}

impl Default for OpenAi {
    fn default() -> Self {
        Self {
            api_key: None,
            base_url: "https://api.openai.com/v1".into(),
            reading_model: "gpt-6.1-terra".into(),
            picture_model: "gpt-image-2.6-sunburst".into(),
            readings_monthly: 3000,
            pictures_monthly: 500,
            reading_timeout: Duration::from_secs(6 * 60),
            picture_timeout: Duration::from_secs(6 * 60),
        }
    }
}

impl OpenAi {
    fn from_env() -> anyhow::Result<Self> {
        let defaults = Self::default();
        let model = |name: &str, default: String| -> anyhow::Result<String> {
            let Some(model) = var(name) else { return Ok(default) };
            if model.len() > 64 || !model.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_:".contains(&b)) {
                bail!("{name} must be a model name, not {model}");
            }
            Ok(model)
        };
        let monthly = |name: &str, default: i64| -> anyhow::Result<i64> {
            let monthly = var(name).map_or(Ok(default), |n| n.parse()).with_context(|| name.to_owned())?;
            if monthly < 0 {
                bail!("{name} must not be negative");
            }
            Ok(monthly)
        };
        Ok(Self {
            api_key: var("OPENAI_API_KEY"),
            base_url: var("OPENAI_BASE_URL").map_or(Ok(defaults.base_url), |url| openai_url(&url))?,
            reading_model: model("OPENAI_READING_MODEL", defaults.reading_model)?,
            picture_model: model("OPENAI_PICTURE_MODEL", defaults.picture_model)?,
            readings_monthly: monthly("READINGS_MONTHLY", defaults.readings_monthly)?,
            pictures_monthly: monthly("PICTURES_MONTHLY", defaults.pictures_monthly)?,
            ..defaults
        })
    }
}

/// Where the character server (backend/) listens, and how this server signs in to it as the operator.
#[derive(Clone)]
pub struct Factory {
    pub url: String,
    pub api_key: Option<String>,
    /// `FACTORY_JWT_SECRET` and the claims around it. Without it requests go without a token, with the server's keys
    /// alone: the studio's nginx signs them in as its owner, and a member's wardrobe read is narrowed by the
    /// `x-studio-scope` mark it carries either way (`factory::signed_as`).
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
    /// Whether this server deletes the stored files nothing refers to any more (`models::spawn_sweep`):
    /// `MODEL_SWEEP=on`, off unless set. Only the server that owns `MODEL_STORE` (production, for its bucket) turns it
    /// on: a sweep judges by its own database, so one run against another's store would delete what that one uses.
    pub model_sweep: bool,
    pub factory: Option<Factory>,
    pub openai: OpenAi,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

/// `APP_ORIGIN`'s entries as browsers send `Origin`: scheme and host in lowercase, no default port, no path or trailing
/// slash. An entry that is no http(s) origin stops the start.
fn origins(list: &str) -> anyhow::Result<Vec<String>> {
    let mut origins: Vec<String> = Vec::new();
    for entry in list.split(',').map(str::trim).filter(|entry| !entry.is_empty()) {
        let url = reqwest::Url::parse(entry).with_context(|| format!("APP_ORIGIN entry {entry} is not a URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            bail!("APP_ORIGIN entry {entry} is not an http(s) origin");
        }
        let origin = url.origin().ascii_serialization();
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}

/// `FACTORY_URL` without a trailing slash. Plain http only reaches this machine: the operator token and the API and
/// gateway keys travel in every request's headers.
fn factory_url(raw: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(raw).context("FACTORY_URL is not a URL")?;
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    let local =
        host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => bail!("FACTORY_URL must use https unless the character server runs on this machine, not {raw}"),
        other => bail!("FACTORY_URL must be an http(s) URL, not {other}"),
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// `OPENAI_BASE_URL` without a trailing slash. Plain http only reaches this machine (a stand-in in tests): the API key
/// travels in every request's headers.
fn openai_url(raw: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(raw).context("OPENAI_BASE_URL is not a URL")?;
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    let local =
        host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" if !host.is_empty() => {}
        "http" if local => {}
        _ => bail!("OPENAI_BASE_URL must be an https URL, or http on this machine, not {raw}"),
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("OPENAI_BASE_URL must be a base URL without a query, not {raw}");
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// `MODEL_STORE`, which a production server (secure cookies) must name: models written to a local directory there
/// would be lost with the instance and never reach CloudFront's `/models/*`.
fn model_store(configured: Option<String>, cookie_secure: bool) -> anyhow::Result<String> {
    match configured {
        Some(store) => Ok(store),
        None if cookie_secure => {
            bail!("MODEL_STORE is required when COOKIE_SECURE is on; set it, or COOKIE_SECURE=false for a local run")
        }
        None => Ok("data/local/models".into()),
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let origins =
            origins(&var("APP_ORIGIN").unwrap_or_else(|| "http://127.0.0.1:5180,http://localhost:5180".into()))?;
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
                url: factory_url(&url)?,
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
        let cookie_secure = var("COOKIE_SECURE").is_none_or(|value| value != "false");
        let factory = factory.transpose()?;
        Ok(Self {
            origins,
            cookie_secure,
            ticket_secret,
            models: Models::open(&model_store(var("MODEL_STORE"), cookie_secure)?).context("MODEL_STORE")?,
            model_sweep: model_sweep(var("MODEL_SWEEP").as_deref())?,
            factory,
            openai: OpenAi::from_env()?,
        })
    }
}

/// `MODEL_SWEEP`: `on` or `off`, off unless set.
fn model_sweep(value: Option<&str>) -> anyhow::Result<bool> {
    match value {
        None | Some("off") => Ok(false),
        Some("on") => Ok(true),
        Some(other) => bail!("MODEL_SWEEP must be on or off, not {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_kept_as_browsers_send_them() {
        assert_eq!(
            origins(" https://Mogaesup.COM/ , HTTPS://www.mogaesup.com:443,https://mogaesup.com").unwrap(),
            ["https://mogaesup.com", "https://www.mogaesup.com"]
        );
        assert_eq!(origins("http://127.0.0.1:5180").unwrap(), ["http://127.0.0.1:5180"]);
        for broken in ["mogaesup.com", "ftp://mogaesup.com", "https://"] {
            assert!(origins(broken).is_err(), "{broken}");
        }
    }

    #[test]
    fn the_character_server_is_reached_over_https_unless_it_is_local() {
        assert_eq!(factory_url("https://studio.example.com/").unwrap(), "https://studio.example.com");
        for local in ["http://127.0.0.1:8016", "http://localhost:8016", "http://[::1]:8016"] {
            assert!(factory_url(local).is_ok(), "{local}");
        }
        for refused in ["http://studio.example.com", "http://10.0.0.5:8016", "ftp://127.0.0.1", "studio"] {
            assert!(factory_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_model_sweep_runs_only_where_it_is_turned_on() {
        assert!(!model_sweep(None).unwrap());
        assert!(!model_sweep(Some("off")).unwrap());
        assert!(model_sweep(Some("on")).unwrap());
        for unclear in ["true", "1", "ON", "yes"] {
            assert!(model_sweep(Some(unclear)).is_err(), "{unclear}");
        }
    }

    #[test]
    fn the_openai_api_is_reached_over_https_unless_a_stand_in_runs_here() {
        assert_eq!(openai_url("https://api.openai.com/v1/").unwrap(), "https://api.openai.com/v1");
        assert_eq!(openai_url("http://127.0.0.1:9100/v1").unwrap(), "http://127.0.0.1:9100/v1");
        for refused in ["http://api.openai.com/v1", "ftp://127.0.0.1/v1", "https://api.openai.com/v1?key=1", "openai"] {
            assert!(openai_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_production_server_names_its_model_store() {
        assert!(model_store(None, true).is_err());
        assert_eq!(model_store(None, false).unwrap(), "data/local/models");
        assert_eq!(model_store(Some("s3://bucket/models".into()), true).unwrap(), "s3://bucket/models");
    }
}
