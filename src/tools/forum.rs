//! DevForum tools: search, bug lookup, thread reading, category listings.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use super::{ToolResult, fail, ok, parse_topic_ref, to_tool_error};
use crate::args::{Args, TopicRef};
use crate::ctx::Ctx;
use crate::discourse::{self, BUG_PARENT, RawPost, RawTopic, SearchOptions, TopicResponse};
use crate::format::{decode_entities, html_to_markdown, plural, plural_with, relative_date, truncate};
use crate::http::Error;
use crate::rank::{self, Merged, SearchSet, bug_status, likes_of, post_likes, reply_count};
use crate::time;

/// Validate a caller-supplied slug against the live tree; returns the canonical slug.
async fn resolve_slug(ctx: &Ctx, slug: Option<&str>) -> Result<Option<String>, String> {
    let Some(slug) = slug else { return Ok(None) };
    ctx.ensure_categories().await;
    if let Some(found) = ctx.categories.resolve(slug) {
        return Ok(Some(found.slug));
    }
    let near = ctx.categories.suggest(slug, 3);
    let hint = if near.is_empty() { String::new() } else { format!(" Did you mean {}?", near.join(", ")) };
    Err(format!("Unknown category \"{slug}\".{hint} Call list_categories for the current list."))
}

/// The topic a call names, under either spelling (`topic` or `topic_id`).
fn topic_arg(topic: Option<TopicRef>, alias: Option<TopicRef>) -> Result<(TopicRef, u64), ToolResult> {
    let asked = topic.or(alias);
    match &asked {
        None => Err(fail("Pass the thread as topic (a topic id or a DevForum URL); topic_id is accepted too.")),
        Some(r) => match parse_topic_ref(r).0 {
            Some(id) => Ok((r.clone(), id)),
            None => Err(fail(format!("Could not read a topic id from \"{r}\"."))),
        },
    }
}

fn topic_line(ctx: &Ctx, index: usize, topic: &RawTopic, post: Option<&RawPost>, matched_by: Option<&Vec<String>>) -> String {
    let badge = bug_status(&topic.tags, topic.has_accepted_answer == Some(true)).map_or(String::new(), |s| format!("[{}] ", s.label));
    // Search payloads carry no topic like_count, so say the number is the matched post's.
    let likes = if topic.like_count.is_none() && post.is_some() {
        format!("{} on the matched post", plural(likes_of(topic, post), "like"))
    } else {
        plural(likes_of(topic, post), "like")
    };
    let mut meta = vec![
        format!("#{}", ctx.categories.name_of(topic.category_id)),
        likes,
        plural_with(reply_count(topic), "reply", "replies"),
        relative_date(topic.bumped_at.as_deref().or(topic.last_posted_at.as_deref()).or(topic.created_at.as_deref())),
    ];
    if !topic.tags.is_empty() {
        meta.push(topic.tags.iter().take(4).cloned().collect::<Vec<_>>().join(", "));
    }
    if let Some(m) = matched_by.filter(|m| m.len() > 1) {
        meta.push(format!("matched {} phrasings", m.len()));
    }
    if topic.pinned == Some(true) || topic.pinned_globally == Some(true) {
        meta.push("pinned".into());
    }
    let mut out = format!(
        "{index}. {badge}{}\n   {}\n   {}  (topic_id: {})",
        topic.title,
        meta.join(" · "),
        ctx.topic_url(topic.id, topic.slug.as_deref(), None),
        topic.id
    );
    if let Some(post) = post
        && let Some(blurb) = post.blurb.as_deref().filter(|b| !b.is_empty())
    {
        let from = if post.post_number > 1 { format!("reply #{}: ", post.post_number) } else { String::new() };
        let text: String = decode_entities(blurb).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(260).collect();
        out.push_str(&format!("\n   {from}{text}"));
    }
    out
}

/// Bot notices and small actions: nothing a debugging agent can use.
pub fn is_automated(post: &RawPost) -> bool {
    if post.post_type == Some(3) {
        return true;
    }
    if post.cooked.as_deref().is_some_and(|c| c.trim().is_empty()) {
        return true;
    }
    if post.username.as_deref() != Some("system") {
        return false;
    }
    let cooked = post.cooked.as_deref().unwrap_or("").to_lowercase();
    cooked.contains("this topic was automatically")
        || ["closed", "deleted", "opened", "bumped"].iter().any(|v| cooked.contains(&format!("automatically {v}")))
}

/// The DevForum group every Roblox employee account belongs to.
const STAFF_GROUP: &str = "Roblox_Staff";

/// Discourse's staff flags, or the Roblox_Staff group engineers post under; never the bot.
pub fn is_roblox_staff(post: &RawPost) -> bool {
    if post.username.as_deref() == Some("system") {
        return false;
    }
    post.staff == Some(true)
        || post.admin == Some(true)
        || post.moderator == Some(true)
        || post.primary_group_name.as_deref() == Some(STAFF_GROUP)
        || post.flair_name.as_deref() == Some(STAFF_GROUP)
}

/// Who wrote it, as far as a reader can act on (trust level is deliberately not used).
pub fn author_badge(post: &RawPost) -> String {
    if is_roblox_staff(post) {
        return "Roblox staff".into();
    }
    post.flair_name.clone().unwrap_or_default()
}

/// Smallest slice that still leaves a post worth reading.
const PER_POST_FLOOR: usize = 120;

fn render_post(ctx: &Ctx, post: &RawPost, topic_id: u64, slug: Option<&str>, budget: usize) -> String {
    let author = post.username.as_deref().or(post.name.as_deref()).unwrap_or("unknown");
    let badge = author_badge(post);
    let role = if badge.is_empty() { String::new() } else { format!(" ({badge})") };
    let accepted = if post.accepted_answer == Some(true) { " ✅ ACCEPTED ANSWER" } else { "" };
    let likes = post_likes(post);
    let likes = if likes > 0 { format!(" · {}", plural(likes, "like")) } else { String::new() };
    let header = format!("--- #{} by {author}{role}{accepted} · {}{likes}", post.post_number, relative_date(post.created_at.as_deref()));
    let body = html_to_markdown(post.cooked.as_deref().unwrap_or(""), post.post_number == 1);
    let url = ctx.topic_url(topic_id, slug, Some(post.post_number));
    format!("{header}\n{}", truncate(&body, budget, &format!("open {url}")))
}

/// Render posts inside a token budget: the budget decides how many whole posts fit.
pub fn render_within(ctx: &Ctx, posts: &[&RawPost], topic_id: u64, slug: Option<&str>, budget: usize, hint: &str) -> (String, usize) {
    let kept = &posts[..posts.len().min((budget / PER_POST_FLOOR).max(1))];
    let per_post = (budget / kept.len().max(1)).max(PER_POST_FLOOR);
    let body: Vec<String> = kept.iter().map(|p| render_post(ctx, p, topic_id, slug, per_post)).collect();
    (truncate(&body.join("\n\n"), budget, hint), kept.len())
}

/// Run every phrasing at once and merge; a phrasing that fails is reported, not fatal.
async fn run_queries(ctx: &Ctx, queries: &[String], base: &SearchOptions) -> Result<(Merged, Vec<String>), Error> {
    let runs = queries.iter().map(|q| {
        let opts = SearchOptions { query: q.clone(), ..base.clone() };
        async move { discourse::search(ctx, &opts).await }
    });
    let settled = futures_util::future::join_all(runs).await;
    let mut sets = Vec::new();
    let mut failed = Vec::new();
    let mut first_err = None;
    for (q, r) in queries.iter().zip(settled) {
        match r {
            Ok(r) => sets.push(SearchSet { query: q.clone(), topics: r.topics, posts: r.posts }),
            Err(e) => {
                failed.push(q.clone());
                first_err.get_or_insert(e);
            }
        }
    }
    if sets.is_empty()
        && let Some(e) = first_err
    {
        return Err(e);
    }
    Ok((rank::merge_results(sets), failed))
}

/// A phrasing in quotes, unless it already is one.
fn quoted(q: &str) -> String {
    let t = q.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') { t.to_string() } else { format!("\"{q}\"") }
}

fn skipped_note(failed: &[String]) -> String {
    if failed.is_empty() {
        return String::new();
    }
    let list: Vec<String> = failed.iter().map(|q| quoted(q)).collect();
    format!(" ({} could not be searched and {} skipped)", list.join(", "), if failed.len() == 1 { "was" } else { "were" })
}

fn dedupe(list: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    list.into_iter().filter(|q| seen.insert(q.clone())).collect()
}

/// The filters a call actually set, named, so an empty result says which one to loosen.
pub fn active_filters(category: Option<&str>, area: Option<&str>, tags: &[String], solved_only: bool, after: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(c) = category {
        out.push(format!("category {c}"));
    }
    if let Some(a) = area {
        out.push(format!("in {a}"));
    }
    if !tags.is_empty() {
        out.push(format!("tags {}", tags.join(",")));
    }
    if solved_only {
        out.push("solved_only".into());
    }
    if let Some(a) = after {
        out.push(format!("active after {a}"));
    }
    out
}

/// A symptom sentence trimmed to its two most distinctive words, for a retry after nothing matched.
pub fn broaden(query: &str) -> Option<String> {
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '\'' || *c == '-').collect::<String>())
        .filter(|w| !w.is_empty())
        .collect();
    let kept: Vec<&String> = words.iter().filter(|w| !rank::is_filler(&w.to_lowercase())).collect();
    if kept.len() < 3 {
        return None;
    }
    let mut by_len = kept.clone();
    by_len.sort_by_key(|w| std::cmp::Reverse(w.chars().count()));
    let distinctive: HashSet<&String> = by_len.into_iter().take(2).collect();
    let trimmed = kept.iter().filter(|w| distinctive.contains(*w)).map(|w| w.as_str()).collect::<Vec<_>>().join(" ");
    (!trimmed.is_empty() && trimmed != query.trim()).then_some(trimmed)
}

/// An `after` date that is no date, or still to come, can match nothing.
pub fn future_date(after: Option<&str>) -> Option<String> {
    let after = after?;
    if !time::is_real_date(after) {
        return Some(format!("\"{after}\" is not a real date — use YYYY-MM-DD."));
    }
    let today = time::today();
    (after > today.as_str()).then(|| format!("after {after} is in the future, so nothing can match it (today is {today}). Check the year."))
}

/// The min_likes floor, applied to the posts the search returned.
fn apply_min_likes(topics: Vec<RawTopic>, posts: &[RawPost], min_likes: Option<i64>) -> Vec<RawTopic> {
    let Some(min) = min_likes.filter(|m| *m > 0) else { return topics };
    let mut best: HashMap<u64, i64> = HashMap::new();
    for p in posts {
        if let Some(t) = p.topic_id {
            let e = best.entry(t).or_insert(0);
            *e = (*e).max(post_likes(p));
        }
    }
    topics.into_iter().filter(|t| t.like_count.unwrap_or(0).max(best.get(&t.id).copied().unwrap_or(0)) >= min).collect()
}

fn label(queries: &[String]) -> String {
    queries.iter().map(|q| quoted(q)).collect::<Vec<_>>().join(" / ")
}

pub async fn search_devforum(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let queries = a.string_or_list("query", 2, 5);
    let category = a.string("category", 2);
    let tags = a.strings("tags", 0, 0, Some(5)).unwrap_or_default();
    let solved_only = a.boolean("solved_only", false);
    let min_likes = a.int_opt("min_likes", 0, Some(500));
    let after = a.date("after");
    let order = a.choice("order", &["relevance", "latest", "likes", "views"], "relevance");
    let limit = a.int("limit", 8, 1, Some(25)) as usize;
    let max_tokens = a.int("max_tokens", 2500, 200, Some(8000)) as usize;
    if let Err(e) = a.finish("search_devforum") {
        return fail(e);
    }
    let queries = dedupe(queries.unwrap_or_default());

    if let Some(msg) = future_date(after.as_deref()) {
        return fail(msg);
    }
    let category = match resolve_slug(ctx, category.as_deref()).await {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let base = SearchOptions {
        category: category.clone(),
        tags: tags.clone(),
        solved_only,
        after: after.clone(),
        order: Some(order),
        ..Default::default()
    };
    let (merged, failed) = match run_queries(ctx, &queries, &base).await {
        Ok(r) => r,
        Err(e) => return to_tool_error(ctx, "search_devforum failed", &e),
    };
    let Merged { topics, posts, matched_by, positions } = merged;
    let found = if order == "relevance" || queries.len() == 1 { topics } else { rank::order_merged(topics, &posts, order, &positions) };
    let by_order = if order == "relevance" { found } else { rank::on_topic_only(found, &posts, &queries) };
    let by_order_len = by_order.len();
    let topics = apply_min_likes(by_order, &posts, min_likes);
    let label = label(&queries);
    if topics.is_empty() {
        if let Some(m) = min_likes.filter(|m| *m > 0 && by_order_len > 0) {
            return ok(format!(
                "None of the {} matching {label}{} has a matching post with {m}+ likes — lower min_likes.",
                plural(by_order_len as i64, "thread"),
                skipped_note(&failed)
            ));
        }
        let active = active_filters(category.as_deref(), None, &tags, solved_only, after.as_deref());
        let hint = if active.is_empty() {
            " Try fewer words or the raw error text.".to_string()
        } else {
            format!(" Active filters: {} — try dropping one, or use the raw error text.", active.join(", "))
        };
        return ok(format!("No DevForum threads matched {label}{}.{hint}", skipped_note(&failed)));
    }
    let mut ranked = rank::rank(&topics, &posts, order != "relevance", Some(&matched_by), &queries, Some(&positions));
    ranked.truncate(limit);
    let body: Vec<String> = ranked
        .iter()
        .enumerate()
        .map(|(i, r)| topic_line(ctx, i + 1, r.topic, r.post, if queries.len() > 1 { matched_by.get(&r.topic.id) } else { None }))
        .collect();
    let sorted_by = if order == "relevance" { String::new() } else { format!(", ordered by {order} rather than relevance") };
    let merged_note = if queries.len() > 1 { format!(" ({} phrasings merged)", queries.len()) } else { String::new() };
    let head = format!("{} DevForum threads for {label}{merged_note}{sorted_by}{}:", ranked.len(), skipped_note(&failed));
    ok(truncate(&format!("{head}\n\n{}", body.join("\n\n")), max_tokens, "narrow the query"))
}

pub async fn search_bugs(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let queries = a.string_or_list("query", 2, 5);
    let area = a.string("area", 2);
    let after = a.date("after");
    let limit = a.int("limit", 8, 1, Some(25)) as usize;
    let max_tokens = a.int("max_tokens", 2500, 200, Some(8000)) as usize;
    if let Err(e) = a.finish("search_bugs") {
        return fail(e);
    }
    let queries = dedupe(queries.unwrap_or_default());
    if let Some(msg) = future_date(after.as_deref()) {
        return fail(msg);
    }
    let area = match resolve_slug(ctx, area.as_deref()).await {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    // A support category is community Q&A, not a bug report; never present it as one.
    if let Some(slug) = &area
        && !ctx.categories.bug_areas().contains(slug)
    {
        return fail(format!(
            "\"{slug}\" is not a bug category, and only bug categories carry Roblox's triage status. Use one of: {}. For \"{slug}\" use search_devforum with category \"{slug}\".",
            ctx.categories.bug_areas().join(", ")
        ));
    }
    let base =
        SearchOptions { category: Some(area.clone().unwrap_or_else(|| BUG_PARENT.into())), after: after.clone(), ..Default::default() };
    let (mut merged, failed) = match run_queries(ctx, &queries, &base).await {
        Ok(r) => r,
        Err(e) => return to_tool_error(ctx, "search_bugs failed", &e),
    };
    let label = label(&queries);

    // A sentence-shaped symptom can match nothing while its keywords match a report: retry
    // each phrasing that matched nothing with its distinctive words.
    let matched: HashSet<&String> = merged.matched_by.values().flatten().collect();
    let pairs: Vec<(String, String)> =
        queries.iter().filter(|q| !matched.contains(q) && !failed.contains(q)).filter_map(|q| broaden(q).map(|b| (q.clone(), b))).collect();
    let alts = dedupe(pairs.iter().map(|p| p.1.clone()).collect());
    let mut broadened: Option<Vec<String>> = None;
    if !alts.is_empty() {
        let all: Vec<String> = queries.iter().chain(&alts).cloned().collect();
        if let Ok((retry, retry_failed)) = run_queries(ctx, &all, &base).await
            && retry.topics.len() > merged.topics.len()
        {
            merged = retry;
            broadened = Some(alts.iter().filter(|a| !retry_failed.contains(a)).cloned().collect());
        }
    }

    if merged.topics.is_empty() {
        let tried = if alts.is_empty() { "" } else { ", with or without its less distinctive words" };
        // A filter that excluded everything must never read as "not a known bug".
        let filters = active_filters(None, area.as_deref(), &[], false, after.as_deref());
        if !filters.is_empty() {
            let wide = SearchOptions { category: Some(BUG_PARENT.into()), ..Default::default() };
            if let Ok((wider, _)) = run_queries(ctx, &queries, &wide).await
                && !wider.topics.is_empty()
            {
                return ok(format!(
                    "No bug reports matched {label} {} — but {} matched without that filter, so this is the filter and not the absence of a report. Widen or drop it.",
                    filters.join(" and "),
                    wider.topics.len()
                ));
            }
        }
        return ok(format!(
            "No bug reports matched {label}{tried}{}. That often means it is not a known engine bug — try search_devforum for scripting-support threads, or search_creator_docs for expected behaviour.",
            skipped_note(&failed)
        ));
    }
    let all_queries: Vec<String> = queries.iter().chain(broadened.iter().flatten()).cloned().collect();
    let mut ranked = rank::rank(&merged.topics, &merged.posts, false, Some(&merged.matched_by), &all_queries, Some(&merged.positions));
    ranked.truncate(limit);
    let phrasings = queries.len() + broadened.as_ref().map_or(0, Vec::len);
    let body: Vec<String> = ranked
        .iter()
        .enumerate()
        .map(|(i, r)| topic_line(ctx, i + 1, r.topic, r.post, if phrasings > 1 { merged.matched_by.get(&r.topic.id) } else { None }))
        .collect();
    let widened = if broadened.is_some() {
        let parts: Vec<String> = pairs
            .iter()
            .map(|(asked, trimmed)| format!("{} matched nothing as written, so \"{trimmed}\" was searched too", quoted(asked)))
            .collect();
        format!(" {}.", parts.join("; "))
    } else {
        String::new()
    };
    let any_tag = ranked.iter().any(|r| bug_status(&r.topic.tags, r.topic.has_accepted_answer == Some(true)).is_some_and(|s| s.from_tag));
    let legend = if any_tag {
        "Brackets hold the topic's own status tag, or [answered] where a reply was marked as the solution."
    } else {
        "[answered] means a reply was marked as the solution — by whoever opened the thread, not by Roblox. Read the thread for a staff response before treating a report as confirmed."
    };
    let header = format!("{} bug reports for {label}{}. {legend}{widened}", ranked.len(), skipped_note(&failed));
    ok(truncate(&format!("{header}\n\n{}", body.join("\n\n")), max_tokens, "narrow the query"))
}

pub async fn get_thread(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let topic = a.topic("topic");
    let alias = a.topic("topic_id");
    let max_posts = a.int("max_posts", 8, 1, Some(30)) as usize;
    let max_tokens = a.int("max_tokens", 3500, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("get_thread") {
        return fail(e);
    }
    let (asked, topic_id) = match topic_arg(topic, alias) {
        Ok(r) => r,
        Err(e) => return e,
    };
    match thread(ctx, &asked, topic_id, max_posts, max_tokens).await {
        Ok(r) => r,
        Err(e) => to_tool_error(ctx, &format!("get_thread({topic_id}) failed"), &e),
    }
}

async fn thread(ctx: &Ctx, asked: &TopicRef, topic_id: u64, max_posts: usize, max_tokens: usize) -> Result<ToolResult, Error> {
    let topic: Arc<TopicResponse> = discourse::get_topic(ctx, topic_id).await?;
    let all = &topic.post_stream.posts;
    let Some(first) = all.first() else {
        return Ok(fail(format!("Topic {topic_id} has no readable posts (it may be private).")));
    };
    // The payload carries only the first ~20 posts; the accepted answer and a linked reply are
    // fetched directly when they sit further down.
    let accepted_number = topic.accepted_post_number();
    let linked_number = parse_topic_ref(asked).1;
    let in_chunk = |n: Option<i64>| n.filter(|n| *n > 1).and_then(|n| all.iter().find(|p| p.post_number == n));
    let off_chunk = |n: Option<i64>| {
        let wanted = n.filter(|n| *n > 1 && in_chunk(Some(*n)).is_none());
        async move {
            match wanted {
                Some(n) => discourse::get_post_by_number(ctx, topic_id, n).await.ok(),
                None => None,
            }
        }
    };
    let (accepted_fetched, linked_fetched) = tokio::join!(off_chunk(accepted_number), off_chunk(linked_number));
    let accepted: Option<&RawPost> = all
        .iter()
        .find(|p| p.accepted_answer == Some(true) && p.post_number != first.post_number)
        .or_else(|| in_chunk(accepted_number))
        .or(accepted_fetched.as_deref());
    let linked: Option<&RawPost> = in_chunk(linked_number).or(linked_fetched.as_deref());

    let same = |a: &RawPost, b: Option<&RawPost>| b.is_some_and(|b| std::ptr::eq(a, b) || (a.id == b.id && a.id != 0));
    let mut rest: Vec<&RawPost> =
        all.iter().filter(|p| !same(p, Some(first)) && !same(p, accepted) && !same(p, linked) && !is_automated(p)).collect();
    rest.sort_by(|a, b| {
        is_roblox_staff(b).cmp(&is_roblox_staff(a)).then(post_likes(b).cmp(&post_likes(a))).then(a.post_number.cmp(&b.post_number))
    });
    let mut chosen: Vec<&RawPost> = Vec::new();
    for p in [Some(first), linked, accepted].into_iter().flatten().chain(rest) {
        if !chosen.iter().any(|c| same(c, Some(p))) {
            chosen.push(p);
        }
    }
    chosen.truncate(max_posts);

    // The topic endpoint omits has_accepted_answer; the posts carry the flag themselves.
    let answered = topic.has_accepted_answer.unwrap_or_else(|| {
        topic.accepted_answer.as_ref().is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
            || all.iter().any(|p| p.accepted_answer == Some(true))
    });
    let status = bug_status(&topic.tags, answered).map(|s| {
        if s.from_tag { format!("status tag: {}", s.label) } else { "answered (a reply the asker marked as the solution)".into() }
    });
    let meta: Vec<String> = [
        Some(format!("#{}", ctx.categories.name_of(topic.category_id))),
        status,
        Some(plural(topic.like_count.unwrap_or(0), "like")),
        Some(plural(topic.posts_count.unwrap_or(all.len() as i64), "post")),
        Some(plural(topic.views.unwrap_or(0), "view")),
        Some(format!("created {}", relative_date(topic.created_at.as_deref()))),
        Some(format!("last reply {}", relative_date(topic.last_posted_at.as_deref().or(topic.bumped_at.as_deref())))),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut head = vec![format!("# {}", topic.title), meta.join(" · ")];
    if !topic.tags.is_empty() {
        head.push(format!("tags: {}", topic.tags.join(", ")));
    }
    head.push(ctx.topic_url(topic_id, topic.slug.as_deref(), None));

    let (body, shown) = render_within(
        ctx,
        &chosen,
        topic_id,
        topic.slug.as_deref(),
        max_tokens.saturating_sub(60).max(PER_POST_FLOOR),
        &format!("use get_replies with topic_id {topic_id}"),
    );
    let bots = all.iter().filter(|p| is_automated(p)).count();
    let left = topic.post_stream.stream.len() as i64 - shown as i64 - bots as i64;
    let footer = if left > 0 { format!("\n\n({left} more replies — use get_replies with topic_id {topic_id}.)") } else { String::new() };
    Ok(ok(format!("{}\n\n{body}{footer}", head.join("\n"))))
}

pub async fn get_replies(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let topic = a.topic("topic");
    let alias = a.topic("topic_id");
    let page = a.int("page", 1, 1, None) as usize;
    let limit = a.int("limit", 10, 1, Some(20)) as usize;
    let max_tokens = a.int("max_tokens", 3000, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("get_replies") {
        return fail(e);
    }
    let (_, topic_id) = match topic_arg(topic, alias) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let result: Result<ToolResult, Error> = async {
        let topic = discourse::get_topic(ctx, topic_id).await?;
        let stream = &topic.post_stream.stream;
        if stream.is_empty() {
            return Ok(fail(format!("Topic {topic_id} exposes no post stream.")));
        }
        // Post #1 is the topic, already shown by get_thread.
        let replies = &stream[1..];
        let start = (page - 1).saturating_mul(limit);
        let ids: Vec<u64> = replies.iter().skip(start).take(limit).copied().collect();
        if ids.is_empty() {
            return Ok(ok(format!("Page {page} is past the end of topic {topic_id} ({} replies).", replies.len())));
        }
        let cached = &topic.post_stream.posts;
        let missing: Vec<u64> = ids.iter().copied().filter(|id| !cached.iter().any(|p| p.id == *id)).collect();
        let fetched = if missing.is_empty() { vec![] } else { discourse::get_posts_by_ids(ctx, topic_id, &missing).await? };
        let by_id: HashMap<u64, &RawPost> = cached.iter().chain(fetched.iter()).map(|p| (p.id, p)).collect();
        let posts: Vec<&RawPost> = ids.iter().filter_map(|id| by_id.get(id).copied()).filter(|p| !is_automated(p)).collect();
        if posts.is_empty() {
            return Ok(ok(format!("Page {page} of topic {topic_id} holds only automated notices — try the next page.")));
        }
        let (body, shown) = render_within(
            ctx,
            &posts,
            topic_id,
            topic.slug.as_deref(),
            max_tokens.saturating_sub(30).max(PER_POST_FLOOR),
            "raise max_tokens or lower limit",
        );
        let total = replies.len().div_ceil(limit).max(1);
        let short = if shown < posts.len() {
            format!(" — {shown} of {} posts, raise max_tokens for the rest", posts.len())
        } else {
            String::new()
        };
        Ok(ok(format!("{} — replies page {page}/{total}{short}\n\n{body}", topic.title)))
    }
    .await;
    result.unwrap_or_else(|e| to_tool_error(ctx, &format!("get_replies({topic_id}) failed"), &e))
}

pub async fn list_recent(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let category = a.string("category", 2);
    let tag = a.string("tag", 0).filter(|t| !t.is_empty());
    let listing = a.choice("listing", &["latest", "top"], "latest");
    let period = a.choice("period", &["daily", "weekly", "monthly", "quarterly", "yearly", "all"], "monthly");
    let limit = a.int("limit", 10, 1, Some(30)) as usize;
    let max_tokens = a.int("max_tokens", 2000, 200, Some(8000)) as usize;
    if let Err(e) = a.finish("list_recent") {
        return fail(e);
    }
    let category = match resolve_slug(ctx, category.as_deref()).await {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let topics = match discourse::list_topics(ctx, listing, category.as_deref(), tag.as_deref(), Some(period), 0).await {
        Ok(t) => t,
        Err(e) => return to_tool_error(ctx, "list_recent failed", &e),
    };
    if topics.is_empty() {
        let widen = if listing == "top" && period != "all" {
            format!(" Nothing ranked in the {period} period — try a longer period.")
        } else {
            String::new()
        };
        return ok(format!("No topics found for that category or tag.{widen}"));
    }
    let scope: Vec<String> = [category.map(|c| format!("#{c}")), tag.map(|t| format!("tag:{t}"))].into_iter().flatten().collect();
    let scope = if scope.is_empty() { "the whole forum".to_string() } else { scope.join(" ") };
    let body: Vec<String> = topics.iter().take(limit).enumerate().map(|(i, t)| topic_line(ctx, i + 1, t, None, None)).collect();
    ok(truncate(&format!("{listing} topics in {scope}:\n\n{}", body.join("\n\n")), max_tokens, "lower limit"))
}

pub async fn list_categories(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let include_tags = a.boolean("include_tags", true);
    let tag_limit = a.int("tag_limit", 40, 5, Some(100)) as usize;
    if let Err(e) = a.finish("list_categories") {
        return fail(e);
    }
    // The tag list does not depend on the tree, so both load at once.
    let tags = async { if include_tags { discourse::list_tags(ctx).await.map(Some) } else { Ok(None) } };
    let (_, tags) = tokio::join!(ctx.ensure_categories(), tags);
    let tags = match tags {
        Ok(t) => t,
        Err(e) => return to_tool_error(ctx, "list_categories failed", &e),
    };
    let tree: Vec<String> = ctx
        .categories
        .tree()
        .into_iter()
        .map(|node| {
            let mut line = format!("- {} ({})", node.category.slug, node.category.id);
            for s in node.subcategories {
                line.push_str(&format!("\n    - {} ({})", s.slug, s.id));
            }
            line
        })
        .collect();
    let mut out = format!("DevForum categories (slug and id):\n{}", tree.join("\n"));
    if let Some(tags) = tags {
        let list: Vec<String> = tags.iter().take(tag_limit).map(|(n, c)| format!("{n} ({c})")).collect();
        out.push_str(&format!("\n\nMost-used tags:\n{}", list.join(", ")));
    }
    ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(json: &str) -> RawPost {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn automated_posts() {
        assert!(is_automated(&post(r#"{"username":"system","cooked":"<p>This topic was automatically closed.</p>"}"#)));
        assert!(is_automated(&post(r#"{"username":"system","cooked":"<p>This topic was automatically opened after 10 minutes.</p>"}"#)));
        assert!(!is_automated(&post(r#"{"username":"system","cooked":"<p>A real answer.</p>"}"#)));
        assert!(!is_automated(&post(r#"{"username":"someone","cooked":"<p>automatically closed</p>"}"#)));
        assert!(is_automated(&post(r#"{"username":"staff","post_type":3,"cooked":""}"#)));
        assert!(is_automated(&post(r#"{"username":"staff","post_type":1,"cooked":"  "}"#)));
        assert!(!is_automated(&post(r#"{"username":"staff","post_type":1,"cooked":"<p>Fixed.</p>"}"#)));
    }

    #[test]
    fn badges() {
        assert_eq!(author_badge(&post(r#"{"staff":true,"flair_name":"Roblox_Staff"}"#)), "Roblox staff");
        assert_eq!(author_badge(&post(r#"{"admin":true}"#)), "Roblox staff");
        assert_eq!(author_badge(&post(r#"{"flair_name":"Programmers"}"#)), "Programmers");
        assert_eq!(author_badge(&post(r#"{"staff":false,"primary_group_name":"Roblox_Staff"}"#)), "Roblox staff");
        assert_eq!(author_badge(&post(r#"{"username":"system","staff":true,"trust_level":4}"#)), "");
        assert_eq!(author_badge(&post(r#"{"trust_level":4}"#)), "");
        assert_eq!(author_badge(&post(r#"{"flair_name":null,"staff":false}"#)), "");
    }

    #[test]
    fn broadening_and_filters() {
        assert_eq!(broaden("ProximityPrompt not triggering on mobile").as_deref(), Some("ProximityPrompt triggering"));
        assert_eq!(broaden("ProximityPrompt mobile"), None);
        assert_eq!(broaden("why is it not working"), None);
        assert_eq!(active_filters(None, None, &[], false, Some("2030-01-01")), ["active after 2030-01-01"]);
        assert_eq!(active_filters(None, Some("education-bugs"), &[], false, None), ["in education-bugs"]);
        assert_eq!(
            active_filters(None, None, &["datastore".into(), "saving".into()], true, None),
            ["tags datastore,saving", "solved_only"]
        );
        assert!(active_filters(None, None, &[], false, None).is_empty());
    }

    #[test]
    fn future_dates() {
        assert_eq!(future_date(None), None);
        assert_eq!(future_date(Some("2024-01-01")), None);
        assert_eq!(future_date(Some(&time::today())), None);
        assert!(future_date(Some("2999-01-01")).unwrap().contains("in the future"));
        assert!(future_date(Some("2025-13-45")).unwrap().contains("not a real date"));
        assert!(future_date(Some("2026-02-31")).unwrap().contains("not a real date"));
    }

    #[test]
    fn render_budget() {
        let ctx = Ctx::new(crate::Config::defaults(), Arc::new(crate::http::Offline));
        let posts: Vec<RawPost> = (1..=30)
            .map(|i| RawPost {
                id: i,
                post_number: i as i64,
                username: Some(format!("dev{i}")),
                cooked: Some(format!("<p>{}</p>", "reply body ".repeat(80))),
                ..Default::default()
            })
            .collect();
        let refs: Vec<&RawPost> = posts.iter().collect();
        let (tight, shown) = render_within(&ctx, &refs, 7, None, 300, "hint");
        assert!(shown < posts.len());
        assert!(tight.chars().count() <= 300 * 4 + 80, "{}", tight.len());
        let (roomy, more) = render_within(&ctx, &refs, 7, None, 4000, "hint");
        assert!(more > shown);
        assert!(roomy.chars().count() <= 4000 * 4 + 80);
    }
}
