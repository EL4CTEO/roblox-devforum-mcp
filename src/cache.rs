//! Best-effort disk cache, so a fresh process does not re-download large static files, plus
//! the in-memory memo that shares one load among every caller.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use futures_util::future::{FutureExt, Shared};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::http::Error;

/// Return the cached value for `name` when it is younger than `max_age`, otherwise run `load`
/// and cache its result. Every filesystem step is optional; a failed refresh falls back on a
/// stale copy rather than failing the tool.
pub async fn cached_json<T, F, Fut>(dir: &Path, name: &str, max_age: Duration, load: F) -> Result<T, Error>
where
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, Error>>,
{
    let file = dir.join(format!("{name}.json"));
    let mut stale: Option<T> = None;
    if let (Ok(meta), Ok(bytes)) = (tokio::fs::metadata(&file).await, tokio::fs::read(&file).await)
        && let Ok(cached) = serde_json::from_slice::<T>(&bytes)
    {
        // A file stamped well in the future (a restored backup, a clock set back) is not
        // fresh; a few seconds of skew is normal filesystem rounding.
        let fresh = match meta.modified().ok().map(|m| SystemTime::now().duration_since(m)) {
            Some(Ok(age)) => age < max_age,
            Some(Err(ahead)) => ahead.duration() <= Duration::from_secs(5),
            None => false,
        };
        if fresh {
            return Ok(cached);
        }
        stale = Some(cached);
    }

    let value = match load().await {
        Ok(v) => v,
        Err(err) => {
            if let Some(stale) = stale {
                eprintln!("[roblox-devforum-mcp] {name} refresh failed, using the cached copy");
                return Ok(stale);
            }
            return Err(err);
        }
    };
    if let Ok(bytes) = serde_json::to_vec(&value) {
        // Written beside the target and renamed over it, so a reader never sees half a file.
        let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
        let _ = async {
            tokio::fs::create_dir_all(dir).await?;
            tokio::fs::write(&tmp, &bytes).await?;
            tokio::fs::rename(&tmp, &file).await
        }
        .await
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        });
    }
    Ok(value)
}

type Load<T> = Shared<Pin<Box<dyn Future<Output = Result<Arc<T>, Error>> + Send>>>;

/// A load shared by every caller for `ttl`, and forgotten the moment it fails, so one failed
/// first fetch is never replayed for the life of the process.
pub struct Memo<T> {
    ttl: Duration,
    slot: Mutex<Option<(Instant, Load<T>)>>,
}

impl<T: Send + Sync + 'static> Memo<T> {
    pub fn new(ttl: Duration) -> Self {
        Memo { ttl, slot: Mutex::new(None) }
    }

    pub async fn get<F, Fut>(&self, load: F) -> Result<Arc<T>, Error>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, Error>> + Send + 'static,
    {
        let shared = {
            let mut slot = self.slot.lock().unwrap();
            let reusable = match &*slot {
                Some((at, fut)) => at.elapsed() <= self.ttl && !matches!(fut.peek(), Some(Err(_))),
                None => false,
            };
            if !reusable {
                let handle = tokio::spawn(load());
                let fut: Pin<Box<dyn Future<Output = Result<Arc<T>, Error>> + Send>> = Box::pin(async move {
                    match handle.await {
                        Ok(r) => r.map(Arc::new),
                        Err(e) => Err(Error::Msg(format!("load task failed: {e}"))),
                    }
                });
                *slot = Some((Instant::now(), fut.shared()));
            }
            slot.as_ref().unwrap().1.clone()
        };
        shared.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn round_trips_and_reuses_a_fresh_entry() {
        let dir = std::env::temp_dir().join(format!("devforum-cache-test-{}", std::process::id()));
        let calls = AtomicUsize::new(0);
        let load = || async { Ok::<_, Error>(serde_json::json!({ "value": calls.fetch_add(1, Ordering::SeqCst) + 1 })) };
        let a = cached_json(&dir, "probe", Duration::from_secs(60), load).await.unwrap();
        let b = cached_json(&dir, "probe", Duration::from_secs(60), load).await.unwrap();
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let c = cached_json(&dir, "probe", Duration::ZERO, load).await.unwrap();
        assert_eq!(c["value"], 2, "an expired entry reloads");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
