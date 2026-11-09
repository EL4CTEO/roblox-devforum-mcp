//! Tool registry: definitions (name, schema, annotations) and dispatch.

pub mod api;
pub mod forum;
pub mod updates;

use std::sync::Arc;

use serde_json::{Value, json};

use crate::args::TopicRef;
use crate::ctx::Ctx;
use crate::http::{Error, host_of};

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

pub fn ok(text: impl Into<String>) -> ToolResult {
    ToolResult { text: text.into(), is_error: false }
}

pub fn fail(text: impl Into<String>) -> ToolResult {
    ToolResult { text: text.into(), is_error: true }
}

/// Turn any error into a readable, non-fatal tool error that names the lever to pull.
pub fn to_tool_error(ctx: &Ctx, context: &str, err: &Error) -> ToolResult {
    match err {
        Error::Timeout { .. } => fail(format!(
            "{context}: {err}. The DevForum's search index is slow for some filter combinations — retry with fewer words, or drop one filter (tags, category, solved_only)."
        )),
        Error::Http { status: 404, .. } => fail(format!("{context}: not found (404). Check the id or path.")),
        // The forum answers 403 for a topic anonymous readers cannot see; GitHub for a spent rate limit.
        Error::Http { status: 403, url } if host_of(url) == host_of(&ctx.cfg.base_url) => fail(format!(
            "{context}: the DevForum refused access (403) — it is private or restricted to signed-in members. Pick another thread."
        )),
        Error::Http { status: s @ (403 | 429), .. } => {
            fail(format!("{context}: rate limited by the upstream service ({s}). Retry shortly."))
        }
        Error::Http { status, .. } => fail(format!("{context}: upstream returned HTTP {status}.")),
        other => fail(format!("{context}: {other}")),
    }
}

/// The topic id and post number a reference names: a raw id, a DevForum URL ("/t/slug/123",
/// "/t/slug/123/45", the short "/t/123/45"), or a "slug/123" fragment.
pub fn parse_topic_ref(input: &TopicRef) -> (Option<u64>, Option<i64>) {
    let text = match input {
        TopicRef::Id(n) => return (u64::try_from(*n).ok().filter(|n| *n > 0), None),
        TopicRef::Text(s) => s,
    };
    let trimmed = text.trim();
    let trimmed = trimmed.split(['?', '#']).next().unwrap_or("");
    let path = trimmed.find("/t/").map_or(trimmed, |at| &trimmed[at + 3..]);
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let numeric = |s: Option<&&str>| s.filter(|s| s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse::<u64>().ok());
    let start = if numeric(segments.first()).is_some() { 0 } else { 1 };
    match numeric(segments.get(start)) {
        Some(id) if id > 0 => (Some(id), numeric(segments.get(start + 1)).map(|n| n as i64)),
        _ => (None, None),
    }
}

/* ------------------------------- definitions ------------------------------- */

const READ_ONLY: fn() -> Value = || json!({ "readOnlyHint": true, "openWorldHint": true, "destructiveHint": false });

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    json!({ "name": name, "title": title, "description": description, "inputSchema": schema, "annotations": READ_ONLY() })
}

fn int(min: i64, max: i64, default: i64, description: Option<&str>) -> Value {
    let mut v = json!({ "type": "integer", "minimum": min, "maximum": max, "default": default });
    if let Some(d) = description {
        v["description"] = json!(d);
    }
    v
}

fn date(description: &str) -> Value {
    json!({ "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": description })
}

fn query_schema() -> Value {
    json!({
        "anyOf": [
            { "type": "string", "minLength": 2 },
            { "type": "array", "items": { "type": "string", "minLength": 2 }, "minItems": 1, "maxItems": 5 }
        ],
        "description": "Search text, or an array of up to 5 phrasings run in parallel and merged. Multiple phrasings are the fast way to cover a problem: [\"DataStore 502\", \"API Services rejected request\", \"datastore timeout\"]. Topics found by more than one phrasing rank highest."
    })
}

fn topic_schema(description: &str) -> Value {
    json!({ "anyOf": [{ "type": "integer" }, { "type": "string" }], "description": description })
}

pub fn definitions() -> Vec<Value> {
    let slugs = crate::categories::default_slugs();
    vec![
        tool(
            "search_devforum",
            "Search the Roblox DevForum",
            "Full-text search across the Roblox Developer Forum. Use this first when a Roblox bug, error message, or engine behaviour needs community context: paste the literal error string (e.g. \"502: API Services rejected request\") or a symptom description. Results are re-ranked to favour solved and recent threads. Follow up with get_thread on the topic_id you want to read.",
            json!({
                "query": query_schema(),
                "category": { "type": "string", "minLength": 2, "description": format!("Restrict to one category slug, e.g. scripting-support, engine-bugs, release-notes. Known slugs: {slugs}. Any slug list_categories reports also works.") },
                "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 5, "description": "Restrict to DevForum tags, e.g. [\"datastore\"]." },
                "solved_only": { "type": "boolean", "default": false, "description": "Only threads with an accepted answer." },
                "min_likes": { "type": "integer", "minimum": 0, "maximum": 500, "description": "Minimum likes on a matching post." },
                "after": date("Only threads active after this date (YYYY-MM-DD)."),
                "order": { "type": "string", "enum": ["relevance", "latest", "likes", "views"], "default": "relevance" },
                "limit": int(1, 25, 8, None),
                "max_tokens": int(200, 8000, 2500, Some("Approximate output budget.")),
            }),
            &["query"],
        ),
        tool(
            "search_bugs",
            "Search Roblox bug reports",
            "Search only the DevForum bug-report categories (engine, Studio, cloud services, mobile, website, Creator Hub, purchasing). Use this to answer \"is this a known Roblox bug or is it my code?\" — a hit means somebody reported the same symptom, with its category, last-activity date and whether a reply was marked as the solution. Roblox does not tag reports with a public triage state, so read the thread with get_thread to see whether staff actually answered.",
            json!({
                "query": query_schema(),
                "area": { "type": "string", "minLength": 2, "description": "Narrow to a single bug category slug, e.g. engine-bugs, studio-bugs, cloud-services-bugs, mobile-bugs, website-bugs, creator-hub-bugs, purchasing-bugs, documentation-issues. Defaults to every bug category." },
                "after": date("Only reports active after this date (YYYY-MM-DD)."),
                "limit": int(1, 25, 8, None),
                "max_tokens": int(200, 8000, 2500, None),
            }),
            &["query"],
        ),
        tool(
            "get_thread",
            "Read a DevForum thread",
            "Read a DevForum topic as Markdown: the original post plus the most useful replies, with the accepted answer hoisted to the top. Accepts a topic id or a full DevForum URL. Code blocks are preserved. Use get_replies to page through the rest.",
            json!({
                "topic": topic_schema("Topic id (e.g. 3665478) or DevForum URL. Also accepted as topic_id."),
                "topic_id": topic_schema("Alias for topic."),
                "max_posts": int(1, 30, 8, Some("How many posts to include.")),
                "max_tokens": int(300, 12000, 3500, None),
            }),
            &[],
        ),
        tool(
            "get_replies",
            "Page through thread replies",
            "Fetch a page of replies from a DevForum topic in post order. Use after get_thread when the answer is buried further down a long thread.",
            json!({
                "topic": topic_schema("Topic id (e.g. 3665478) or DevForum URL. Also accepted as topic_id."),
                "topic_id": topic_schema("Alias for topic."),
                "page": { "type": "integer", "minimum": 1, "default": 1, "description": "1-based page of replies." },
                "limit": int(1, 20, 10, None),
                "max_tokens": int(300, 12000, 3000, None),
            }),
            &[],
        ),
        tool(
            "list_recent",
            "List recent or top DevForum topics",
            "Browse a category or tag without a search query. Use release-notes / announcements to check whether a recent Roblox update explains a regression, or scripting-support to see what is breaking for others right now.",
            json!({
                "category": { "type": "string", "minLength": 2, "description": format!("Category slug, e.g. release-notes, announcements, engine-bugs. Known slugs: {slugs}. Any slug list_categories reports also works.") },
                "tag": { "type": "string", "description": "Tag name instead of a category, e.g. datastore." },
                "listing": { "type": "string", "enum": ["latest", "top"], "default": "latest" },
                "period": { "type": "string", "enum": ["daily", "weekly", "monthly", "quarterly", "yearly", "all"], "default": "monthly", "description": "Only used when listing is \"top\"." },
                "limit": int(1, 30, 10, None),
                "max_tokens": int(200, 8000, 2000, None),
            }),
            &[],
        ),
        tool(
            "list_categories",
            "List DevForum categories and tags",
            "List the DevForum category tree and the most-used tags. Call this when you are unsure which category or tag slug to pass to search_devforum, search_bugs, or list_recent.",
            json!({
                "include_tags": { "type": "boolean", "default": true },
                "tag_limit": int(5, 100, 40, None),
            }),
            &[],
        ),
        tool(
            "search_creator_docs",
            "Search official Roblox documentation",
            "Find and read pages from Roblox's official creator documentation (create.roblox.com/docs). Call with `query` to list matching pages, then call again with `path` from a result to read that page in full. Use this for intended behaviour, limits and quotas, and guide-level explanations — pair it with search_devforum for what actually happens in production.",
            json!({
                "query": { "type": "string", "description": "What to look for, e.g. \"data store limits\" or \"ProximityPrompt\"." },
                "path": { "type": "string", "description": "Repo path from a previous result, e.g. content/en-us/cloud-services/data-stores/index.md, or a create.roblox.com/docs URL. Returns the full page." },
                "limit": int(1, 25, 10, None),
                "max_tokens": int(300, 12000, 3000, None),
            }),
            &[],
        ),
        tool(
            "get_engine_api",
            "Look up the Roblox engine API",
            "Authoritative signature lookup from the live Roblox API dump: a class's properties, methods, events and callbacks with parameter types, security level, deprecation and thread safety. Use this to confirm a method exists, check whether it is deprecated or server-only, or find the right member name before writing Luau.",
            json!({
                "name": { "type": "string", "minLength": 2, "description": "Class name (e.g. DataStoreService, Humanoid), Enum name (e.g. RaycastFilterType), datatype (Vector3), Luau library or global (task, wait), or a single member as \"Humanoid.LoadAnimation\" / \"task.wait\", which narrows the lookup to that member." },
                "filter": { "type": "string", "description": "Only members whose name contains this substring." },
                "member_types": { "type": "array", "items": { "type": "string", "enum": ["Property", "Function", "Event", "Callback"] }, "description": "Restrict to these member kinds." },
                "include_inherited": { "type": "boolean", "default": false, "description": "Include members inherited from superclasses." },
                "max_tokens": int(300, 12000, 3000, None),
            }),
            &["name"],
        ),
        tool(
            "check_api_health",
            "Check Roblox APIs for deprecation",
            "Batch-check Roblox APIs before you ship Luau that uses them. Pass entries like \"Humanoid.MoveTo\", \"BodyVelocity\", \"Enum.Material.Neon\", \"task.wait\" or \"wait\" and each is verified against the live API dump and the official docs: does it still exist, is it spelled with the right case, is it deprecated (with the official replacement where the docs give one), is it locked behind a security level normal scripts cannot use, and does it yield. Use this whenever you are about to write or review Roblox code — models often reproduce APIs that Roblox retired years ago.",
            json!({
                "members": { "type": "array", "items": { "type": "string", "minLength": 2 }, "minItems": 1, "maxItems": 25, "description": "Entries to check: \"ClassName\", \"ClassName.MemberName\", or an expression copied from code, e.g. [\"BodyVelocity\", \"Humanoid.MoveTo\", \"game.Players.LocalPlayer.Character\", \"Instance.new(\\\"Part\\\").Anchored\"]." },
                "max_tokens": int(300, 12000, 2500, None),
            }),
            &["members"],
        ),
        tool(
            "get_whats_new",
            "What Roblox shipped recently",
            "A digest of recent Roblox platform changes: the official Weekly Recap, engine Release Notes, and Announcements. Use this when a game regressed for no obvious reason (\"this worked last week\"), when checking whether a Roblox update explains new behaviour, or when the user asks what is new on the platform. Returns the latest Weekly Recap body plus everything else published inside the time window.",
            json!({
                "days": int(1, 120, 14, Some("How far back to look, in days.")),
                "include_recap_body": { "type": "boolean", "default": true, "description": "Include the text of the newest Weekly Recap, not just its link." },
                "limit": int(1, 30, 8, Some("Maximum items per section.")),
                "max_tokens": int(300, 12000, 3500, None),
            }),
            &[],
        ),
        tool(
            "get_weekly_recap",
            "Read a Roblox Weekly Recap",
            "Read any Roblox Weekly Recap, current or historical. Roblox publishes one every Friday summarising what shipped that week: betas, engine updates, Marketplace and Studio changes. Use `week` to step back through the archive (0 = newest, 1 = the week before, …), `before` to jump to the recap covering a past date, or `list` to see the archive index. To find when a specific feature or regression landed, list the archive and read the recaps around that date.",
            json!({
                "week": int(0, 120, 0, Some("How many weeks back, 0 = most recent recap.")),
                "before": date("Read the newest recap published on or before this date (YYYY-MM-DD). Overrides `week`."),
                "list": { "type": "boolean", "default": false, "description": "Return the archive index instead of a recap body." },
                "limit": int(1, 60, 20, Some("Archive entries to list when `list` is true.")),
                "max_tokens": int(300, 12000, 4000, None),
            }),
            &[],
        ),
    ]
}

/// Run a tool; `None` when no tool has that name.
pub async fn call(ctx: &Arc<Ctx>, name: &str, args: Option<&Value>) -> Option<ToolResult> {
    Some(match name {
        "search_devforum" => forum::search_devforum(ctx, args).await,
        "search_bugs" => forum::search_bugs(ctx, args).await,
        "get_thread" => forum::get_thread(ctx, args).await,
        "get_replies" => forum::get_replies(ctx, args).await,
        "list_recent" => forum::list_recent(ctx, args).await,
        "list_categories" => forum::list_categories(ctx, args).await,
        "search_creator_docs" => api::search_creator_docs(ctx, args).await,
        "get_engine_api" => api::get_engine_api(ctx, args).await,
        "check_api_health" => api::check_api_health(ctx, args).await,
        "get_whats_new" => updates::get_whats_new(ctx, args).await,
        "get_weekly_recap" => updates::get_weekly_recap(ctx, args).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> TopicRef {
        TopicRef::Text(s.into())
    }

    #[test]
    fn topic_references() {
        assert_eq!(parse_topic_ref(&TopicRef::Id(4756879)).0, Some(4756879));
        assert_eq!(parse_topic_ref(&text(" 4756879 ")).0, Some(4756879));
        assert_eq!(parse_topic_ref(&text("https://devforum.roblox.com/t/datastore-502/3665478/7")), (Some(3665478), Some(7)));
        assert_eq!(parse_topic_ref(&text("/t/3665478")).0, Some(3665478));
        assert_eq!(parse_topic_ref(&text("not a topic")).0, None);
        assert_eq!(parse_topic_ref(&text("https://devforum.roblox.com/t/123/45")), (Some(123), Some(45)));
        assert_eq!(parse_topic_ref(&text("https://devforum.roblox.com/t/2024-roadmap/987?u=someone")), (Some(987), None));
        assert_eq!(parse_topic_ref(&text("some-slug/321")).0, Some(321));
        assert_eq!(parse_topic_ref(&TopicRef::Id(0)).0, None);
        assert_eq!(parse_topic_ref(&TopicRef::Id(-5)).0, None);
        assert_eq!(parse_topic_ref(&text("https://devforum.roblox.com/t/slug/0")).0, None);
    }

    #[test]
    fn errors_name_the_lever() {
        let ctx = Ctx::new(crate::Config::defaults(), Arc::new(crate::http::Offline));
        let forum = to_tool_error(&ctx, "x", &Error::Http { status: 403, url: "https://devforum.roblox.com/t/5.json".into() });
        assert!(forum.text.contains("private or restricted"));
        let gh = to_tool_error(&ctx, "x", &Error::Http { status: 403, url: "https://api.github.com/repos/a/b".into() });
        assert!(gh.text.contains("rate limited"));
    }
}
