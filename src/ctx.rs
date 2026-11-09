//! Process-wide state every tool shares: config, network, category tree, docs indexes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::cache::Memo;
use crate::categories::Categories;
use crate::config::Config;
use crate::docs::{DocsTree, DumpIndex};
use crate::http::{Error, Http, ReqwestTransport, Transport};

pub const SITE_TTL: Duration = Duration::from_secs(86_400);
/// After a failed category fetch, serve the fallback rather than retry on every call.
const CATEGORY_RETRY_AFTER: Duration = Duration::from_secs(300);
pub const STATIC_TTL: Duration = Duration::from_secs(86_400);
pub const THREAD_TTL: Duration = Duration::from_secs(900);

#[derive(Default)]
struct CategoryLoad {
    loaded_at: Option<Instant>,
    failed_at: Option<Instant>,
}

pub struct Ctx {
    pub cfg: Arc<Config>,
    pub http: Http,
    pub categories: Categories,
    category_load: tokio::sync::Mutex<CategoryLoad>,
    pub docs_tree: Memo<DocsTree>,
    pub dump: Memo<DumpIndex>,
}

impl Ctx {
    pub fn new(cfg: Config, transport: Arc<dyn Transport>) -> Self {
        let cfg = Arc::new(cfg);
        Ctx {
            http: Http::new(transport, cfg.clone()),
            cfg,
            categories: Categories::default(),
            category_load: tokio::sync::Mutex::default(),
            docs_tree: Memo::new(crate::docs::TREE_TTL),
            dump: Memo::new(crate::docs::DUMP_TTL),
        }
    }

    pub fn from_env() -> Result<Self, Error> {
        let cfg = Config::from_env();
        let transport = Arc::new(ReqwestTransport::new(&cfg)?);
        Ok(Ctx::new(cfg, transport))
    }

    pub fn topic_url(&self, id: u64, slug: Option<&str>, post_number: Option<i64>) -> String {
        let mut url = match slug.filter(|s| !s.is_empty()) {
            Some(slug) => format!("{}/t/{slug}/{id}", self.cfg.base_url),
            None => format!("{}/t/{id}", self.cfg.base_url),
        };
        if let Some(n) = post_number.filter(|n| *n > 1) {
            url.push_str(&format!("/{n}"));
        }
        url
    }

    /// Make sure the live category tree has been fetched once. Never fails: a forum that is
    /// down leaves the shipped fallback in place.
    pub async fn ensure_categories(&self) {
        let mut state = self.category_load.lock().await;
        if state.loaded_at.is_some_and(|t| t.elapsed() < SITE_TTL) {
            return;
        }
        if state.failed_at.is_some_and(|t| t.elapsed() < CATEGORY_RETRY_AFTER) {
            return;
        }
        match crate::discourse::fetch_categories(self).await {
            Ok(live) => {
                self.categories.merge_live(live);
                state.loaded_at = Some(Instant::now());
                state.failed_at = None;
            }
            Err(_) => state.failed_at = Some(Instant::now()),
        }
    }
}
