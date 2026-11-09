//! Roblox DevForum (Discourse) API client.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer};

use crate::cache::cached_json;
use crate::categories::Category;
use crate::ctx::{Ctx, SITE_TTL, STATIC_TTL, THREAD_TTL};
use crate::http::{Error, form_encode, uri_component};

/// Discourse ANDs multiple `#category` terms, so the parent category is searched instead.
pub const BUG_PARENT: &str = "bug-reports";
/// The Announcements tag Roblox puts on its weekly "what shipped" digest.
pub const WEEKLY_RECAP_TAG: &str = "weekly-recap";

/* ------------------------------ lenient serde ------------------------------ */

fn null_default<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Tags arrive as strings on most payloads and as `{name: …}` objects on some; both count.
fn lenient_tags<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Tag {
        Name(String),
        Object { name: Option<String> },
        Other(serde::de::IgnoredAny),
    }
    let tags: Option<Vec<Tag>> = Option::deserialize(d)?;
    Ok(tags
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| match t {
            Tag::Name(n) => Some(n),
            Tag::Object { name } => name,
            Tag::Other(_) => None,
        })
        .collect())
}

/* -------------------------------- raw shapes ------------------------------- */

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawTopic {
    pub id: u64,
    #[serde(deserialize_with = "null_default")]
    pub title: String,
    pub slug: Option<String>,
    pub category_id: Option<u64>,
    #[serde(deserialize_with = "lenient_tags")]
    pub tags: Vec<String>,
    pub posts_count: Option<i64>,
    pub reply_count: Option<i64>,
    pub like_count: Option<i64>,
    pub views: Option<i64>,
    pub created_at: Option<String>,
    pub last_posted_at: Option<String>,
    pub bumped_at: Option<String>,
    pub has_accepted_answer: Option<bool>,
    pub pinned: Option<bool>,
    pub pinned_globally: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ActionSummary {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawPost {
    pub id: u64,
    pub post_number: i64,
    pub topic_id: Option<u64>,
    /// 1 regular, 2 moderator action, 3 small action, 4 whisper.
    pub post_type: Option<i64>,
    pub username: Option<String>,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub cooked: Option<String>,
    pub blurb: Option<String>,
    pub accepted_answer: Option<bool>,
    pub like_count: Option<i64>,
    pub staff: Option<bool>,
    pub admin: Option<bool>,
    pub moderator: Option<bool>,
    pub flair_name: Option<String>,
    pub primary_group_name: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub actions_summary: Vec<ActionSummary>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SearchResponse {
    #[serde(deserialize_with = "null_default")]
    pub topics: Vec<RawTopic>,
    #[serde(deserialize_with = "null_default")]
    pub posts: Vec<RawPost>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PostStream {
    #[serde(deserialize_with = "null_default")]
    pub posts: Vec<RawPost>,
    #[serde(deserialize_with = "null_default")]
    pub stream: Vec<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TopicResponse {
    pub id: u64,
    #[serde(deserialize_with = "null_default")]
    pub title: String,
    pub slug: Option<String>,
    pub category_id: Option<u64>,
    #[serde(deserialize_with = "lenient_tags")]
    pub tags: Vec<String>,
    pub posts_count: Option<i64>,
    pub like_count: Option<i64>,
    pub views: Option<i64>,
    pub created_at: Option<String>,
    pub last_posted_at: Option<String>,
    pub bumped_at: Option<String>,
    pub has_accepted_answer: Option<bool>,
    #[serde(deserialize_with = "null_default")]
    pub post_stream: PostStream,
    /// The solved plugin's pointer to the accepted reply, present even when it is off-chunk.
    pub accepted_answer: Option<serde_json::Value>,
}

impl TopicResponse {
    pub fn accepted_post_number(&self) -> Option<i64> {
        self.accepted_answer.as_ref()?.get("post_number")?.as_i64()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct TopicList {
    #[serde(deserialize_with = "null_default")]
    topics: Vec<RawTopic>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ListingResponse {
    #[serde(deserialize_with = "null_default")]
    topic_list: TopicList,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PostsResponse {
    #[serde(deserialize_with = "null_default")]
    post_stream: PostStream,
}

#[derive(Debug, Deserialize)]
struct SiteCategory {
    id: Option<u64>,
    slug: Option<String>,
    name: Option<String>,
    parent_category_id: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SiteJson {
    #[serde(deserialize_with = "null_default")]
    categories: Vec<SiteCategory>,
}

#[derive(Debug, Deserialize)]
struct RawTag {
    name: Option<String>,
    text: Option<String>,
    #[serde(default)]
    count: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct TagsJson {
    #[serde(deserialize_with = "null_default")]
    tags: Vec<RawTag>,
}

/* ---------------------------------- queries --------------------------------- */

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub query: String,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub solved_only: bool,
    pub after: Option<String>,
    /// "relevance" | "latest" | "likes" | "views"
    pub order: Option<&'static str>,
    pub page: u32,
}

/// Build a Discourse advanced-search string. `min_post_likes:` is never sent: the index
/// misapplies it, so the floor is applied to returned posts instead.
pub fn build_search_query(o: &SearchOptions) -> String {
    let mut parts: Vec<String> = vec![o.query.trim().to_string()];
    if let Some(c) = &o.category {
        parts.push(format!("#{c}"));
    }
    if !o.tags.is_empty() {
        parts.push(format!("tags:{}", o.tags.join(",")));
    }
    if o.solved_only {
        parts.push("status:solved".into());
    }
    if let Some(a) = &o.after {
        parts.push(format!("after:{a}"));
    }
    if let Some(order) = o.order.filter(|o| *o != "relevance") {
        parts.push(format!("order:{order}"));
    }
    parts.retain(|p| !p.is_empty());
    parts.join(" ")
}

#[derive(Debug, Clone, Default)]
pub struct SearchResult {
    pub topics: Vec<RawTopic>,
    pub posts: Vec<RawPost>,
}

async fn run_search(ctx: &Ctx, o: &SearchOptions) -> Result<SearchResult, Error> {
    let mut url = format!("{}/search.json?q={}", ctx.cfg.base_url, form_encode(&build_search_query(o)));
    if o.page > 1 {
        url.push_str(&format!("&page={}", o.page));
    }
    let data = ctx.http.get_json::<SearchResponse>(&url, ctx.cfg.search_ttl).await?;
    Ok(SearchResult { topics: data.topics.clone(), posts: data.posts.clone() })
}

/// Run a search, and never let `status:solved` be the reason a call returns nothing: when the
/// index times out on it, the solved filter is applied locally; a timed-out parent category
/// is retried against its children.
pub async fn search(ctx: &Ctx, o: &SearchOptions) -> Result<SearchResult, Error> {
    let err = match run_search(ctx, o).await {
        Ok(r) => return Ok(r),
        Err(e) if !e.is_timeout() => return Err(e),
        Err(e) => e,
    };
    if o.solved_only {
        let relaxed = SearchOptions { solved_only: false, ..o.clone() };
        if let Ok(r) = run_search(ctx, &relaxed).await {
            let topics: Vec<RawTopic> = r.topics.into_iter().filter(|t| t.has_accepted_answer == Some(true)).collect();
            let kept: HashSet<u64> = topics.iter().map(|t| t.id).collect();
            let posts = r.posts.into_iter().filter(|p| p.topic_id.is_none_or(|id| kept.contains(&id))).collect();
            return Ok(SearchResult { topics, posts });
        }
    }
    if let Some(r) = search_sub_categories(ctx, o).await {
        return Ok(r);
    }
    Err(err)
}

/// Re-run a timed-out parent-category search against its children, in parallel, merged
/// round-robin so each topic keeps its rank inside its own category.
async fn search_sub_categories(ctx: &Ctx, o: &SearchOptions) -> Option<SearchResult> {
    let category = o.category.as_ref()?;
    ctx.ensure_categories().await;
    let children = ctx.categories.child_slugs(category);
    if children.is_empty() {
        return None;
    }
    let runs = children.into_iter().map(|c| {
        let opts = SearchOptions { category: Some(c), ..o.clone() };
        async move { run_search(ctx, &opts).await }
    });
    let sets: Vec<SearchResult> = futures_util::future::join_all(runs).await.into_iter().filter_map(Result::ok).collect();
    if sets.is_empty() {
        return None;
    }
    let mut topics = Vec::new();
    let mut seen = HashSet::new();
    let deepest = sets.iter().map(|s| s.topics.len()).max().unwrap_or(0);
    for i in 0..deepest {
        for set in &sets {
            if let Some(t) = set.topics.get(i)
                && seen.insert(t.id)
            {
                topics.push(t.clone());
            }
        }
    }
    let mut posts = Vec::new();
    let mut seen_posts = HashSet::new();
    for set in sets {
        for p in set.posts {
            if seen_posts.insert(p.id) {
                posts.push(p);
            }
        }
    }
    Some(SearchResult { topics, posts })
}

pub async fn get_topic(ctx: &Ctx, topic_id: u64) -> Result<std::sync::Arc<TopicResponse>, Error> {
    ctx.http.get_json(&format!("{}/t/{topic_id}.json", ctx.cfg.base_url), THREAD_TTL).await
}

/// Posts of a topic by id (Discourse caps this at ~20 per call).
pub async fn get_posts_by_ids(ctx: &Ctx, topic_id: u64, ids: &[u64]) -> Result<Vec<RawPost>, Error> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let query: Vec<String> = ids.iter().map(|id| format!("post_ids%5B%5D={id}")).collect();
    let url = format!("{}/t/{topic_id}/posts.json?{}", ctx.cfg.base_url, query.join("&"));
    let data = ctx.http.get_json::<PostsResponse>(&url, THREAD_TTL).await?;
    Ok(data.post_stream.posts.clone())
}

/// One post by its position in the thread, wherever it sits in the stream.
pub async fn get_post_by_number(ctx: &Ctx, topic_id: u64, n: i64) -> Result<std::sync::Arc<RawPost>, Error> {
    ctx.http.get_json(&format!("{}/posts/by_number/{topic_id}/{n}.json", ctx.cfg.base_url), THREAD_TTL).await
}

pub async fn list_topics(
    ctx: &Ctx,
    listing: &str,
    category: Option<&str>,
    tag: Option<&str>,
    period: Option<&str>,
    page: u32,
) -> Result<Vec<RawTopic>, Error> {
    // The id in a category path has to be the live one, or Discourse serves another category.
    if category.is_some() {
        ctx.ensure_categories().await;
    }
    let path = match (tag, category) {
        (Some(t), Some(c)) => format!("/tags/c/{}/{}/l/{listing}.json", ctx.categories.path_of(c), uri_component(t)),
        (Some(t), None) => format!("/tag/{}/l/{listing}.json", uri_component(t)),
        (None, Some(c)) => format!("/c/{}/l/{listing}.json", ctx.categories.path_of(c)),
        (None, None) => format!("/{listing}.json"),
    };
    let mut params = Vec::new();
    if listing == "top"
        && let Some(p) = period
    {
        params.push(format!("period={}", form_encode(p)));
    }
    if page > 0 {
        params.push(format!("page={page}"));
    }
    let url =
        if params.is_empty() { format!("{}{path}", ctx.cfg.base_url) } else { format!("{}{path}?{}", ctx.cfg.base_url, params.join("&")) };
    let data = ctx.http.get_json::<ListingResponse>(&url, ctx.cfg.search_ttl).await?;
    Ok(data.topic_list.topics.iter().filter(|t| !is_category_definition(t)).cloned().collect())
}

static ABOUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^About the .+ category$").unwrap());

/// The "About the … category" topic pinned atop every listing. Other pins stay: Roblox pins
/// the current Weekly Recap globally.
pub fn is_category_definition(t: &RawTopic) -> bool {
    t.pinned == Some(true) && ABOUT.is_match(t.title.trim())
}

pub async fn list_tags(ctx: &Ctx) -> Result<Vec<(String, i64)>, Error> {
    let data = ctx.http.get_json::<TagsJson>(&format!("{}/tags.json", ctx.cfg.base_url), STATIC_TTL).await?;
    let mut tags: Vec<(String, i64)> =
        data.tags.iter().filter_map(|t| t.name.clone().or_else(|| t.text.clone()).map(|n| (n, t.count.unwrap_or(0)))).collect();
    tags.sort_by_key(|t| std::cmp::Reverse(t.1));
    Ok(tags)
}

/// One cache file per forum, so a DEVFORUM_BASE_URL override never reads the wrong tree.
fn categories_cache_key(base: &str) -> String {
    let host = base.trim_start_matches("https://").trim_start_matches("http://");
    let mut key = String::from("categories-");
    let mut dash = false;
    for ch in host.chars() {
        if ch.is_ascii_alphanumeric() {
            key.push(ch);
            dash = false;
        } else if !dash {
            key.push('-');
            dash = true;
        }
    }
    key
}

pub async fn fetch_categories(ctx: &Ctx) -> Result<Vec<Category>, Error> {
    let key = categories_cache_key(&ctx.cfg.base_url);
    cached_json(&ctx.cfg.cache_dir, &key, SITE_TTL, || async {
        let data: SiteJson = ctx.http.fetch_json(&format!("{}/site.json", ctx.cfg.base_url), crate::http::JSON).await?;
        let raw: Vec<(u64, String, Option<String>, Option<u64>)> = data
            .categories
            .into_iter()
            .filter_map(|c| Some((c.id?, c.slug.filter(|s| !s.is_empty())?, c.name, c.parent_category_id)))
            .collect();
        if raw.is_empty() {
            return Err(Error::Msg("site.json listed no categories".into()));
        }
        let slug_of: std::collections::HashMap<u64, String> = raw.iter().map(|c| (c.0, c.1.clone())).collect();
        Ok(raw
            .into_iter()
            .map(|(id, slug, name, parent)| Category { id, slug, name, parent: parent.and_then(|p| slug_of.get(&p).cloned()) })
            .collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_query_syntax() {
        let q = build_search_query(&SearchOptions {
            query: "DataStore 502".into(),
            category: Some("engine-bugs".into()),
            tags: vec!["datastore".into()],
            solved_only: true,
            after: Some("2025-01-01".into()),
            order: Some("latest"),
            page: 0,
        });
        assert_eq!(q, "DataStore 502 #engine-bugs tags:datastore status:solved after:2025-01-01 order:latest");
        assert_eq!(
            build_search_query(&SearchOptions { query: "raycast".into(), order: Some("relevance"), ..Default::default() }),
            "raycast"
        );
    }

    #[test]
    fn only_the_definition_topic_is_dropped() {
        let t = |title: &str, pinned| RawTopic { title: title.into(), pinned: Some(pinned), ..Default::default() };
        assert!(is_category_definition(&t("About the Announcements category", true)));
        assert!(!is_category_definition(&t("Weekly Recap: September 21 - 25, 2026", true)));
        assert!(!is_category_definition(&t("About the Announcements category", false)));
    }

    #[test]
    fn lenient_payloads() {
        let t: RawTopic = serde_json::from_str(r#"{"id":1,"title":null,"tags":[{"name":"a"},"b"],"extra":{"x":1}}"#).unwrap();
        assert_eq!(t.tags, ["a", "b"]);
        assert_eq!(t.title, "");
    }
}
