//! "What did Roblox ship recently?" — the weekly recap, release notes and announcements.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use super::{ToolResult, fail, ok, to_tool_error};
use crate::args::Args;
use crate::ctx::Ctx;
use crate::discourse::{self, RawTopic, WEEKLY_RECAP_TAG};
use crate::format::{html_to_markdown, plural, relative_date, truncate};
use crate::http::Error;
use crate::time;

fn published(t: &RawTopic) -> Option<&str> {
    t.created_at.as_deref().or(t.bumped_at.as_deref())
}

fn within_days(t: &RawTopic, days: i64) -> bool {
    published(t).and_then(time::parse_iso).is_some_and(|at| time::now_ms() - at <= days * time::DAY_MS)
}

fn line(ctx: &Ctx, t: &RawTopic) -> String {
    format!(
        "- {}\n  published {} · {}  (topic_id: {})",
        t.title,
        relative_date(published(t)),
        ctx.topic_url(t.id, t.slug.as_deref(), None),
        t.id
    )
}

/// Newest first by publication date, not Discourse's bump order.
fn newest_first(mut topics: Vec<RawTopic>) -> Vec<RawTopic> {
    let key = |t: &RawTopic| published(t).and_then(time::parse_iso).unwrap_or(i64::MIN);
    topics.sort_by_key(|t| std::cmp::Reverse(key(t)));
    topics
}

const MAX_RECAP_PAGES: u32 = 6;

/// The recap archive, newest first: page 0 alone usually answers; the rest load in parallel.
async fn recap_archive(ctx: &Ctx, needed: usize) -> Result<Vec<RawTopic>, Error> {
    let first = discourse::list_topics(ctx, "latest", None, Some(WEEKLY_RECAP_TAG), None, 0).await?;
    if first.is_empty() || first.len() >= needed {
        return Ok(newest_first(first));
    }
    let pages = (1..MAX_RECAP_PAGES).map(|p| discourse::list_topics(ctx, "latest", None, Some(WEEKLY_RECAP_TAG), None, p));
    let rest = futures_util::future::join_all(pages).await;
    let mut seen: HashSet<u64> = first.iter().map(|t| t.id).collect();
    let mut all = first;
    // Stop at the first empty (or failed) page: past the end of the tag is duplicate risk.
    for batch in rest {
        let Ok(batch) = batch else { break };
        if batch.is_empty() {
            break;
        }
        all.extend(batch.into_iter().filter(|t| seen.insert(t.id)));
    }
    Ok(newest_first(all))
}

pub async fn get_weekly_recap(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let week = a.int("week", 0, 0, Some(120)) as usize;
    let before = a.date("before");
    let list = a.boolean("list", false);
    let limit = a.int("limit", 20, 1, Some(60)) as usize;
    let max_tokens = a.int("max_tokens", 4000, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("get_weekly_recap") {
        return fail(e);
    }
    if let Some(b) = before.as_deref().filter(|b| !time::is_real_date(b)) {
        return fail(format!("\"{b}\" is not a real date — use YYYY-MM-DD."));
    }
    let result: Result<ToolResult, Error> = async {
        let needed = if list { limit } else if before.is_some() { 90 } else { week + 1 };
        let archive = recap_archive(ctx, needed).await?;
        if archive.is_empty() {
            return Ok(ok("No Weekly Recap posts found on the DevForum right now."));
        }
        if list {
            let shown: Vec<String> = archive.iter().take(limit).map(|t| line(ctx, t)).collect();
            return Ok(ok(truncate(
                &format!(
                    "{} Weekly Recaps (newest first):\n\n{}\n\nRead one with get_weekly_recap using its `week` index, or get_thread with its topic_id.",
                    archive.len().min(limit),
                    shown.join("\n")
                ),
                max_tokens,
                "lower `limit`",
            )));
        }
        let chosen = match &before {
            Some(b) => {
                let cutoff = time::parse_iso(&format!("{b}T23:59:59Z")).unwrap_or(i64::MAX);
                match archive.iter().find(|t| t.created_at.as_deref().and_then(time::parse_iso).is_some_and(|at| at <= cutoff)) {
                    Some(t) => t,
                    None => {
                        let oldest = archive.last().and_then(|t| t.created_at.as_deref()).map_or("", |c| &c[..c.len().min(10)]);
                        return Ok(ok(format!(
                            "No Weekly Recap published on or before {b}. The archive goes back to {oldest} — try a later date."
                        )));
                    }
                }
            }
            None => match archive.get(week) {
                Some(t) => t,
                None => {
                    return Ok(ok(format!(
                        "Only {n} Weekly Recaps are available (week 0-{}); week {week} is further back than the archive goes.",
                        archive.len() - 1,
                        n = archive.len()
                    )));
                }
            },
        };
        let topic = discourse::get_topic(ctx, chosen.id).await?;
        let body = html_to_markdown(topic.post_stream.posts.first().and_then(|p| p.cooked.as_deref()).unwrap_or(""), true);
        let date = chosen.created_at.as_deref().map_or("", |c| &c[..c.len().min(10)]);
        let head = format!(
            "# {}\npublished {date} ({}) · {}",
            chosen.title,
            relative_date(chosen.created_at.as_deref()),
            ctx.topic_url(chosen.id, chosen.slug.as_deref(), None)
        );
        Ok(ok(truncate(&format!("{head}\n\n{body}"), max_tokens, "open the recap")))
    }
    .await;
    result.unwrap_or_else(|e| to_tool_error(ctx, "get_weekly_recap failed", &e))
}

pub async fn get_whats_new(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let days = a.int("days", 14, 1, Some(120));
    let include_body = a.boolean("include_recap_body", true);
    let limit = a.int("limit", 8, 1, Some(30)) as usize;
    let max_tokens = a.int("max_tokens", 3500, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("get_whats_new") {
        return fail(e);
    }
    // The recap body only depends on the recap listing, so it loads as soon as that lands.
    let recaps_and_body = async {
        let recaps = discourse::list_topics(ctx, "latest", None, Some(WEEKLY_RECAP_TAG), None, 0).await.map(newest_first)?;
        let body = match recaps.first() {
            Some(t) if include_body => discourse::get_topic(ctx, t.id).await.ok(),
            _ => None,
        };
        Ok::<_, Error>((recaps, body))
    };
    let (recaps_r, notes_r, ann_r) = tokio::join!(
        recaps_and_body,
        discourse::list_topics(ctx, "latest", Some("release-notes"), None, None, 0),
        discourse::list_topics(ctx, "latest", Some("announcements"), None, None, 0),
    );
    if let (Err(e), Err(_), Err(_)) = (&recaps_r, &notes_r, &ann_r) {
        return to_tool_error(ctx, "get_whats_new failed", e);
    }
    let mut missing = Vec::new();
    if recaps_r.is_err() {
        missing.push("the Weekly Recap");
    }
    if notes_r.is_err() {
        missing.push("release notes");
    }
    if ann_r.is_err() {
        missing.push("announcements");
    }
    let (recaps, recap_topic) = recaps_r.unwrap_or_default();
    let notes = newest_first(notes_r.unwrap_or_default());
    let announcements = newest_first(ann_r.unwrap_or_default());

    let mut sections = Vec::new();
    if let Some(latest) = recaps.first() {
        let mut block = format!(
            "## Weekly Recap\n{}\npublished {} · {}",
            latest.title,
            relative_date(latest.created_at.as_deref()),
            ctx.topic_url(latest.id, latest.slug.as_deref(), None)
        );
        if let Some(topic) = &recap_topic {
            let body = html_to_markdown(topic.post_stream.posts.first().and_then(|p| p.cooked.as_deref()).unwrap_or(""), true);
            if !body.is_empty() {
                block.push_str(&format!("\n\n{}", truncate(&body, (max_tokens as f64 * 0.55) as usize, "open the recap")));
            }
        }
        let older: Vec<String> = recaps.iter().skip(1).filter(|t| within_days(t, days)).take(limit).map(|t| line(ctx, t)).collect();
        if !older.is_empty() {
            block.push_str(&format!("\n\nEarlier recaps in range:\n{}", older.join("\n")));
        }
        sections.push(block);
    }
    let window = plural(days, "day");
    let recent_notes: Vec<String> = notes.iter().filter(|t| within_days(t, days)).take(limit).map(|t| line(ctx, t)).collect();
    if !recent_notes.is_empty() {
        sections.push(format!("## Release notes (last {window})\n{}", recent_notes.join("\n")));
    }
    let recap_ids: HashSet<u64> = recaps.iter().map(|t| t.id).collect();
    let recent_ann: Vec<String> =
        announcements.iter().filter(|t| within_days(t, days) && !recap_ids.contains(&t.id)).take(limit).map(|t| line(ctx, t)).collect();
    if !recent_ann.is_empty() {
        sections.push(format!("## Announcements (last {window})\n{}", recent_ann.join("\n")));
    }

    let gap = if missing.is_empty() {
        String::new()
    } else {
        format!(" ({} could not be loaded and {} left out)", missing.join(" and "), if missing.len() == 1 { "is" } else { "are" })
    };
    if sections.is_empty() {
        return ok(if missing.is_empty() {
            format!("Roblox published nothing in the last {window}. Try a longer window.")
        } else {
            format!("Nothing to report in the last {window}{gap}. Retry shortly.")
        });
    }
    let footer = format!(
        "\n\nUse get_thread on any topic_id above to read the full post.{}",
        if gap.is_empty() { String::new() } else { format!("\n{}", gap.trim()) }
    );
    let budget = max_tokens.saturating_sub(footer.chars().count().div_ceil(4)).max(100);
    ok(truncate(&sections.join("\n\n"), budget, "lower `days` or `limit`") + &footer)
}
