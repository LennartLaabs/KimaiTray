//! Customer logos.
//!
//! Images are fetched natively, converted to a small PNG, cached in the app
//! data directory and handed to the webview as `data:` URLs, so the webview's
//! strict CSP never has to allow remote images.
//!
//! Unlike the Kimai HTTP broker (`crate::http`), logo sources are arbitrary
//! public websites named by Kimai data. Requests therefore only go to HTTPS
//! hosts whose resolved addresses are all public, carry no credentials and are
//! bounded in size, time and redirects.

use std::collections::BTreeSet;
use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_HTML_BYTES: usize = 1024 * 1024;
const MAX_MANUAL_BASE64_BYTES: usize = 1536 * 1024;
const MAX_URL_BYTES: usize = 2048;
const MAX_REDIRECTS: usize = 3;
const MAX_ICON_CANDIDATES: usize = 6;
const MAX_HEAD_TAGS: usize = 600;
/// A share image (`og:image`) only serves as a logo when it is about square.
const MAX_SQUARE_RATIO: f64 = 1.25;
const MAX_SOURCE_DIMENSION: u32 = 4096;
const MAX_DECODE_BYTES: u64 = 64 * 1024 * 1024;
const LOGO_SIZE: u32 = 128;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const LOGO_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// A customer without a usable logo is asked again after an hour, so a
/// homepage that starts serving an icon is picked up the same day. A changed
/// homepage does not wait for this at all (see `is_fresh`).
const MISS_TTL_SECS: u64 = 60 * 60;
const MAX_CONCURRENT_FETCHES: usize = 2;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; KimaiTray)";
const CHANGED_EVENT: &str = "adversum://logos-changed";

static FETCH_SEMAPHORE: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONCURRENT_FETCHES);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LogoSource {
    Manual,
    Logodev,
    Homepage,
    None,
}

/// Why a lookup ended without a logo; shown on the settings page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LogoProblem {
    /// Kimai has no homepage for the customer.
    NoHomepage,
    /// The homepage is not a public HTTPS address.
    InvalidHomepage,
    /// The homepage could not be loaded.
    Unreachable,
    /// The homepage answered with an error status (`detail` holds it).
    HttpStatus,
    /// The homepage loaded, but none of its icons could be used.
    NoIcon,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoMeta {
    source: LogoSource,
    fetched_at: u64,
    tried_logo_dev: bool,
    /// The homepage this result was looked up for, as Kimai returned it.
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    problem: Option<LogoProblem>,
    #[serde(default)]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoEntry {
    customer_id: u64,
    source: LogoSource,
    data_url: Option<String>,
    /// The cached result is older than its lifetime and should be refreshed.
    stale: bool,
    /// Unix time in seconds at which the result expires; `None` for manual logos.
    expires_at: Option<u64>,
    tried_logo_dev: bool,
    /// The homepage the result was looked up for.
    homepage: Option<String>,
    problem: Option<LogoProblem>,
    /// Detail for `problem`, such as the HTTP status.
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoFetchRequest {
    connection_id: String,
    customer_id: u64,
    homepage: Option<String>,
    logo_dev_token: Option<String>,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoManualRequest {
    connection_id: String,
    customer_id: u64,
    image_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoRef {
    connection_id: String,
    customer_id: u64,
}

// ── Target validation ──────────────────────────────────────────

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        // Carrier-grade NAT 100.64.0.0/10
        || (a == 100 && (64..=127).contains(&b))
        // IETF protocol assignments 192.0.0.0/24
        || (a == 192 && b == 0 && c == 0)
        // Benchmarking 198.18.0.0/15
        || (a == 198 && (18..=19).contains(&b))
        // Reserved 240.0.0.0/4
        || a >= 240)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // Unique local fc00::/7
        || segments[0] & 0xfe00 == 0xfc00
        // Link local fe80::/10
        || segments[0] & 0xffc0 == 0xfe80
        // Documentation 2001:db8::/32
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        // NAT64 64:ff9b::/96 can address private IPv4 hosts
        || (segments[0] == 0x0064 && segments[1] == 0xff9b))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn host_for_lookup(url: &Url) -> Result<&str, String> {
    let host = url.host_str().ok_or("Logo URL must include a host")?;
    Ok(host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host))
}

fn validate_public_url(url: &Url) -> Result<(), String> {
    if url.as_str().len() > MAX_URL_BYTES {
        return Err("Logo URL is too long".into());
    }
    if url.scheme() != "https" {
        return Err("Only HTTPS logo URLs are allowed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials embedded in logo URLs are not allowed".into());
    }
    if url.port_or_known_default() != Some(443) {
        return Err("Logo URLs must use the default HTTPS port".into());
    }
    let host = host_for_lookup(url)?;
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_ip(address) {
            return Err("Logo target IP range is not allowed".into());
        }
    } else if !host.contains('.') {
        // Single-label names only resolve inside a local network.
        return Err("Logo host must be a public domain".into());
    }
    Ok(())
}

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() {
        return Err("Logo target could not be resolved".into());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("Logo target IP range is not allowed".into());
    }
    Ok(())
}

/// Turns the free-text Kimai `homepage` field into a public HTTPS URL.
fn normalize_homepage(value: &str) -> Option<Url> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_BYTES {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&candidate).ok()?;
    if url.scheme() == "http" {
        // Sites reachable over plain HTTP only are skipped by the fetch.
        url.set_scheme("https").ok()?;
        url.set_port(None).ok()?;
    }
    url.set_fragment(None);
    validate_public_url(&url).ok()?;
    Some(url)
}

/// Registrable-looking domain used for the logo.dev lookup.
fn logo_domain(site: &Url) -> Option<String> {
    let host = site.domain()?.to_ascii_lowercase();
    let domain = host.strip_prefix("www.").unwrap_or(&host);
    (domain.contains('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
    .then(|| domain.to_string())
}

fn valid_logo_dev_token(token: &str) -> Option<&str> {
    let token = token.trim();
    (!token.is_empty()
        && token.len() <= 128
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then_some(token)
}

// ── HTTP ───────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
enum FetchError {
    /// The server answered with a non-success status.
    Status(u16),
    /// The response arrived but is not a usable image.
    Invalid(String),
    /// The target is not allowed or the request did not complete.
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Status(status) => write!(formatter, "Logo request returned HTTP {status}"),
            FetchError::Invalid(message) | FetchError::Failed(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl From<String> for FetchError {
    fn from(message: String) -> Self {
        FetchError::Failed(message)
    }
}

impl From<&str> for FetchError {
    fn from(message: &str) -> Self {
        FetchError::Failed(message.into())
    }
}

async fn client_for(url: &Url) -> Result<reqwest::Client, String> {
    let host = host_for_lookup(url)?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT);
    if host.parse::<IpAddr>().is_err() {
        let mut addresses = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| "Logo target could not be resolved".to_string())?
            .collect::<Vec<_>>();
        addresses.sort_unstable();
        addresses.dedup();
        validate_resolved_addresses(&addresses)?;
        // Pin the validated addresses so the request cannot be re-resolved to
        // a different (private) target.
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    builder
        .build()
        .map_err(|_| "Failed to initialize logo HTTP client".to_string())
}

/// GET with manual, re-validated redirects. `truncate` keeps the first
/// `max_bytes` of a longer body (enough for an HTML `<head>`) instead of
/// failing.
async fn fetch_bytes(
    start: &Url,
    accept: &str,
    max_bytes: usize,
    truncate: bool,
) -> Result<(Url, Vec<u8>), FetchError> {
    let mut url = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        validate_public_url(&url)?;
        let client = client_for(&url).await?;
        let mut response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, accept)
            .send()
            .await
            .map_err(|_| "Logo request failed".to_string())?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Logo redirect has no target")?;
            url = url
                .join(location)
                .map_err(|_| "Logo redirect target is invalid".to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(FetchError::Status(status.as_u16()));
        }
        if !truncate
            && response
                .content_length()
                .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(FetchError::Invalid("Logo response is too large".into()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Logo request failed".to_string())?
        {
            if body.len() + chunk.len() > max_bytes {
                if !truncate {
                    return Err(FetchError::Invalid("Logo response is too large".into()));
                }
                body.extend_from_slice(&chunk[..max_bytes - body.len()]);
                break;
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((url, body));
    }
    Err("Too many logo redirects".into())
}

// ── Image handling ─────────────────────────────────────────────

struct DecodedLogo {
    png: Vec<u8>,
    /// Size of the source image, before it was scaled down.
    width: u32,
    height: u32,
}

/// Decodes any supported raster image and re-encodes it as a PNG of at most
/// `LOGO_SIZE` pixels per side. Nothing fetched is ever stored or returned
/// without passing through this.
fn decode_logo(bytes: &[u8]) -> Result<DecodedLogo, String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Invalid logo image".to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Unsupported or invalid logo image".to_string())?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err("Logo image is empty".into());
    }
    let sized = if width > LOGO_SIZE || height > LOGO_SIZE {
        decoded.resize(LOGO_SIZE, LOGO_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(sized.to_rgba8())
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| "Failed to encode logo".to_string())?;
    Ok(DecodedLogo { png, width, height })
}

fn to_logo_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    decode_logo(bytes).map(|logo| logo.png)
}

fn roughly_square(width: u32, height: u32) -> bool {
    let (long, short) = (width.max(height), width.min(height));
    f64::from(long) <= f64::from(short) * MAX_SQUARE_RATIO
}

async fn fetch_image(url: &Url, must_be_square: bool) -> Result<Vec<u8>, FetchError> {
    let (_, bytes) = fetch_bytes(url, "image/*", MAX_IMAGE_BYTES, false).await?;
    let logo = decode_logo(&bytes).map_err(FetchError::Invalid)?;
    if must_be_square && !roughly_square(logo.width, logo.height) {
        return Err(FetchError::Invalid(
            "Image is not square enough for a logo".into(),
        ));
    }
    Ok(logo.png)
}

// ── Homepage icon discovery ────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeadTag {
    Link,
    Meta,
}

/// The few character references that occur in URLs inside HTML attributes.
fn decode_entities(value: &str) -> String {
    if !value.contains('&') {
        return value.to_string();
    }
    let mut decoded = value.to_string();
    for (entity, character) in [
        ("&amp;", "&"),
        ("&#038;", "&"),
        ("&#38;", "&"),
        ("&#x26;", "&"),
        ("&quot;", "\""),
        ("&#039;", "'"),
        ("&#39;", "'"),
    ] {
        decoded = decoded.replace(entity, character);
    }
    decoded
}

/// Every `<link>` and `<meta>` tag of the document head with its attributes
/// (keys lowercased). Scripts, styles and comments are skipped, so markup
/// inside them neither produces tags nor ends the head early.
fn parse_head_tags(html: &str) -> Vec<(HeadTag, Vec<(String, String)>)> {
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let lower_bytes = lower.as_bytes();
    let mut tags = Vec::new();
    let mut position = 0;
    while let Some(offset) = lower[position..].find('<') {
        let start = position + offset;
        let rest = &lower[start..];
        if rest.starts_with("</head") || rest.starts_with("<body") {
            break;
        }
        let skipped = [
            ("<!--", "-->"),
            ("<script", "</script"),
            ("<style", "</style"),
        ]
        .into_iter()
        .find(|(open, _)| rest.starts_with(open));
        if let Some((open, close)) = skipped {
            match rest[open.len()..].find(close) {
                Some(end) => position = start + open.len() + end + close.len(),
                None => break,
            }
            continue;
        }
        let kind = [("<link", HeadTag::Link), ("<meta", HeadTag::Meta)]
            .into_iter()
            .find(|(name, _)| {
                rest.starts_with(name)
                    && lower_bytes
                        .get(start + name.len())
                        .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'/')
            })
            .map(|(_, kind)| kind);
        let Some(kind) = kind else {
            position = start + 1;
            continue;
        };
        let mut index = start + 5;
        let mut attributes = Vec::new();
        loop {
            while index < bytes.len()
                && (bytes[index].is_ascii_whitespace() || bytes[index] == b'/')
            {
                index += 1;
            }
            if index >= bytes.len() || bytes[index] == b'>' {
                break;
            }
            let name_start = index;
            while index < bytes.len()
                && !bytes[index].is_ascii_whitespace()
                && !matches!(bytes[index], b'=' | b'>' | b'/')
            {
                index += 1;
            }
            let name = lower[name_start..index].to_string();
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            let mut value = String::new();
            if index < bytes.len() && bytes[index] == b'=' {
                index += 1;
                while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                if index < bytes.len() && matches!(bytes[index], b'"' | b'\'') {
                    let quote = bytes[index];
                    index += 1;
                    let value_start = index;
                    while index < bytes.len() && bytes[index] != quote {
                        index += 1;
                    }
                    value = decode_entities(&html[value_start..index]);
                    index = (index + 1).min(bytes.len());
                } else {
                    let value_start = index;
                    while index < bytes.len()
                        && !bytes[index].is_ascii_whitespace()
                        && bytes[index] != b'>'
                    {
                        index += 1;
                    }
                    value = decode_entities(&html[value_start..index]);
                }
            }
            if !name.is_empty() {
                attributes.push((name, value));
            }
        }
        tags.push((kind, attributes));
        if tags.len() >= MAX_HEAD_TAGS {
            break;
        }
        position = index.max(start + 1);
    }
    tags
}

fn largest_declared_size(sizes: &str) -> Option<u32> {
    sizes
        .split_ascii_whitespace()
        .filter_map(|size| {
            let (width, height) = size
                .to_ascii_lowercase()
                .split_once('x')
                .map(|(w, h)| (w.parse::<u32>().unwrap_or(0), h.parse::<u32>().unwrap_or(0)))?;
            Some(width.max(height))
        })
        .max()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IconCandidate {
    url: Url,
    /// Share images are often wide photos; those are no logo.
    must_be_square: bool,
}

/// A public HTTPS image URL from an attribute value, or `None` when it cannot
/// be used (relative to nothing, a `data:` URL, an SVG, a private address).
fn candidate_url(base: &Url, value: &str, declared_type: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() || value.starts_with("data:") {
        return None;
    }
    let mut url = base.join(value).ok()?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    url.set_fragment(None);
    // SVG icons are skipped because they are not rasterized natively.
    let is_svg = declared_type.to_ascii_lowercase().contains("svg")
        || url.path().to_ascii_lowercase().ends_with(".svg");
    (!is_svg && validate_public_url(&url).is_ok()).then_some(url)
}

/// Images worth trying as a logo, best first:
///
/// 1. `<meta name="msapplication-TileImage">`
/// 2. `<meta property="og:image">`, when it turns out to be about square
/// 3. `<link rel="apple-touch-icon">`, largest first
/// 4. every `<link rel="icon">` variant, largest first
/// 5. `/favicon.ico`
fn icon_candidates(html: &str, base: &Url) -> Vec<IconCandidate> {
    const TIER: u32 = 100_000;
    let mut ranked: Vec<(u32, IconCandidate)> = Vec::new();
    for (kind, attributes) in parse_head_tags(html) {
        let get = |name: &str| {
            attributes
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
                .unwrap_or("")
        };
        let (rank, value, declared_type, must_be_square) = match kind {
            HeadTag::Meta => {
                let name = get("name").to_ascii_lowercase();
                let property = get("property").to_ascii_lowercase();
                if name == "msapplication-tileimage" {
                    (4 * TIER, get("content"), "", false)
                } else if property == "og:image" || name == "og:image" {
                    (3 * TIER, get("content"), "", true)
                } else {
                    continue;
                }
            }
            HeadTag::Link => {
                let rel = get("rel").to_ascii_lowercase();
                let rel_tokens: Vec<&str> = rel.split_ascii_whitespace().collect();
                let apple = rel_tokens.iter().any(|token| {
                    matches!(*token, "apple-touch-icon" | "apple-touch-icon-precomposed")
                });
                if !apple && !rel_tokens.contains(&"icon") {
                    continue;
                }
                let declared = largest_declared_size(get("sizes"));
                let rank = if apple {
                    2 * TIER + declared.unwrap_or(180).min(TIER - 1)
                } else {
                    TIER + declared.unwrap_or(16).min(TIER - 1)
                };
                (rank, get("href"), get("type"), false)
            }
        };
        if let Some(url) = candidate_url(base, value, declared_type) {
            ranked.push((
                rank,
                IconCandidate {
                    url,
                    must_be_square,
                },
            ));
        }
    }
    ranked.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
    let mut candidates: Vec<IconCandidate> = Vec::new();
    for (_, candidate) in ranked {
        if !candidates.iter().any(|known| known.url == candidate.url) {
            candidates.push(candidate);
        }
    }
    if let Ok(url) = base.join("/favicon.ico") {
        if !candidates.iter().any(|known| known.url == url) {
            // The conventional location always gets a try, even when the page
            // declares more images than the candidate limit.
            candidates.truncate(MAX_ICON_CANDIDATES - 1);
            candidates.push(IconCandidate {
                url,
                must_be_square: false,
            });
        }
    }
    candidates.truncate(MAX_ICON_CANDIDATES);
    candidates
}

/// Outcome of a lookup that found no logo.
#[derive(Debug, PartialEq, Eq)]
struct Miss {
    problem: LogoProblem,
    detail: Option<String>,
}

impl Miss {
    fn new(problem: LogoProblem) -> Self {
        Miss {
            problem,
            detail: None,
        }
    }
}

fn page_miss(error: FetchError) -> Miss {
    match error {
        FetchError::Status(status) => Miss {
            problem: LogoProblem::HttpStatus,
            detail: Some(status.to_string()),
        },
        FetchError::Invalid(detail) | FetchError::Failed(detail) => Miss {
            problem: LogoProblem::Unreachable,
            detail: Some(detail),
        },
    }
}

async fn fetch_homepage_icon(site: &Url) -> Result<Vec<u8>, Miss> {
    let (page_url, html) = fetch_bytes(site, "text/html,*/*;q=0.8", MAX_HTML_BYTES, true)
        .await
        .map_err(page_miss)?;
    let html = String::from_utf8_lossy(&html);
    for candidate in icon_candidates(&html, &page_url) {
        match fetch_image(&candidate.url, candidate.must_be_square).await {
            Ok(png) => return Ok(png),
            Err(error) => log::debug!("Logo candidate {} skipped: {error}", candidate.url),
        }
    }
    Err(Miss::new(LogoProblem::NoIcon))
}

/// Whether a logo.dev answer settles the question for this customer. A
/// rejected key, a rate limit or a network problem does not, so logo.dev is
/// asked again once the cause is fixed.
fn logo_dev_settled(result: &Result<Vec<u8>, FetchError>) -> bool {
    matches!(
        result,
        Ok(_) | Err(FetchError::Status(404)) | Err(FetchError::Invalid(_))
    )
}

fn logo_dev_url(domain: &str, token: &str) -> Option<Url> {
    // `fallback=404` asks for "not found" instead of a generated monogram, so
    // an unknown company falls through to its homepage icon.
    Url::parse(&format!(
        "https://img.logo.dev/{domain}?token={token}&size={LOGO_SIZE}&format=png&fallback=404"
    ))
    .ok()
}

/// Result of looking for a customer's logo.
struct Resolution {
    logo: Result<(LogoSource, Vec<u8>), Miss>,
    /// logo.dev has been asked conclusively, or could not be asked at all for
    /// this customer.
    tried_logo_dev: bool,
}

/// Looks for a logo: logo.dev first when a key is configured, then the
/// customer's homepage.
async fn resolve_logo(homepage: Option<&str>, token: Option<&str>) -> Resolution {
    let miss = |problem| Resolution {
        logo: Err(Miss::new(problem)),
        tried_logo_dev: token.is_some(),
    };
    let Some(homepage) = homepage else {
        return miss(LogoProblem::NoHomepage);
    };
    let Some(site) = normalize_homepage(homepage) else {
        return miss(LogoProblem::InvalidHomepage);
    };
    let mut settled = false;
    if let Some(token) = token {
        match logo_domain(&site).and_then(|domain| logo_dev_url(&domain, token)) {
            None => settled = true,
            Some(url) => {
                let result = fetch_image(&url, false).await;
                settled = logo_dev_settled(&result);
                if let Ok(png) = result {
                    return Resolution {
                        logo: Ok((LogoSource::Logodev, png)),
                        tried_logo_dev: true,
                    };
                }
            }
        }
    }
    Resolution {
        logo: fetch_homepage_icon(&site)
            .await
            .map(|png| (LogoSource::Homepage, png)),
        tried_logo_dev: settled,
    }
}

// ── Cache ──────────────────────────────────────────────────────

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn validate_scope(connection_id: &str) -> Result<(), String> {
    let valid = !connection_id.is_empty()
        && connection_id.len() <= 128
        && connection_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err("Invalid logo cache scope".into())
    }
}

fn scope_dir(app: &AppHandle, connection_id: &str) -> Result<PathBuf, String> {
    validate_scope(connection_id)?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("adversum")
        .join("logos")
        .join(connection_id))
}

fn manual_path(dir: &Path, customer_id: u64) -> PathBuf {
    dir.join(format!("{customer_id}.manual.png"))
}

fn auto_path(dir: &Path, customer_id: u64) -> PathBuf {
    dir.join(format!("{customer_id}.auto.png"))
}

fn meta_path(dir: &Path, customer_id: u64) -> PathBuf {
    dir.join(format!("{customer_id}.json"))
}

fn data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Logo path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_meta(dir: &Path, customer_id: u64) -> Option<LogoMeta> {
    serde_json::from_slice(&std::fs::read(meta_path(dir, customer_id)).ok()?).ok()
}

fn read_entry(dir: &Path, customer_id: u64, now: u64) -> Option<LogoEntry> {
    let meta = read_meta(dir, customer_id);
    if let Some(manual) = data_url(&manual_path(dir, customer_id)) {
        return Some(LogoEntry {
            customer_id,
            source: LogoSource::Manual,
            data_url: Some(manual),
            stale: false,
            expires_at: None,
            tried_logo_dev: true,
            homepage: meta.and_then(|meta| meta.homepage),
            problem: None,
            detail: None,
        });
    }
    let meta = meta?;
    let image = match meta.source {
        LogoSource::Logodev | LogoSource::Homepage => data_url(&auto_path(dir, customer_id)),
        LogoSource::Manual | LogoSource::None => None,
    };
    // A found logo whose file vanished is reported as a stale miss.
    let source = if image.is_some() {
        meta.source
    } else {
        LogoSource::None
    };
    let lifetime = if source == LogoSource::None {
        MISS_TTL_SECS
    } else {
        LOGO_TTL_SECS
    };
    let missing_file = meta.source != LogoSource::None && image.is_none();
    let expires_at = if missing_file {
        meta.fetched_at
    } else {
        meta.fetched_at.saturating_add(lifetime)
    };
    Some(LogoEntry {
        customer_id,
        source,
        data_url: image,
        stale: now >= expires_at,
        expires_at: Some(expires_at),
        tried_logo_dev: meta.tried_logo_dev,
        homepage: meta.homepage,
        problem: meta.problem,
        detail: meta.detail,
    })
}

fn store_auto(
    dir: &Path,
    customer_id: u64,
    homepage: Option<&str>,
    resolution: Resolution,
    now: u64,
) -> Result<(), String> {
    let (source, miss) = match resolution.logo {
        Ok((source, png)) => {
            write_atomically(&auto_path(dir, customer_id), &png)?;
            (source, None)
        }
        Err(miss) => {
            remove_if_present(&auto_path(dir, customer_id))?;
            (LogoSource::None, Some(miss))
        }
    };
    let (problem, detail) = match miss {
        Some(miss) => (Some(miss.problem), miss.detail),
        None => (None, None),
    };
    let meta = LogoMeta {
        source,
        fetched_at: now,
        tried_logo_dev: resolution.tried_logo_dev,
        homepage: homepage.map(str::to_string),
        problem,
        detail,
    };
    write_atomically(
        &meta_path(dir, customer_id),
        &serde_json::to_vec(&meta).map_err(|error| error.to_string())?,
    )
}

/// The homepage as it is compared and stored: trimmed, `None` when empty.
fn clean_homepage(homepage: Option<&str>) -> Option<&str> {
    homepage.map(str::trim).filter(|value| !value.is_empty())
}

/// Whether a cached result can be used as it is. It cannot when it expired,
/// when Kimai now names a different homepage (including none, or one where
/// there was none), or when a logo.dev key arrived that was never tried.
fn is_fresh(entry: &LogoEntry, homepage: Option<&str>, has_token: bool) -> bool {
    !entry.stale && entry.homepage.as_deref() == homepage && (!has_token || entry.tried_logo_dev)
}

fn list_entries(dir: &Path, now: u64) -> Vec<LogoEntry> {
    let Ok(files) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let ids: BTreeSet<u64> = files
        .filter_map(Result::ok)
        .filter_map(|file| {
            file.file_name()
                .to_str()?
                .split('.')
                .next()?
                .parse::<u64>()
                .ok()
        })
        .collect();
    ids.into_iter()
        .filter_map(|customer_id| read_entry(dir, customer_id, now))
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoChanged<'a> {
    connection_id: &'a str,
    customer_id: u64,
    /// The customer's current entry; `None` when nothing is cached any more.
    entry: Option<&'a LogoEntry>,
}

/// Tells every window which entry changed, so none has to reload the list.
fn notify(app: &AppHandle, connection_id: &str, customer_id: u64, entry: Option<&LogoEntry>) {
    let _ = app.emit(
        CHANGED_EVENT,
        LogoChanged {
            connection_id,
            customer_id,
            entry,
        },
    );
}

// ── Commands ───────────────────────────────────────────────────

#[tauri::command]
pub fn adversum_logo_list(app: AppHandle, connection_id: String) -> Result<Vec<LogoEntry>, String> {
    Ok(list_entries(&scope_dir(&app, &connection_id)?, unix_now()))
}

#[tauri::command]
pub async fn adversum_logo_fetch(
    app: AppHandle,
    request: LogoFetchRequest,
) -> Result<LogoEntry, String> {
    let dir = scope_dir(&app, &request.connection_id)?;
    let token = request
        .logo_dev_token
        .as_deref()
        .and_then(valid_logo_dev_token);
    let homepage = clean_homepage(request.homepage.as_deref());
    if let Some(entry) = read_entry(&dir, request.customer_id, unix_now()) {
        let fresh = is_fresh(&entry, homepage, token.is_some());
        if entry.source == LogoSource::Manual || (fresh && !request.force) {
            return Ok(entry);
        }
    }
    let _permit = FETCH_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| "Logo fetch queue is unavailable".to_string())?;
    let resolution = resolve_logo(homepage, token).await;
    let now = unix_now();
    store_auto(&dir, request.customer_id, homepage, resolution, now)?;
    let entry = read_entry(&dir, request.customer_id, now).ok_or("Logo cache entry is missing")?;
    notify(
        &app,
        &request.connection_id,
        request.customer_id,
        Some(&entry),
    );
    Ok(entry)
}

fn require_settings_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("Manual logos can only be changed from settings".into())
    }
}

#[tauri::command]
pub fn adversum_logo_set_manual(
    app: AppHandle,
    window: WebviewWindow,
    request: LogoManualRequest,
) -> Result<LogoEntry, String> {
    require_settings_window(&window)?;
    let dir = scope_dir(&app, &request.connection_id)?;
    if request.image_base64.len() > MAX_MANUAL_BASE64_BYTES {
        return Err("Logo image is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.image_base64.as_bytes())
        .map_err(|_| "Invalid logo image data".to_string())?;
    let png = to_logo_png(&bytes)?;
    write_atomically(&manual_path(&dir, request.customer_id), &png)?;
    let entry =
        read_entry(&dir, request.customer_id, unix_now()).ok_or("Logo cache entry is missing")?;
    notify(
        &app,
        &request.connection_id,
        request.customer_id,
        Some(&entry),
    );
    Ok(entry)
}

#[tauri::command]
pub fn adversum_logo_clear_manual(
    app: AppHandle,
    window: WebviewWindow,
    request: LogoRef,
) -> Result<Option<LogoEntry>, String> {
    require_settings_window(&window)?;
    let dir = scope_dir(&app, &request.connection_id)?;
    remove_if_present(&manual_path(&dir, request.customer_id))?;
    let entry = read_entry(&dir, request.customer_id, unix_now());
    notify(
        &app,
        &request.connection_id,
        request.customer_id,
        entry.as_ref(),
    );
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([122, 25, 255, 255]),
        ))
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
        bytes
    }

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn only_public_addresses_are_allowed() {
        for blocked in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.10",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::a00:1",
            "::ffff:192.168.1.1",
        ] {
            assert!(!is_public_ip(blocked.parse().unwrap()), "{blocked}");
        }
        for allowed in [
            "93.184.216.34",
            "8.8.8.8",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(allowed.parse().unwrap()), "{allowed}");
        }
    }

    #[test]
    fn logo_urls_must_be_plain_public_https() {
        assert!(validate_public_url(&url("https://example.com/logo.png")).is_ok());
        assert!(validate_public_url(&url("http://example.com/logo.png")).is_err());
        assert!(validate_public_url(&url("https://user:pw@example.com/")).is_err());
        assert!(validate_public_url(&url("https://example.com:8443/")).is_err());
        assert!(validate_public_url(&url("https://192.168.0.5/")).is_err());
        assert!(validate_public_url(&url("https://[::1]/")).is_err());
        assert!(validate_public_url(&url("https://intranet/")).is_err());
        assert!(validate_public_url(&url("file:///etc/passwd")).is_err());
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert!(validate_public_url(&url(&long)).is_err());
    }

    #[test]
    fn resolved_addresses_must_all_be_public() {
        assert!(
            validate_resolved_addresses(&[SocketAddr::from(([93, 184, 216, 34], 443))]).is_ok()
        );
        assert!(validate_resolved_addresses(&[
            SocketAddr::from(([93, 184, 216, 34], 443)),
            SocketAddr::from(([10, 0, 0, 5], 443)),
        ])
        .is_err());
        assert!(validate_resolved_addresses(&[]).is_err());
    }

    #[test]
    fn homepages_are_normalized_to_https_urls() {
        assert_eq!(
            normalize_homepage(" www.example.com ").unwrap().as_str(),
            "https://www.example.com/"
        );
        assert_eq!(
            normalize_homepage("http://example.com/de/#start")
                .unwrap()
                .as_str(),
            "https://example.com/de/"
        );
        assert!(normalize_homepage("").is_none());
        assert!(normalize_homepage("ftp://example.com").is_none());
        assert!(normalize_homepage("https://localhost").is_none());
        assert!(normalize_homepage("http://192.168.1.1").is_none());
        assert!(normalize_homepage("not a url").is_none());
    }

    #[test]
    fn logo_dev_domain_and_token_are_restricted() {
        assert_eq!(
            logo_domain(&url("https://www.Example.com/path")).as_deref(),
            Some("example.com")
        );
        assert_eq!(
            logo_domain(&url("https://shop.example.co.uk")).as_deref(),
            Some("shop.example.co.uk")
        );
        assert!(logo_domain(&url("https://93.184.216.34")).is_none());
        assert_eq!(valid_logo_dev_token(" pk_Abc-123 "), Some("pk_Abc-123"));
        assert!(valid_logo_dev_token("").is_none());
        assert!(valid_logo_dev_token("pk_a&size=9999").is_none());
        assert!(valid_logo_dev_token(&"a".repeat(129)).is_none());
    }

    #[test]
    fn logo_dev_is_only_settled_by_a_conclusive_answer() {
        assert!(logo_dev_settled(&Ok(Vec::new())));
        assert!(logo_dev_settled(&Err(FetchError::Status(404))));
        assert!(logo_dev_settled(&Err(FetchError::Invalid(
            "bad image".into()
        ))));
        assert!(!logo_dev_settled(&Err(FetchError::Status(401))));
        assert!(!logo_dev_settled(&Err(FetchError::Status(429))));
        assert!(!logo_dev_settled(&Err(FetchError::from("offline"))));
        assert_eq!(
            logo_dev_url("example.com", "pk_test").unwrap().as_str(),
            "https://img.logo.dev/example.com?token=pk_test&size=128&format=png&fallback=404"
        );
        assert_eq!(
            FetchError::Status(403).to_string(),
            "Logo request returned HTTP 403"
        );
        assert_eq!(
            FetchError::from("offline".to_string()).to_string(),
            "offline"
        );
    }

    #[test]
    fn head_tags_are_parsed_tolerantly() {
        let html = r#"<!doctype html><HTML><head>
            <LINK REL="Icon" href=/a.png sizes=32x32>
            <link rel='apple-touch-icon' href='/touch.png' />
            <link rel=stylesheet href=style.css>
            <linker rel="icon" href="/ignored.png">
            <META name="msapplication-TileImage" content="/tile.png?a=1&#038;b=2">
            <metadata name="x" content="ignored">
            </head><body><link rel="icon" href="/late.png"></body>"#;
        let tags = parse_head_tags(html);
        assert_eq!(tags.len(), 4);
        assert_eq!(
            tags[0],
            (
                HeadTag::Link,
                vec![
                    ("rel".to_string(), "Icon".to_string()),
                    ("href".to_string(), "/a.png".to_string()),
                    ("sizes".to_string(), "32x32".to_string()),
                ]
            )
        );
        assert_eq!(tags[1].1[1], ("href".to_string(), "/touch.png".to_string()));
        assert_eq!(tags[3].0, HeadTag::Meta);
        assert_eq!(
            tags[3].1[1],
            ("content".to_string(), "/tile.png?a=1&b=2".to_string())
        );
        assert!(parse_head_tags("<link rel=\"icon").len() <= 1);
        assert!(parse_head_tags("no markup at all").is_empty());
    }

    #[test]
    fn markup_inside_scripts_styles_and_comments_is_ignored() {
        let html = r#"<head>
            <!-- <link rel="icon" href="/commented.png"> -->
            <script>document.write('<link rel="icon" href="/scripted.png"></head><body>');</script>
            <style>a::after { content: "<body>"; }</style>
            <link rel="icon" href="/real.png">
            <script>never closed <link rel="icon" href="/lost.png">"#;
        let tags = parse_head_tags(html);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].1[1].1, "/real.png");
    }

    #[test]
    fn entities_in_attribute_values_are_decoded() {
        assert_eq!(decode_entities("/a.png"), "/a.png");
        assert_eq!(
            decode_entities("/i?a=1&amp;b=2&#038;c=3&#38;d=4&#x26;e=&quot;x&quot;&#039;y&#39;"),
            "/i?a=1&b=2&c=3&d=4&e=\"x\"'y'"
        );
    }

    fn candidate_urls(html: &str, base: &Url) -> Vec<(String, bool)> {
        icon_candidates(html, base)
            .into_iter()
            .map(|candidate| (String::from(candidate.url), candidate.must_be_square))
            .collect()
    }

    #[test]
    fn icon_candidates_follow_the_documented_order() {
        // The icon markup of a typical WordPress site, as dusw.de serves it.
        let html = r#"<head>
            <link rel="icon" type="image/png" href="/uploads/fbrfg/favicon-96x96.png" sizes="96x96" />
            <link rel="icon" type="image/svg+xml" href="/uploads/fbrfg/favicon.svg" />
            <link rel="shortcut icon" href="/uploads/fbrfg/favicon.ico" />
            <link rel="apple-touch-icon" sizes="180x180" href="/uploads/fbrfg/apple-touch-icon.png" />
            <link rel="icon" href="https://example.com/uploads/logo-250x250.png" sizes="192x192" />
            <meta property="og:image" content="https://example.com/uploads/share.jpg" />
            <meta name="msapplication-TileImage" content="https://example.com/uploads/logo-450x450.png" />
        </head>"#;
        let base = url("https://example.com/de/start");
        assert_eq!(
            candidate_urls(html, &base),
            [
                (
                    "https://example.com/uploads/logo-450x450.png".to_string(),
                    false
                ),
                ("https://example.com/uploads/share.jpg".to_string(), true),
                (
                    "https://example.com/uploads/fbrfg/apple-touch-icon.png".to_string(),
                    false
                ),
                (
                    "https://example.com/uploads/logo-250x250.png".to_string(),
                    false
                ),
                (
                    "https://example.com/uploads/fbrfg/favicon-96x96.png".to_string(),
                    false
                ),
                ("https://example.com/favicon.ico".to_string(), false),
            ]
        );
    }

    #[test]
    fn icon_candidates_skip_unusable_urls_and_always_try_favicon() {
        let html = r#"<head>
            <link rel="icon" type="image/svg+xml" href="/icon.svg">
            <link rel="icon" href="/small.png" sizes="16x16">
            <link rel="shortcut icon" href="/big.png" sizes="48x48 96x96">
            <link rel="apple-touch-icon" href="touch-120.png" sizes="120x120">
            <link rel="apple-touch-icon-precomposed" href="https://cdn.example.net/touch-180.png" sizes="180x180">
            <link rel="apple-touch-icon" href="touch-default.png">
            <link rel="icon" href="data:image/png;base64,AAAA">
            <link rel="icon" href="http://192.168.0.2/private.png">
            <link rel="icon" href="http://example.com/upgraded.png" sizes="64x64">
            <link rel="mask-icon" href="/mask.svg">
            <meta name="og:image" content="">
            <meta name="description" content="/not-an-image.png">
        </head>"#;
        let base = url("https://example.com/de/start");
        let urls: Vec<String> = candidate_urls(html, &base)
            .into_iter()
            .map(|(url, _)| url)
            .collect();
        // Seven usable images are declared; five fit next to /favicon.ico.
        assert_eq!(
            urls,
            [
                "https://cdn.example.net/touch-180.png",
                "https://example.com/de/touch-default.png",
                "https://example.com/de/touch-120.png",
                "https://example.com/big.png",
                "https://example.com/upgraded.png",
                "https://example.com/favicon.ico",
            ]
        );
        assert_eq!(
            candidate_urls("<html></html>", &base),
            [("https://example.com/favicon.ico".to_string(), false)]
        );
        // A page that names /favicon.ico itself does not list it twice.
        assert_eq!(
            candidate_urls(r#"<link rel="icon" href="/favicon.ico">"#, &base),
            [("https://example.com/favicon.ico".to_string(), false)]
        );
    }

    #[test]
    fn images_are_reencoded_and_bounded() {
        let small = decode_logo(&png_of(32, 16)).unwrap();
        assert_eq!((small.width, small.height), (32, 16));
        let decoded = image::load_from_memory(&small.png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 16));

        let large = decode_logo(&png_of(512, 256)).unwrap();
        assert_eq!((large.width, large.height), (512, 256));
        let decoded = image::load_from_memory(&large.png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (128, 64));

        assert!(to_logo_png(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        assert!(to_logo_png(b"").is_err());
        assert!(to_logo_png(&png_of(MAX_SOURCE_DIMENSION + 1, 1)).is_err());
    }

    #[test]
    fn share_images_must_be_about_square() {
        assert!(roughly_square(450, 450));
        assert!(roughly_square(500, 400));
        assert!(roughly_square(400, 500));
        assert!(!roughly_square(1200, 630));
        assert!(!roughly_square(630, 1200));
    }

    #[test]
    fn page_failures_are_reported_as_problems() {
        assert_eq!(
            page_miss(FetchError::Status(403)),
            Miss {
                problem: LogoProblem::HttpStatus,
                detail: Some("403".into())
            }
        );
        assert_eq!(
            page_miss(FetchError::from("Logo request failed")),
            Miss {
                problem: LogoProblem::Unreachable,
                detail: Some("Logo request failed".into())
            }
        );
        assert_eq!(
            page_miss(FetchError::Invalid("too large".into())).problem,
            LogoProblem::Unreachable
        );
    }

    #[tokio::test]
    async fn lookups_without_a_usable_homepage_say_why() {
        let none = resolve_logo(None, None).await;
        assert_eq!(none.logo, Err(Miss::new(LogoProblem::NoHomepage)));
        assert!(!none.tried_logo_dev);
        // Without a domain there is nothing to ask logo.dev for.
        assert!(resolve_logo(None, Some("pk_x")).await.tried_logo_dev);

        let invalid = resolve_logo(Some("https://localhost/"), Some("pk_x")).await;
        assert_eq!(invalid.logo, Err(Miss::new(LogoProblem::InvalidHomepage)));
        assert!(invalid.tried_logo_dev);
    }

    #[test]
    fn cache_scope_cannot_escape_the_logo_directory() {
        assert!(validate_scope("3f2c1e9a-1111-4222-8333-444455556666").is_ok());
        assert!(validate_scope("").is_err());
        assert!(validate_scope("../other").is_err());
        assert!(validate_scope("a/b").is_err());
        assert!(validate_scope(&"a".repeat(129)).is_err());
    }

    fn found(source: LogoSource, tried_logo_dev: bool) -> Resolution {
        Resolution {
            logo: Ok((source, png_of(8, 8))),
            tried_logo_dev,
        }
    }

    fn missed(problem: LogoProblem, detail: Option<&str>, tried_logo_dev: bool) -> Resolution {
        Resolution {
            logo: Err(Miss {
                problem,
                detail: detail.map(str::to_string),
            }),
            tried_logo_dev,
        }
    }

    #[test]
    fn cached_logos_expire_and_manual_logos_win() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        let now = 1_800_000_000;
        assert!(read_entry(dir, 7, now).is_none());

        store_auto(
            dir,
            7,
            Some("https://dusw.example"),
            found(LogoSource::Homepage, false),
            now,
        )
        .unwrap();
        let entry = read_entry(dir, 7, now + LOGO_TTL_SECS - 1).unwrap();
        assert_eq!(entry.source, LogoSource::Homepage);
        assert!(entry
            .data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(!entry.stale);
        assert_eq!(entry.expires_at, Some(now + LOGO_TTL_SECS));
        assert!(!entry.tried_logo_dev);
        assert_eq!(entry.homepage.as_deref(), Some("https://dusw.example"));
        assert_eq!(entry.problem, None);
        assert!(read_entry(dir, 7, now + LOGO_TTL_SECS).unwrap().stale);

        // A miss is kept for one hour only, with the reason.
        store_auto(
            dir,
            8,
            Some("https://broken.example"),
            missed(LogoProblem::HttpStatus, Some("503"), true),
            now,
        )
        .unwrap();
        let miss = read_entry(dir, 8, now + 3599).unwrap();
        assert_eq!(miss.source, LogoSource::None);
        assert!(miss.data_url.is_none());
        assert!(miss.tried_logo_dev);
        assert!(!miss.stale);
        assert_eq!(miss.expires_at, Some(now + 3600));
        assert_eq!(miss.problem, Some(LogoProblem::HttpStatus));
        assert_eq!(miss.detail.as_deref(), Some("503"));
        assert!(read_entry(dir, 8, now + 3600).unwrap().stale);

        write_atomically(&manual_path(dir, 7), &png_of(4, 4)).unwrap();
        let manual = read_entry(dir, 7, now + 10 * LOGO_TTL_SECS).unwrap();
        assert_eq!(manual.source, LogoSource::Manual);
        assert!(!manual.stale);
        assert_eq!(manual.expires_at, None);
        assert_eq!(manual.homepage.as_deref(), Some("https://dusw.example"));
        // A manual logo needs no earlier lookup.
        write_atomically(&manual_path(dir, 20), &png_of(4, 4)).unwrap();
        assert_eq!(read_entry(dir, 20, now).unwrap().homepage, None);

        let listed = list_entries(dir, now);
        assert_eq!(
            listed
                .iter()
                .map(|entry| (entry.customer_id, entry.source))
                .collect::<Vec<_>>(),
            [
                (7, LogoSource::Manual),
                (8, LogoSource::None),
                (20, LogoSource::Manual)
            ]
        );

        remove_if_present(&manual_path(dir, 7)).unwrap();
        remove_if_present(&manual_path(dir, 7)).unwrap();
        assert_eq!(
            read_entry(dir, 7, now).unwrap().source,
            LogoSource::Homepage
        );

        // A found logo whose image file vanished is a stale miss.
        remove_if_present(&auto_path(dir, 7)).unwrap();
        let vanished = read_entry(dir, 7, now).unwrap();
        assert_eq!(vanished.source, LogoSource::None);
        assert!(vanished.stale);

        // Replacing a found logo with a miss removes the old image.
        store_auto(
            dir,
            9,
            Some("a.example"),
            found(LogoSource::Logodev, true),
            now,
        )
        .unwrap();
        store_auto(
            dir,
            9,
            None,
            missed(LogoProblem::NoHomepage, None, true),
            now,
        )
        .unwrap();
        assert!(!auto_path(dir, 9).exists());
        assert_eq!(
            read_entry(dir, 9, now).unwrap().problem,
            Some(LogoProblem::NoHomepage)
        );
        assert!(list_entries(&dir.join("missing"), now).is_empty());
    }

    #[test]
    fn a_changed_homepage_invalidates_the_cached_result_at_once() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        let now = 1_800_000_000;

        // The case from the bug report: first lookup without a homepage ...
        store_auto(
            dir,
            1,
            None,
            missed(LogoProblem::NoHomepage, None, false),
            now,
        )
        .unwrap();
        let miss = read_entry(dir, 1, now + 60).unwrap();
        assert!(is_fresh(&miss, None, false));
        // ... then the homepage is entered in Kimai a minute later.
        assert!(!is_fresh(&miss, Some("https://dusw.de"), false));

        store_auto(
            dir,
            1,
            Some("https://dusw.de"),
            found(LogoSource::Homepage, false),
            now,
        )
        .unwrap();
        let hit = read_entry(dir, 1, now + 60).unwrap();
        assert!(is_fresh(&hit, Some("https://dusw.de"), false));
        assert!(!is_fresh(&hit, Some("https://www.dusw.de"), false));
        assert!(!is_fresh(&hit, None, false));
        // A logo.dev key that was never tried, and expiry, also end freshness.
        assert!(!is_fresh(&hit, Some("https://dusw.de"), true));
        let expired = read_entry(dir, 1, now + LOGO_TTL_SECS).unwrap();
        assert!(!is_fresh(&expired, Some("https://dusw.de"), false));

        assert_eq!(
            clean_homepage(Some("  https://dusw.de ")),
            Some("https://dusw.de")
        );
        assert_eq!(clean_homepage(Some("   ")), None);
        assert_eq!(clean_homepage(None), None);
    }

    #[test]
    fn cache_files_written_before_homepages_were_tracked_still_load() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        std::fs::write(
            meta_path(dir, 1),
            br#"{"source":"none","fetchedAt":1795699795,"triedLogoDev":false}"#,
        )
        .unwrap();
        let entry = read_entry(dir, 1, 1_795_699_800).unwrap();
        assert_eq!(entry.source, LogoSource::None);
        assert_eq!(entry.homepage, None);
        assert_eq!(entry.problem, None);
        // Such an entry is refetched as soon as Kimai names a homepage.
        assert!(!is_fresh(&entry, Some("https://dusw.de"), false));
    }

    /// Exercises the real network path (DNS pinning, TLS, redirects, icon
    /// discovery, decoding). Run by hand:
    /// `cargo test adversum::logos -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs network access"]
    async fn live_homepage_icons_are_found_and_private_targets_refused() {
        for homepage in [
            "wikipedia.org",
            "https://github.com",
            "http://www.kimai.org/",
            "https://dusw.de",
            // Redirects to the address without "www".
            "https://www.dusw.de",
            "kkglobalsolutions.com",
        ] {
            let resolution = resolve_logo(Some(homepage), None).await;
            let (source, png) = resolution
                .logo
                .unwrap_or_else(|miss| panic!("no logo for {homepage}: {miss:?}"));
            assert_eq!(source, LogoSource::Homepage);
            assert!(!resolution.tried_logo_dev);
            let decoded = image::load_from_memory(&png).unwrap();
            assert!(decoded.width() <= LOGO_SIZE && decoded.height() <= LOGO_SIZE);
            println!("{homepage}: {}x{} px", decoded.width(), decoded.height());
        }
        // A page without any icon, and one that does not exist.
        let no_icon = resolve_logo(Some("https://example.com"), None).await;
        println!("example.com: {:?}", no_icon.logo.as_ref().err());
        assert_eq!(no_icon.logo, Err(Miss::new(LogoProblem::NoIcon)));
        let missing = resolve_logo(Some("https://kimaitray-no-such-host.invalid"), None).await;
        println!("unknown host: {:?}", missing.logo.as_ref().err());
        assert_eq!(missing.logo.unwrap_err().problem, LogoProblem::Unreachable);

        assert!(fetch_bytes(&url("https://127.0.0.1/"), "*/*", 1024, false)
            .await
            .is_err());
        // A public name pointing at a loopback address is refused after DNS
        // (some resolvers already refuse to answer for it).
        assert!(
            fetch_bytes(&url("https://localtest.me/"), "*/*", 1024, false)
                .await
                .is_err()
        );
    }

    #[test]
    fn entries_serialize_with_frontend_field_names() {
        let entry = LogoEntry {
            customer_id: 3,
            source: LogoSource::None,
            data_url: None,
            stale: true,
            expires_at: Some(1_800_003_600),
            tried_logo_dev: true,
            homepage: Some("https://dusw.de".into()),
            problem: Some(LogoProblem::NoIcon),
            detail: None,
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            serde_json::json!({
                "customerId": 3,
                "source": "none",
                "dataUrl": null,
                "stale": true,
                "expiresAt": 1_800_003_600u64,
                "triedLogoDev": true,
                "homepage": "https://dusw.de",
                "problem": "noIcon",
                "detail": null
            })
        );
        for (problem, name) in [
            (LogoProblem::NoHomepage, "noHomepage"),
            (LogoProblem::InvalidHomepage, "invalidHomepage"),
            (LogoProblem::Unreachable, "unreachable"),
            (LogoProblem::HttpStatus, "httpStatus"),
        ] {
            assert_eq!(serde_json::to_value(problem).unwrap(), name);
        }
        let request: LogoFetchRequest = serde_json::from_value(serde_json::json!({
            "connectionId": "c1",
            "customerId": 3,
            "homepage": "example.com",
            "logoDevToken": null
        }))
        .unwrap();
        assert!(!request.force);
        assert_eq!(request.homepage.as_deref(), Some("example.com"));
    }
}
