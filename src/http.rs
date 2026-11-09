//! Shared HTTP layer: typed TTL cache, request coalescing, per-host concurrency, retry with
//! backoff inside one overall deadline.

use std::any::Any;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::de::DeserializeOwned;
use tokio::sync::Semaphore;

use crate::config::Config;

/* --------------------------------- errors --------------------------------- */

#[derive(Debug, Clone)]
pub enum Error {
    /// The upstream did not answer in time: the one failure a caller can act on.
    Timeout {
        url: String,
        elapsed_ms: u64,
    },
    Http {
        status: u16,
        url: String,
    },
    Network(String),
    /// A 200 whose body was not what it claimed (a maintenance page, say).
    Parse(String),
    Msg(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Timeout { url, elapsed_ms } => {
                write!(f, "the request timed out after {}s: {url}", (*elapsed_ms as f64 / 1000.0).round() as u64)
            }
            Error::Http { status, url } => write!(f, "HTTP {status} for {url}"),
            Error::Network(m) | Error::Parse(m) | Error::Msg(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn is_timeout(&self) -> bool {
        matches!(self, Error::Timeout { .. })
    }
}

/* -------------------------------- transport -------------------------------- */

pub struct Response {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: Bytes,
}

#[derive(Debug)]
pub enum FetchError {
    Timeout,
    Network(String),
}

pub type Headers = &'static [(&'static str, &'static str)];

/// The network, behind a trait so tests can answer from a fake forum.
pub trait Transport: Send + Sync + 'static {
    fn get<'a>(&'a self, url: &'a str, headers: Headers, timeout: Duration) -> BoxFuture<'a, Result<Response, FetchError>>;
}

/// A transport that never reaches the network: every request fails as a network error.
pub struct Offline;

impl Transport for Offline {
    fn get<'a>(&'a self, _url: &'a str, _h: Headers, _t: Duration) -> BoxFuture<'a, Result<Response, FetchError>> {
        async { Err(FetchError::Network("offline".into())) }.boxed()
    }
}

pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(cfg: &Config) -> Result<Self, Error> {
        let client = reqwest::Client::builder()
            .user_agent(cfg.user_agent.clone())
            .gzip(true)
            .brotli(true)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(cfg.cdn_concurrency.max(cfg.concurrency))
            .connect_timeout(cfg.timeout)
            .tcp_nodelay(true)
            .build()
            .map_err(|e| Error::Msg(format!("could not build the HTTP client: {e}")))?;
        Ok(ReqwestTransport { client })
    }
}

fn describe(err: &reqwest::Error) -> String {
    let mut msg = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

impl Transport for ReqwestTransport {
    fn get<'a>(&'a self, url: &'a str, headers: Headers, timeout: Duration) -> BoxFuture<'a, Result<Response, FetchError>> {
        async move {
            let mut req = self.client.get(url).timeout(timeout);
            let mut has_accept = false;
            for (k, v) in headers {
                has_accept |= k.eq_ignore_ascii_case("accept");
                req = req.header(*k, *v);
            }
            if !has_accept {
                req = req.header("accept", "application/json, text/plain, */*");
            }
            let map = |e: reqwest::Error| if e.is_timeout() { FetchError::Timeout } else { FetchError::Network(describe(&e)) };
            let res = req.send().await.map_err(map)?;
            let status = res.status().as_u16();
            let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_string);
            if !res.status().is_success() {
                // The body is not wanted; dropping the response frees the connection.
                return Ok(Response { status, retry_after, body: Bytes::new() });
            }
            // The body is read inside the same timeout: a CDN that stalls mid-file is a timeout.
            let body = res.bytes().await.map_err(map)?;
            Ok(Response { status, retry_after, body })
        }
        .boxed()
    }
}

/* ---------------------------------- cache ---------------------------------- */

type AnyArc = Arc<dyn Any + Send + Sync>;
type SharedLoad = Shared<Pin<Box<dyn Future<Output = Result<AnyArc, Error>> + Send>>>;

const MAX_ENTRIES: usize = 400;

struct Entry {
    value: AnyArc,
    expires: Instant,
    stamp: u64,
}

#[derive(Default)]
struct Lru {
    map: HashMap<String, Entry>,
    tick: u64,
}

impl Lru {
    fn get(&mut self, key: &str) -> Option<AnyArc> {
        let now = Instant::now();
        let expired = match self.map.get_mut(key) {
            None => return None,
            Some(e) if e.expires <= now => true,
            Some(e) => {
                self.tick += 1;
                e.stamp = self.tick;
                return Some(e.value.clone());
            }
        };
        if expired {
            self.map.remove(key);
        }
        None
    }

    fn set(&mut self, key: String, value: AnyArc, ttl: Duration) {
        if ttl.is_zero() {
            return;
        }
        self.tick += 1;
        self.map.insert(key, Entry { value, expires: Instant::now() + ttl, stamp: self.tick });
        if self.map.len() > MAX_ENTRIES {
            let now = Instant::now();
            self.map.retain(|_, e| e.expires > now);
            while self.map.len() > MAX_ENTRIES {
                let Some(oldest) = self.map.iter().min_by_key(|(_, e)| e.stamp).map(|(k, _)| k.clone()) else { break };
                self.map.remove(&oldest);
            }
        }
    }
}

/* ----------------------------------- http ---------------------------------- */

pub const JSON: Headers = &[];
pub const TEXT: Headers = &[("accept", "text/plain, text/markdown, */*")];
pub const GITHUB: Headers = &[("accept", "application/vnd.github+json"), ("x-github-api-version", "2022-11-28")];

/// Static hosts get a wider gate: docs search fans out to a dozen files at once.
const CDN_HOSTS: &[&str] = &["raw.githubusercontent.com", "api.github.com"];

struct Inner {
    transport: Arc<dyn Transport>,
    cfg: Arc<Config>,
    cache: Mutex<Lru>,
    inflight: Mutex<HashMap<String, SharedLoad>>,
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
}

#[derive(Clone)]
pub struct Http {
    inner: Arc<Inner>,
}

pub fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    rest[..end].rsplit('@').next().unwrap_or("").to_ascii_lowercase()
}

fn retryable(status: u16) -> bool {
    status == 408 || status == 425 || status == 429 || status >= 500
}

static SEED: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);

fn jitter_ms(max: u64) -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos() as u64);
    let mut x = SEED.load(Ordering::Relaxed) ^ nanos;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    SEED.store(x, Ordering::Relaxed);
    x % max.max(1)
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(400 * (1u64 << attempt.min(10)) + jitter_ms(250))
}

pub fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Error> {
    serde_json::from_slice(bytes).map_err(|e| Error::Parse(format!("the response was not valid JSON ({e})")))
}

impl Http {
    pub fn new(transport: Arc<dyn Transport>, cfg: Arc<Config>) -> Self {
        Http { inner: Arc::new(Inner { transport, cfg, cache: Mutex::default(), inflight: Mutex::default(), gates: Mutex::default() }) }
    }

    pub fn clear_cache(&self) {
        self.inner.cache.lock().unwrap().map.clear();
    }

    /// Cached JSON GET, parsed once into `T` and shared from then on.
    pub async fn get_json<T: DeserializeOwned + Send + Sync + 'static>(&self, url: &str, ttl: Duration) -> Result<Arc<T>, Error> {
        let key = format!("{}|{url}", std::any::type_name::<T>());
        self.load(key, url, JSON, ttl, |b| parse_json::<T>(b)).await
    }

    /// Cached text GET.
    pub async fn get_text(&self, url: &str, ttl: Duration) -> Result<Arc<str>, Error> {
        let key = format!("text:{url}");
        let v = self.load(key, url, TEXT, ttl, |b| Ok::<Arc<str>, Error>(Arc::from(String::from_utf8_lossy(b)))).await?;
        Ok((*v).clone())
    }

    /// Uncached GET parsed straight from the body: for large one-off files (API dump, docs tree)
    /// that are memoised in processed form, so caching the raw parse would only waste memory.
    pub async fn fetch_json<T: DeserializeOwned>(&self, url: &str, headers: Headers) -> Result<T, Error> {
        let body = self.request(url, headers).await?;
        parse_json(&body)
    }

    async fn load<T, F>(&self, key: String, url: &str, headers: Headers, ttl: Duration, parse: F) -> Result<Arc<T>, Error>
    where
        T: Send + Sync + 'static,
        F: FnOnce(&[u8]) -> Result<T, Error> + Send + 'static,
    {
        let downcast = |v: AnyArc| v.downcast::<T>().map_err(|_| Error::Msg("cache type mismatch".into()));
        if let Some(hit) = self.inner.cache.lock().unwrap().get(&key) {
            return downcast(hit);
        }
        // One in-flight request per key, shared by everyone who asks meanwhile. The load runs
        // as its own task, so a caller that is cancelled never strands the request (or the
        // concurrency slot it holds) half-way through.
        let shared = {
            let mut inflight = self.inner.inflight.lock().unwrap();
            if let Some(running) = inflight.get(&key) {
                running.clone()
            } else {
                let this = self.clone();
                let url = url.to_string();
                let task_key = key.clone();
                let handle = tokio::spawn(async move {
                    let out = async {
                        let body = this.request(&url, headers).await?;
                        let value: AnyArc = Arc::new(parse(&body)?);
                        this.inner.cache.lock().unwrap().set(task_key.clone(), value.clone(), ttl);
                        Ok(value)
                    }
                    .await;
                    this.inner.inflight.lock().unwrap().remove(&task_key);
                    out
                });
                let fut: Pin<Box<dyn Future<Output = Result<AnyArc, Error>> + Send>> =
                    Box::pin(async move { handle.await.unwrap_or_else(|e| Err(Error::Msg(format!("request task failed: {e}")))) });
                let shared = fut.shared();
                inflight.insert(key, shared.clone());
                shared
            }
        };
        downcast(shared.await?)
    }

    fn gate(&self, host: &str) -> Arc<Semaphore> {
        let mut gates = self.inner.gates.lock().unwrap();
        gates
            .entry(host.to_string())
            .or_insert_with(|| {
                let limit = if CDN_HOSTS.contains(&host) { self.inner.cfg.cdn_concurrency } else { self.inner.cfg.concurrency };
                Arc::new(Semaphore::new(limit))
            })
            .clone()
    }

    /// One logical GET: a concurrency slot, then attempts until success or the deadline.
    ///
    /// Retries are for a service that is briefly unwell, not one that is simply slow: a query
    /// the index cannot answer inside the timeout will not answer on the next attempt either,
    /// so a timeout ends the call. The deadline starts once a slot is held.
    pub async fn request(&self, url: &str, headers: Headers) -> Result<Bytes, Error> {
        let cfg = &self.inner.cfg;
        let gate = self.gate(&host_of(url));
        let _permit = gate.acquire_owned().await.map_err(|_| Error::Msg("request gate closed".into()))?;
        let started = Instant::now();
        let elapsed_ms = |s: Instant| s.elapsed().as_millis() as u64;
        let mut last: Option<Error> = None;
        for attempt in 0..=cfg.max_retries {
            let elapsed = started.elapsed();
            if attempt > 0 && elapsed >= cfg.deadline {
                break;
            }
            let budget = cfg.deadline.saturating_sub(elapsed).max(Duration::from_millis(500));
            match self.inner.transport.get(url, headers, cfg.timeout.min(budget)).await {
                Ok(res) if (200..300).contains(&res.status) => return Ok(res.body),
                Ok(res) => {
                    let err = Error::Http { status: res.status, url: url.to_string() };
                    if !retryable(res.status) || attempt == cfg.max_retries {
                        return Err(err);
                    }
                    // A Retry-After past the deadline ends in giving up anyway, so the answer the
                    // forum already gave is reported now.
                    let wait = match res.retry_after.as_deref().and_then(|v| v.trim().parse::<f64>().ok()) {
                        Some(secs) if secs > 0.0 => Duration::from_millis((secs * 1000.0).min(10_000.0) as u64),
                        _ => backoff(attempt),
                    };
                    if started.elapsed() + wait >= cfg.deadline {
                        return Err(err);
                    }
                    last = Some(err);
                    tokio::time::sleep(wait).await;
                }
                Err(FetchError::Timeout) => {
                    last = Some(Error::Timeout { url: url.to_string(), elapsed_ms: elapsed_ms(started) });
                    break;
                }
                Err(FetchError::Network(msg)) => {
                    last = Some(Error::Network(msg));
                    if attempt == cfg.max_retries {
                        break;
                    }
                    tokio::time::sleep(backoff(attempt)).await;
                }
            }
        }
        Err(last.unwrap_or_else(|| Error::Timeout { url: url.to_string(), elapsed_ms: elapsed_ms(started) }))
    }
}

/// `application/x-www-form-urlencoded`, as URLSearchParams writes it.
pub fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// encodeURIComponent.
pub fn uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Counting {
        active: AtomicUsize,
        peak: AtomicUsize,
        calls: AtomicUsize,
    }

    impl Transport for Counting {
        fn get<'a>(&'a self, _url: &'a str, _h: Headers, _t: Duration) -> BoxFuture<'a, Result<Response, FetchError>> {
            async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                self.peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                self.active.fetch_sub(1, Ordering::SeqCst);
                Ok(Response { status: 200, retry_after: None, body: Bytes::from_static(b"{\"ok\":true}") })
            }
            .boxed()
        }
    }

    fn counting() -> (Arc<Counting>, Http) {
        let t = Arc::new(Counting { active: 0.into(), peak: 0.into(), calls: 0.into() });
        let http = Http::new(t.clone(), Arc::new(Config::defaults()));
        (t, http)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn gate_never_exceeds_the_limit() {
        let (t, http) = counting();
        let calls = (0..20).map(|i| {
            let http = http.clone();
            async move { http.get_json::<serde_json::Value>(&format!("https://devforum.roblox.com/x/{i}.json"), Duration::ZERO).await }
        });
        for r in futures_util::future::join_all(calls).await {
            r.unwrap();
        }
        assert!(t.peak.load(Ordering::SeqCst) <= 4);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn same_url_is_fetched_once() {
        let (t, http) = counting();
        let calls = (0..8).map(|_| {
            let http = http.clone();
            async move { http.get_text("https://cdn.test/doc.md", Duration::ZERO).await }
        });
        for r in futures_util::future::join_all(calls).await {
            assert_eq!(&*r.unwrap(), "{\"ok\":true}");
        }
        assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn encodes_like_the_browser() {
        assert_eq!(form_encode("a b#c"), "a+b%23c");
        assert_eq!(uri_component("a b"), "a%20b");
        assert_eq!(host_of("https://Devforum.roblox.com/t/1.json?x"), "devforum.roblox.com");
    }
}
