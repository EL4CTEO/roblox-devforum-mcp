//! Settings read once from the environment.

use std::path::PathBuf;
use std::time::Duration;

/// The package version, from Cargo.toml — the handshake and the User-Agent can never drift.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct Config {
    pub base_url: String,
    pub user_agent: String,
    pub timeout: Duration,
    pub deadline: Duration,
    pub max_retries: u32,
    pub concurrency: usize,
    pub cdn_concurrency: usize,
    pub search_ttl: Duration,
    pub docs_scan: usize,
    pub cache_dir: PathBuf,
}

/// Parse a numeric setting, falling back when the value is not a usable number.
///
/// A mistyped DEVFORUM_CONCURRENCY=abc (or 0) must degrade to the default rather than queue
/// every request forever; "2.7" floors to 2 the way the Node server read it.
pub fn parse_int(name: &str, raw: Option<&str>, fallback: u64, min: u64) -> u64 {
    let Some(raw) = raw else { return fallback };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback;
    }
    match trimmed.parse::<f64>() {
        Ok(v) if v.is_finite() && v >= min as f64 => v.floor() as u64,
        _ => {
            eprintln!("[roblox-devforum-mcp] ignoring {name}=\"{raw}\", using {fallback}");
            fallback
        }
    }
}

pub fn env_int(name: &str, fallback: u64, min: u64) -> u64 {
    parse_int(name, std::env::var(name).ok().as_deref(), fallback, min)
}

impl Config {
    pub fn from_env() -> Self {
        let timeout_ms = env_int("DEVFORUM_TIMEOUT_MS", 12_000, 100);
        let base_url = std::env::var("DEVFORUM_BASE_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "https://devforum.roblox.com".into())
            .trim()
            .trim_end_matches('/')
            .to_string();
        let user_agent = std::env::var("DEVFORUM_USER_AGENT").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| {
            format!("Mozilla/5.0 (compatible; roblox-devforum-mcp/{VERSION}; +https://github.com/EL4CTEO/roblox-devforum-mcp)")
        });
        let cache_dir =
            std::env::var_os("DEVFORUM_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("roblox-devforum-mcp"));
        Config {
            base_url,
            user_agent,
            timeout: Duration::from_millis(timeout_ms),
            deadline: Duration::from_millis(env_int("DEVFORUM_DEADLINE_MS", timeout_ms * 2, 100)),
            max_retries: env_int("DEVFORUM_MAX_RETRIES", 3, 0).min(20) as u32,
            concurrency: env_int("DEVFORUM_CONCURRENCY", 4, 1).min(256) as usize,
            cdn_concurrency: env_int("DEVFORUM_CDN_CONCURRENCY", 8, 1).min(256) as usize,
            search_ttl: Duration::from_secs(env_int("DEVFORUM_CACHE_TTL", 300, 0)),
            docs_scan: env_int("DEVFORUM_DOCS_SCAN", 14, 1).min(200) as usize,
            cache_dir,
        }
    }

    /// Defaults with no environment read: what the tests start from.
    pub fn defaults() -> Self {
        Config {
            base_url: "https://devforum.roblox.com".into(),
            user_agent: format!("roblox-devforum-mcp/{VERSION}"),
            timeout: Duration::from_millis(12_000),
            deadline: Duration::from_millis(24_000),
            max_retries: 3,
            concurrency: 4,
            cdn_concurrency: 8,
            search_ttl: Duration::from_secs(300),
            docs_scan: 14,
            cache_dir: std::env::temp_dir().join("roblox-devforum-mcp"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_int;

    #[test]
    fn env_int_falls_back_instead_of_poisoning_comparisons() {
        let k = "DEVFORUM_QA_PROBE";
        assert_eq!(parse_int(k, None, 4, 1), 4);
        assert_eq!(parse_int(k, Some(""), 4, 1), 4);
        assert_eq!(parse_int(k, Some("8"), 4, 1), 8);
        assert_eq!(parse_int(k, Some("abc"), 4, 1), 4);
        assert_eq!(parse_int(k, Some("0"), 4, 1), 4);
        assert_eq!(parse_int(k, Some("0"), 300, 0), 0);
        assert_eq!(parse_int(k, Some("-5"), 14, 1), 14);
        assert_eq!(parse_int(k, Some("2.7"), 4, 1), 2);
    }
}
