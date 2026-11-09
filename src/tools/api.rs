//! Official documentation tools: creator-docs search, engine API lookup, API health checks.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::Value;

use super::{ToolResult, fail, ok, to_tool_error};
use crate::args::Args;
use crate::ctx::Ctx;
use crate::docs::{self, ApiMember, DocMember, DumpIndex, doc_url, resolve_doc_path};
use crate::format::{re, truncate};
use crate::http::Error;

/// Narrow a reference page to one member's block(s); the page header follows them.
fn filter_doc_members(page: &str, member: &str) -> String {
    let blocks = docs::split_member_blocks(page);
    let header = blocks.first().cloned().unwrap_or_default();
    let target = member.to_lowercase();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let first_is_word = target.chars().next().is_some_and(is_word);
    let wanted: Vec<&String> = blocks
        .iter()
        .skip(1)
        .filter(|b| {
            b.split('\n').any(|line| {
                let Some(rest) = line.trim_start().strip_prefix('-') else { return false };
                let Some(rest) = rest.trim_start().strip_prefix("name:") else { return false };
                let token = rest.trim().to_lowercase();
                if token.is_empty() || token.contains(char::is_whitespace) {
                    return false;
                }
                // `\S*\bmember\s*$`: the token ends with the member, at a word boundary.
                token.strip_suffix(&target).is_some_and(|prefix| match prefix.chars().last() {
                    None => first_is_word,
                    Some(p) => is_word(p) != first_is_word,
                })
            })
        })
        .collect();
    if wanted.is_empty() {
        return page.to_string();
    }
    let mut out: Vec<&str> = wanted.iter().map(|s| s.as_str()).collect();
    out.push("# --- the whole page ---");
    out.push(&header);
    out.join("\n")
}

re!(RE_INSTANCE_NEW, r#"^Instance\.new\(\s*["']([A-Za-z0-9_]+)["'][^)]*\)([.:])"#);
re!(RE_CONSTRUCTOR, r"^([A-Za-z0-9_]+)\.(?:new|from[A-Za-z0-9_]*)\([^()]*\)([.:])");
re!(
    RE_LOOKUP,
    r#"[:.](?:GetService|WaitForChild|FindFirstChild|FindFirstChildOfClass|FindFirstChildWhichIsA)\(\s*["']([A-Za-z0-9_]+)["'][^)]*\)([.:])"#
);
re!(RE_CALL_TAIL, r"\(.*$");
re!(RE_EDGE_DOTS, r"^\.+|\.+$");
re!(RE_SIGNAL, r"^(.+\..+)\.(?:Connect|ConnectParallel|Once|Wait)$");
re!(RE_GAME, r"(?i)^game(\.|$)");

#[derive(Debug, PartialEq)]
pub struct ApiEntry {
    pub raw: String,
    pub class_name: String,
    pub member_name: Option<String>,
}

/// Split a check_api_health entry into the class and member it asks about, reading Luau
/// expressions the way they evaluate: `game` is the DataModel, `:Method` is a member,
/// constructors and lookups by name mid-chain are the value they produce, and an event's
/// `:Connect` is a question about the event.
pub fn split_api_entry(entry: &str) -> ApiEntry {
    let s = entry.trim();
    let s = RE_INSTANCE_NEW.replace(s, "$1$2");
    let s = RE_CONSTRUCTOR.replace(&s, "$1$2").into_owned();
    // The separator after a lookup is re-emitted, so consecutive lookups need repeated passes.
    let mut s = s;
    for _ in 0..8 {
        let next = RE_LOOKUP.replace_all(&s, ".$1$2").into_owned();
        if next == s {
            break;
        }
        s = next;
    }
    let s = RE_CALL_TAIL.replace(&s, "");
    let s = s.replace(':', ".");
    let s = RE_EDGE_DOTS.replace_all(&s, "");
    let s = RE_SIGNAL.replace(&s, "$1");
    let raw = RE_GAME.replace(&s, "DataModel$1").into_owned();
    let segments: Vec<&str> = raw.split('.').filter(|s| !s.is_empty()).collect();
    let (class_name, member_name) = match segments.len() {
        0 => (raw.clone(), None),
        1 => (segments[0].to_string(), None),
        n => (segments[n - 2].to_string(), Some(segments[n - 1].to_string())),
    };
    ApiEntry { raw, class_name, member_name }
}

const RELEASE_NOTES_HINT: &str = "Release notes and the updates changelog are not in the creator-docs repo. Use get_whats_new for the latest releases and announcements, or get_thread on a \"Release Notes for NNN\" topic to read the discussion.";

static RE_RELEASE_NOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)release[\s-]?notes?|^\s*updates?\b|/updates?/|changelog").unwrap());

pub fn is_release_notes_query(text: &str) -> bool {
    RE_RELEASE_NOTES.is_match(text)
}

/// Fixed-width states, so a batch of results lines up.
const OK: &str = "OK        ";
const DEPRECATED: &str = "DEPRECATED";
const RESTRICTED: &str = "RESTRICTED";
const MISSING: &str = "NOT FOUND ";
const WRONG_CASE: &str = "WRONG CASE";
const UNCHECKED: &str = "UNCHECKED ";
const UNKNOWN: &str = "UNKNOWN   ";

enum Walked {
    Resolved { class_name: String, member_name: String },
    Unresolved { segment: String, why: String },
}

/// The first segment from `from` on that is spelled exactly like a class, with a member after it.
fn class_segment(dump: &DumpIndex, segments: &[String], from: usize) -> Option<usize> {
    (from..segments.len().saturating_sub(1)).find(|&i| dump.class(&segments[i]).is_some_and(|c| c.name == segments[i]))
}

/// Follow a dotted path the way Luau evaluates it, stopping (rather than guessing) at a child
/// the game names itself or a property that can hold any class.
async fn walk_path(ctx: &Arc<Ctx>, dump: &DumpIndex, mut segments: Vec<String>) -> Result<Option<Walked>, Error> {
    loop {
        if segments.len() < 2 {
            return Ok(None);
        }
        let last = segments[segments.len() - 1].clone();
        let head = &segments[0];
        let Some(root) = dump.class(head) else {
            // A datatype value: its members are in the docs, and what they hold is not followed.
            if let Some(datatype) = docs::find_datatype(ctx, head).await? {
                let next = segments[1].clone();
                if segments.len() == 2 || !docs::datatype_members(ctx, &datatype).await?.contains(&next) {
                    return Ok(Some(Walked::Resolved { class_name: datatype, member_name: next }));
                }
                return Ok(Some(Walked::Unresolved {
                    segment: next,
                    why: format!("is a member of the {datatype} datatype, whose value is not followed further"),
                }));
            }
            // A variable at the root: resume at a class-named segment, or say it cannot be known.
            if let Some(resume) = class_segment(dump, &segments, 1) {
                segments.drain(..resume);
                continue;
            }
            if segments.len() == 2 {
                return Ok(None);
            }
            return Ok(Some(Walked::Unresolved { segment: head.clone(), why: "is a variable, not a class, service or library".into() }));
        };
        let mut current = root.name.clone();
        let mut resumed = false;
        for i in 1..segments.len() - 1 {
            let segment = &segments[i];
            if let Some(named) = dump.class(segment).filter(|c| c.name == *segment) {
                current = named.name.clone();
                continue;
            }
            // Exact spelling only: a deprecated lower-case twin must not answer for a service.
            let found = dump.resolve_member(&current, segment);
            let property = found.as_ref().filter(|f| f.exact && f.member.member_type == "Property").map(|f| f.member);
            let Some(property) = property else {
                let kind = found.as_ref().filter(|f| f.exact).map(|f| f.member.member_type.to_lowercase());
                if kind.is_none()
                    && let Some(resume) = class_segment(dump, &segments, i + 1)
                {
                    segments.drain(..resume);
                    resumed = true;
                    break;
                }
                return Ok(Some(Walked::Unresolved {
                    segment: segment.clone(),
                    why: match kind {
                        Some(k) => format!("is a {k} of {current}, not a property"),
                        None => format!("is not a member of {current} — a child the game names itself"),
                    },
                }));
            };
            let typed = property.value_type.as_ref().and_then(|t| t.name.clone());
            let next = typed.as_deref().filter(|t| *t != "Instance").and_then(|t| dump.class(t));
            match next {
                Some(next) => current = next.name.clone(),
                None => {
                    // A datatype-typed property (Camera.CFrame) has documented members of its own.
                    let datatype = match typed.as_deref().filter(|t| *t != "Instance") {
                        Some(t) => docs::find_datatype(ctx, t).await?,
                        None => None,
                    };
                    if let Some(d) = &datatype
                        && i + 2 == segments.len()
                    {
                        return Ok(Some(Walked::Resolved { class_name: d.clone(), member_name: last }));
                    }
                    return Ok(Some(Walked::Unresolved {
                        segment: segment.clone(),
                        why: match datatype {
                            Some(d) => format!("is a {d}, whose members are not followed further"),
                            None => format!("is typed {} and can hold any class at runtime", typed.as_deref().unwrap_or("unknown")),
                        },
                    }));
                }
            }
        }
        if resumed {
            continue;
        }
        return Ok(Some(Walked::Resolved { class_name: current, member_name: last }));
    }
}

fn wrong_case(entry: &str, spelled: &str, extra: &str) -> String {
    format!("{WRONG_CASE} {entry} — Luau is case-sensitive: write {spelled}.{extra}")
}

fn doc_member_line(entry: &str, found: &DocMember, what: &str) -> String {
    let url = doc_url(&found.path);
    if !found.exact {
        return wrong_case(entry, &found.name, if found.deprecated { " It is also deprecated." } else { "" });
    }
    if found.deprecated {
        let note = found.note.as_ref().map_or(String::new(), |n| format!(" [{n}]"));
        return format!("{DEPRECATED} {entry} — {what}{note} ({url})");
    }
    format!("{OK} {entry} — {what} ({url})")
}

/// One enum, or one item of it. Without the `Enum.` prefix, a name that is no enum returns
/// None so other readings can be tried.
fn check_enum(dump: &DumpIndex, entry: &str, enum_name: &str, item: Option<&str>, prefixed: bool) -> Option<String> {
    let Some(e) = dump.enum_(enum_name) else {
        return prefixed.then(|| format!("{MISSING} {entry} — no Enum named \"{enum_name}\"."));
    };
    if e.name != enum_name {
        return Some(wrong_case(entry, &format!("Enum.{}{}", e.name, item.map_or(String::new(), |i| format!(".{i}"))), ""));
    }
    let Some(item) = item else {
        let hint = if prefixed { String::new() } else { format!(" Write it Enum.{}.", e.name) };
        return Some(format!("{OK} {entry} — Enum.{} exists ({} items).{hint}", e.name, e.items.len()));
    };
    if let Some(found) = e.items.iter().find(|i| i.name == item) {
        let full = format!("Enum.{}.{}", e.name, found.name);
        let hint = if prefixed { String::new() } else { format!(" Write it {full}.") };
        return Some(format!("{OK} {entry} — {full} = {}.{hint}", found.value));
    }
    if let Some(cased) = e.items.iter().find(|i| i.name.eq_ignore_ascii_case(item)) {
        return Some(wrong_case(entry, &format!("Enum.{}.{}", e.name, cased.name), ""));
    }
    let near = docs::nearest_names(item, e.items.iter().map(|i| i.name.as_str()), 6);
    let tail = if near.is_empty() {
        format!(" It has {} items — call get_engine_api with \"{}\" to list them.", e.items.len(), e.name)
    } else {
        format!(" Closest: {}.", near.join(", "))
    };
    Some(format!("{MISSING} {entry} — Enum.{} has no item \"{item}\".{tail}", e.name))
}

static RE_ENUM_ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Enum\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?").unwrap());

/// Check one check_api_health entry and describe it on a single line.
async fn check_entry(ctx: &Arc<Ctx>, dump: &DumpIndex, entry: &str) -> Result<String, Error> {
    let split = split_api_entry(entry);
    let raw = split.raw.clone();
    let mut class_name = split.class_name;
    let mut member_name = split.member_name;

    if let Some(c) = RE_ENUM_ENTRY.captures(&raw) {
        return Ok(check_enum(dump, entry, &c[1], c.get(2).map(|m| m.as_str()), true).unwrap_or_default());
    }
    let segments: Vec<String> = raw.split('.').filter(|s| !s.is_empty()).map(str::to_string).collect();
    if segments.len() > 2 {
        match walk_path(ctx, dump, segments.clone()).await? {
            Some(Walked::Unresolved { segment, why }) => {
                return Ok(format!(
                    "{UNCHECKED} {entry} — \"{segment}\" {why}, so what follows cannot be checked from here. Check the member on its class instead, e.g. \"Part.Touched\"."
                ));
            }
            Some(Walked::Resolved { class_name: c, member_name: m }) => {
                class_name = c;
                member_name = Some(m);
            }
            None => {}
        }
    }

    let Some(cls) = dump.class(&class_name) else {
        // Datatypes, enums by shorthand, Luau libraries and globals live outside the class dump.
        let datatype = docs::find_datatype(ctx, &class_name).await?;
        if raw.split('.').count() <= 2
            && let Some(e) = dump.enum_(&class_name)
        {
            let is_item = member_name.as_deref().is_some_and(|m| e.items.iter().any(|i| i.name.eq_ignore_ascii_case(m)));
            if datatype.is_none() || is_item {
                return Ok(check_enum(dump, entry, &class_name, member_name.as_deref(), false).unwrap_or_default());
            }
        }

        if let Some(library) = docs::find_library(ctx, &class_name).await? {
            // A library name is the global itself: `Task.wait` errors.
            if library != class_name {
                let spelled = match &member_name {
                    Some(m) => docs::library_member(ctx, &library, m).await?.map(|f| f.name).unwrap_or_else(|| format!("{library}.{m}")),
                    None => library.clone(),
                };
                return Ok(wrong_case(entry, &spelled, ""));
            }
            let page = resolve_doc_path(&format!("reference/engine/libraries/{library}.yaml"))?;
            let Some(member) = &member_name else {
                return Ok(format!("{OK} {entry} — the Luau {library} library ({})", doc_url(&page)));
            };
            if let Some(found) = docs::library_member(ctx, &library, member).await? {
                return Ok(doc_member_line(entry, &found, &format!("{} is part of the {library} library", found.name)));
            }
            let members = docs::reference_members(&docs::fetch_doc(ctx, &page).await?);
            let short: Vec<&str> = members.iter().map(|(n, _)| n.split_once('.').map_or(n.as_str(), |(_, m)| m)).collect();
            let near = docs::nearest_names(member, short, 6);
            let tail = if near.is_empty() {
                String::new()
            } else {
                format!(" Closest: {}.", near.iter().map(|n| format!("{library}.{n}")).collect::<Vec<_>>().join(", "))
            };
            return Ok(format!("{MISSING} {entry} — the {library} library has no \"{member}\".{tail}"));
        }

        if let Some(datatype) = datatype {
            let url = format!("https://create.roblox.com/docs/reference/engine/datatypes/{datatype}");
            let Some(member) = &member_name else {
                return Ok(format!("{OK} {entry} — {datatype} is a datatype; see {url}"));
            };
            let members = docs::datatype_members(ctx, &datatype).await?;
            if members.contains(member) {
                return Ok(format!("{OK} {entry} — {datatype}.{member} exists (datatype, documented at {url})"));
            }
            if let Some(cased) = members.iter().find(|m| m.eq_ignore_ascii_case(member)) {
                return Ok(wrong_case(entry, &format!("{datatype}.{cased}"), ""));
            }
            let near = docs::nearest_names(member, members.iter().map(String::as_str), 6);
            let tail = if near.is_empty() { format!(" See {url}") } else { format!(" Closest: {}.", near.join(", ")) };
            return Ok(format!("{MISSING} {entry} — the {datatype} datatype has no \"{member}\".{tail}"));
        }

        // A bare name may be a global function: wait, spawn, typeof.
        if member_name.is_none()
            && let Some(global) = docs::global_member(ctx, &class_name).await?
        {
            return Ok(doc_member_line(entry, &global, &format!("global {}", global.name)));
        }

        let near = dump.suggest_classes(&class_name, 8);
        let what = if member_name.is_none() { "class, enum, datatype, library or global named" } else { "class" };
        let tail = if near.is_empty() { String::new() } else { format!(" Closest: {}.", near.join(", ")) };
        return Ok(format!("{MISSING} {entry} — no {what} \"{class_name}\" in the current API.{tail}"));
    };

    let mut notes: Vec<String> = Vec::new();
    let mut state = OK;
    let Some(member_name) = member_name else {
        if cls.has_tag("Deprecated") {
            state = DEPRECATED;
            if let Some(note) = docs::deprecation_note(ctx, &cls.name, None).await {
                notes.push(note.trim_end().trim_end_matches('.').trim_end().to_string());
            }
        }
        if cls.has_tag("NotCreatable") {
            notes.push("not creatable with Instance.new".into());
        }
        if cls.has_tag("Service") {
            notes.push("get it via game:GetService".into());
        }
        let notes = if notes.is_empty() { String::new() } else { format!(" [{}]", notes.join("; ")) };
        return Ok(format!("{state} {entry} — class {}{notes}", cls.name));
    };

    let Some(found) = dump.resolve_member(&cls.name, &member_name) else {
        // Instance.new is a Luau constructor, not a class member.
        if cls.name == "Instance" && (member_name == "new" || member_name == "fromExisting") {
            return Ok(format!("{OK} {entry} — constructor, not a class member; it is not listed in the API dump."));
        }
        if dump.class(&member_name).is_some_and(|c| c.name == member_name) {
            return Ok(format!(
                "{OK} {entry} — not a member of {}: this indexes a child named \"{member_name}\", which errors if it is missing. Use FindFirstChild or WaitForChild when it may not exist yet.",
                cls.name
            ));
        }
        if member_name == "new" && !cls.has_tag("NotCreatable") {
            return Ok(format!("{MISSING} {entry} — classes have no .new; create one with Instance.new(\"{}\").", cls.name));
        }
        let near = dump.suggest_members(&cls.name, &member_name, 6);
        return Ok(if near.is_empty() {
            format!(
                "{MISSING} {entry} — {} has no member \"{member_name}\". If it is a child your game creates, it is not an API and needs no check; otherwise it does not exist.",
                cls.name
            )
        } else {
            format!(
                "{MISSING} {entry} — {} has no member \"{member_name}\"; it may have been removed. Closest: {}.",
                cls.name,
                near.join(", ")
            )
        });
    };

    let member = found.member;
    if !found.exact {
        let sep = if member.member_type == "Function" { ":" } else { "." };
        let extra = if member.has_tag("Deprecated") { " It is also deprecated." } else { "" };
        return Ok(wrong_case(entry, &format!("{}{sep}{}", cls.name, member.name), extra));
    }
    if member.has_tag("Deprecated") {
        state = DEPRECATED;
        if let Some(note) = docs::deprecation_note(ctx, &found.owner.name, Some(&member.name)).await {
            notes.push(note.trim_end().trim_end_matches('.').trim_end().to_string());
        }
    }
    if let Some(sec) = docs::security_of(member) {
        if state != DEPRECATED {
            state = RESTRICTED;
        }
        notes.push(match sec.scope {
            "all" => format!("security: {} — normal game scripts cannot use this", sec.level),
            "write" => format!("security: {} to write — a game script can read it but not set it", sec.level),
            _ => format!("security: {} to read — a game script can set it but not read it", sec.level),
        });
    }
    if member.has_tag("NotScriptable") {
        notes.push("not scriptable".into());
    }
    if member.has_tag("Yields") {
        notes.push("yields, call from a coroutine or with care".into());
    }
    if member.has_tag("ReadOnly") {
        notes.push("read-only".into());
    }
    if found.owner.name != cls.name {
        notes.push(format!("inherited from {}", found.owner.name));
    }
    let notes = if notes.is_empty() { String::new() } else { format!(" [{}]", notes.join("; ")) };
    Ok(format!("{state} {entry} — {}{notes}", docs::signature(member)))
}

pub async fn check_api_health(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    a.require("members");
    let members = a.strings("members", 2, 1, Some(25));
    let max_tokens = a.int("max_tokens", 2500, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("check_api_health") {
        return fail(e);
    }
    let entries: Vec<String> = members.unwrap_or_default().iter().map(|m| m.trim().to_string()).collect();
    let dump = docs::dump(ctx).await;
    // One entry failing to load is reported on its own line; the rest of the batch still answers.
    let checks = entries.iter().map(|entry| {
        let dump = dump.clone();
        async move {
            let result = match dump {
                Ok(d) => check_entry(ctx, &d, entry).await,
                Err(e) => Err(e),
            };
            result.unwrap_or_else(|e| format!("{UNKNOWN} {entry} — could not be checked: {e}"))
        }
    });
    let lines = futures_util::future::join_all(checks).await;
    let flagged = lines.iter().filter(|l| !l.starts_with("OK")).count();
    let header = if flagged == 0 {
        format!("All {} APIs are current and usable from game scripts.", lines.len())
    } else {
        format!("{flagged} of {} APIs need attention:", lines.len())
    };
    ok(truncate(&format!("{header}\n\n{}", lines.join("\n")), max_tokens, "check fewer at a time"))
}

pub async fn search_creator_docs(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    let query = a.string("query", 0).filter(|q| !q.is_empty());
    let path = a.string("path", 0).filter(|p| !p.is_empty());
    let limit = a.int("limit", 10, 1, Some(25)) as usize;
    let max_tokens = a.int("max_tokens", 3000, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("search_creator_docs") {
        return fail(e);
    }
    let result: Result<ToolResult, Error> = async {
        if let Some(path) = path {
            let page = docs::find_doc_page(ctx, &path).await?;
            let Some(resolved) = page.path else {
                if is_release_notes_query(&path) {
                    return Ok(fail(format!("{path} is not in the docs repo. {RELEASE_NOTES_HINT}")));
                }
                let near = if page.near.is_empty() { String::new() } else { format!(" Closest pages: {}.", page.near.join(", ")) };
                return Ok(fail(format!("No documentation page at \"{path}\".{near} Or search with `query` to find it.")));
            };
            let source = docs::fetch_doc(ctx, &resolved).await?;
            let shaped = if resolved.ends_with(".yaml") { docs::clean_reference_yaml(&source) } else { docs::render_guide(&source) };
            let text = docs::clean_doc_prose(&shaped, Some(&resolved));
            return Ok(ok(format!("{}\n\n{}", doc_url(&resolved), truncate(&text, max_tokens, "read the page online"))));
        }
        let Some(query) = query else {
            return Ok(fail("Provide either `query` to search or `path` to read a page."));
        };
        let hits = docs::search_docs(ctx, &query, limit).await?;
        if hits.is_empty() {
            let hint = if is_release_notes_query(&query) {
                RELEASE_NOTES_HINT
            } else {
                "Try an exact class name (DataStoreService) or a shorter phrase."
            };
            return Ok(ok(format!("No documentation page matched \"{query}\". {hint}")));
        }
        let body: Vec<String> = hits
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let snippet = h.snippet.as_ref().map_or(String::new(), |s| format!("\n   {s}"));
                format!("{}. {} ({})\n   {}\n   path: {}{snippet}", i + 1, h.title, h.kind.as_str(), h.url, h.path)
            })
            .collect();
        let footer = "Call search_creator_docs again with `path` to read a page in full.";
        Ok(ok(truncate(
            &format!("{} documentation pages for \"{query}\":\n\n{}\n\n{footer}", hits.len(), body.join("\n\n")),
            max_tokens,
            "lower limit",
        )))
    }
    .await;
    result.unwrap_or_else(|e| to_tool_error(ctx, "search_creator_docs failed", &e))
}

static RE_ENUM_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Enum\.([A-Za-z0-9_]+)").unwrap());
static RE_ENUM_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Enum\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)").unwrap());

pub async fn get_engine_api(ctx: &Arc<Ctx>, raw: Option<&Value>) -> ToolResult {
    let mut a = Args::new(raw);
    a.require("name");
    let name = a.string("name", 2);
    let filter = a.string("filter", 0).filter(|f| !f.is_empty());
    let member_types = a.choices("member_types", &["Property", "Function", "Event", "Callback"]);
    let include_inherited = a.boolean("include_inherited", false);
    let max_tokens = a.int("max_tokens", 3000, 300, Some(12000)) as usize;
    if let Err(e) = a.finish("get_engine_api") {
        return fail(e);
    }
    let name = name.unwrap_or_default();
    engine_api(ctx, &name, filter, member_types, include_inherited, max_tokens)
        .await
        .unwrap_or_else(|e| to_tool_error(ctx, "get_engine_api failed", &e))
}

async fn engine_api(
    ctx: &Arc<Ctx>,
    name: &str,
    filter_arg: Option<String>,
    member_types: Option<Vec<&'static str>>,
    include_inherited: bool,
    max_tokens: usize,
) -> Result<ToolResult, Error> {
    let dump = docs::dump(ctx).await?;
    // The member form ("Humanoid.LoadAnimation") and the expressions check_api_health walks
    // resolve to their class and narrow to that member.
    let entry = split_api_entry(name);
    let segments: Vec<String> = entry.raw.split('.').filter(|s| !s.is_empty()).map(str::to_string).collect();
    let walked = if segments.len() > 2 && !entry.raw.starts_with("Enum.") { walk_path(ctx, &dump, segments).await? } else { None };
    let (target_class, target_member) = match walked {
        Some(Walked::Unresolved { segment, why }) => {
            return Ok(fail(format!(
                "Cannot tell which class \"{name}\" reaches: \"{segment}\" {why}. Look up that class directly, e.g. \"Part\"."
            )));
        }
        Some(Walked::Resolved { class_name, member_name }) => (class_name, Some(member_name)),
        None => (entry.class_name.clone(), entry.member_name.clone()),
    };
    let looked = if dump.class(name).is_some() { name.to_string() } else { target_class.clone() };
    let mut member_filter = if looked == name { None } else { target_member.clone() };
    let mut cls = dump.class(&looked);

    // "Character.Humanoid" indexes a child: answer with the class the child is.
    let mut child_note = String::new();
    if let (Some(c), Some(m)) = (cls, member_filter.clone())
        && dump.resolve_member(&c.name, &m).is_none()
        && let Some(child) = dump.class(&m).filter(|ch| ch.name == m)
    {
        child_note = format!(
            "\"{m}\" is not a member of {}: it indexes a child named \"{m}\", which errors if it is missing. That child's class:\n\n",
            c.name
        );
        cls = Some(child);
        member_filter = None;
    }

    let Some(cls) = cls else {
        let prefixed = RE_ENUM_PREFIX.captures(&entry.raw).map(|c| c[1].to_string());
        let enum_name = prefixed.clone().unwrap_or_else(|| target_class.clone());
        if let Some(e) = dump.enum_(&enum_name) {
            let lower = member_filter.as_deref().map(str::to_lowercase);
            let names_item = lower.as_deref().is_some_and(|l| e.items.iter().any(|i| i.name.to_lowercase() == l));
            let fits = prefixed.is_some() || lower.is_none() || names_item || docs::find_datatype(ctx, &target_class).await?.is_none();
            if fits {
                let items: Vec<String> = e.items.iter().map(|i| format!("{} = {}", i.name, i.value)).collect();
                let item_name =
                    if prefixed.is_some() { RE_ENUM_ITEM.captures(&entry.raw).map(|c| c[1].to_string()) } else { member_filter.clone() };
                let mut lead = String::new();
                if let Some(item_name) = &item_name {
                    if let Some(item) = e.items.iter().find(|i| i.name == *item_name) {
                        return Ok(ok(format!(
                            "Enum.{}.{} = {}\n\nEnum.{} has {} items — call get_engine_api with \"{}\" to list them.",
                            e.name,
                            item.name,
                            item.value,
                            e.name,
                            e.items.len(),
                            e.name
                        )));
                    }
                    lead = match e.items.iter().find(|i| i.name.eq_ignore_ascii_case(item_name)) {
                        Some(c) => format!(
                            "Enum.{} has no \"{item_name}\" — Luau is case-sensitive: write Enum.{}.{} (= {}).\n\n",
                            e.name, e.name, c.name, c.value
                        ),
                        None => format!("Enum.{} has no item \"{item_name}\".\n\n", e.name),
                    };
                }
                // Font is both an enum and a datatype; say so, or Font.new reads as missing.
                let twin = if prefixed.is_none() && item_name.is_none() { docs::find_datatype(ctx, &target_class).await? } else { None };
                let also = twin
                    .map_or(String::new(), |t| format!(" ({t} is also a datatype — ask for \"{t}.new\" for its constructors and members)"));
                let list = if items.is_empty() { "(no items)".to_string() } else { items.join(", ") };
                return Ok(ok(truncate(&format!("{lead}Enum.{}{also}\n{list}", e.name), max_tokens, "the item list is cut")));
            }
        }
        // Datatypes (Vector3, CFrame…) are documented, not dumped.
        if let Some(datatype) = docs::find_datatype(ctx, &target_class).await? {
            let path = resolve_doc_path(&format!("reference/engine/datatypes/{datatype}.yaml"))?;
            let page = docs::clean_doc_prose(&docs::clean_reference_yaml(&docs::fetch_doc(ctx, &path).await?), Some(&path));
            let body = match &member_filter {
                Some(m) => filter_doc_members(&page, m),
                None => page,
            };
            return Ok(ok(format!(
                "{datatype} is a datatype, not a class — from the documentation, not the API dump.\n{}\n\n{}",
                doc_url(&path),
                truncate(&body, max_tokens, "read the page online")
            )));
        }
        // Luau libraries and bare globals.
        let library = docs::find_library(ctx, &target_class).await?;
        let global_path = if library.is_some() || member_filter.is_some() {
            None
        } else {
            docs::global_member(ctx, &target_class).await?.map(|g| g.path)
        };
        let doc_path = match &library {
            Some(l) => Some(resolve_doc_path(&format!("reference/engine/libraries/{l}.yaml"))?),
            None => global_path,
        };
        if let Some(doc_path) = doc_path {
            let page = docs::clean_doc_prose(&docs::clean_reference_yaml(&docs::fetch_doc(ctx, &doc_path).await?), Some(&doc_path));
            let narrow = if library.is_some() { member_filter.clone() } else { Some(target_class.clone()) };
            let body = match narrow {
                Some(n) => filter_doc_members(&page, &n),
                None => page,
            };
            let what = match &library {
                Some(l) => format!("{l} is a Luau library"),
                None => format!("{target_class} is a global function"),
            };
            return Ok(ok(format!(
                "{what}, not a class — from the documentation, not the API dump.\n{}\n\n{}",
                doc_url(&doc_path),
                truncate(&body, max_tokens, "read the page online")
            )));
        }
        let suggestions = dump.suggest_classes(name, 8);
        let tail = if suggestions.is_empty() { String::new() } else { format!(" Did you mean: {}?", suggestions.join(", ")) };
        return Ok(fail(format!("No engine class, enum, datatype, library or global named \"{name}\".{tail}")));
    };

    // Naming one member implies the chain: Touched is BasePart's, not Part's.
    let chain = if include_inherited || member_filter.is_some() { dump.chain(&cls.name) } else { vec![cls] };
    let filter = filter_arg.clone().or(member_filter.clone()).map(|f| f.to_lowercase());
    // A named member is matched whole when it exists; an explicit filter stays a substring.
    let exact = filter_arg.is_none()
        && filter.as_ref().is_some_and(|f| chain.iter().any(|c| c.members.iter().any(|m| m.name.to_lowercase() == *f)));

    let mut sections = Vec::new();
    for owner in &chain {
        let members: Vec<&ApiMember> = owner
            .members
            .iter()
            .filter(|m| member_types.as_ref().is_none_or(|w| w.contains(&m.member_type.as_str())))
            .filter(|m| {
                let n = m.name.to_lowercase();
                match &filter {
                    None => true,
                    Some(f) if exact => n == *f,
                    Some(f) => n.contains(f.as_str()),
                }
            })
            .collect();
        if members.is_empty() {
            continue;
        }
        let mut grouped: std::collections::BTreeMap<&str, Vec<&ApiMember>> = std::collections::BTreeMap::new();
        for m in members {
            grouped.entry(m.member_type.as_str()).or_default().push(m);
        }
        let mut lines = Vec::new();
        for (ty, mut list) in grouped {
            lines.push(if ty == "Property" { "Properties:".to_string() } else { format!("{ty}s:") });
            list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
            for m in list {
                let mut notes = Vec::new();
                if let Some(sec) = docs::security_of(m) {
                    notes.push(if sec.scope == "all" {
                        format!("security: {}", sec.level)
                    } else {
                        format!("security: {} ({} only)", sec.level, sec.scope)
                    });
                }
                for (tag, label) in
                    [("Deprecated", "DEPRECATED"), ("ReadOnly", "read-only"), ("Yields", "yields"), ("NotReplicated", "not replicated")]
                {
                    if m.has_tag(tag) {
                        notes.push(label.to_string());
                    }
                }
                if let Some(ts) = m.thread_safety.as_deref().filter(|t| *t != "ReadSafe") {
                    notes.push(format!("thread: {ts}"));
                }
                let notes = if notes.is_empty() { String::new() } else { format!("  [{}]", notes.join(", ")) };
                lines.push(format!("  {}{notes}", docs::signature(m)));
            }
        }
        let heading = if std::ptr::eq(*owner, cls) { format!("# {}", owner.name) } else { format!("# inherited from {}", owner.name) };
        sections.push(format!("{heading}\n{}", lines.join("\n")));
    }

    let superclass = cls.superclass.as_deref().unwrap_or("none");
    if sections.is_empty() {
        if let (Some(m), None) = (&member_filter, &filter_arg)
            && dump.resolve_member(&cls.name, m).is_none()
        {
            let near = dump.suggest_members(&cls.name, m, 6);
            let tail = if near.is_empty() { String::new() } else { format!(" Closest: {}.", near.join(", ")) };
            return Ok(ok(format!("{} has no member \"{m}\", inherited ones included.{tail}", cls.name)));
        }
        return Ok(ok(format!("{} has no members matching those filters. Superclass: {superclass}.", cls.name)));
    }

    let mut head = vec![format!("{} (inherits {superclass})", cls.name)];
    if !cls.tags.is_empty() {
        head.push(format!("class tags: {}", cls.tags.join(", ")));
    }
    head.push(format!("docs: https://create.roblox.com/docs/reference/engine/classes/{}", cls.name));

    // One named member: what it does, and what replaced it if it is deprecated.
    let mut about = String::new();
    if exact && let Some(m) = &member_filter {
        let found = dump.resolve_member(&cls.name, m);
        let member_docs = match found.as_ref().filter(|f| f.exact) {
            Some(f) => docs::member_docs(ctx, &f.owner.name, &f.member.name).await,
            None => None,
        };
        if let Some(summary) = member_docs.as_ref().and_then(|d| d.summary.as_ref()) {
            about.push_str(&format!("\n\nFrom the docs: {summary}"));
        }
        if found.as_ref().is_some_and(|f| f.member.has_tag("Deprecated")) {
            match member_docs.as_ref().and_then(|d| d.deprecation.as_ref()) {
                Some(d) => about.push_str(&format!("\nDeprecated: {d}")),
                None => about.push_str("\nDeprecated — the docs name no replacement."),
            }
        }
    }
    Ok(ok(truncate(&format!("{child_note}{}\n\n{}{about}", head.join("\n"), sections.join("\n\n")), max_tokens, "use `filter` to narrow")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(s: &str) -> (String, String, Option<String>) {
        let e = split_api_entry(s);
        (e.raw, e.class_name, e.member_name)
    }

    #[test]
    fn entries_split_like_luau_evaluates() {
        assert_eq!(split("Humanoid.LoadAnimation"), ("Humanoid.LoadAnimation".into(), "Humanoid".into(), Some("LoadAnimation".into())));
        assert_eq!(split("Humanoid"), ("Humanoid".into(), "Humanoid".into(), None));
        assert_eq!(split("Humanoid:LoadAnimation").0, "Humanoid.LoadAnimation");
        assert_eq!(
            split("game:GetService(\"DataStoreService\")"),
            ("DataModel.GetService".into(), "DataModel".into(), Some("GetService".into()))
        );
        assert_eq!(split("game").1, "DataModel");
        assert_eq!(split("game.HttpGet").1, "DataModel");
        assert_eq!(split("game.Workspace.Terrain"), ("DataModel.Workspace.Terrain".into(), "Workspace".into(), Some("Terrain".into())));
        assert_eq!(split("Enum.RaycastFilterType").0, "Enum.RaycastFilterType");
        assert_eq!(split("Enum.KeyCode:ButtonA").0, "Enum.KeyCode.ButtonA");
        assert_eq!(
            split("game:GetService(\"Players\").LocalPlayer"),
            ("DataModel.Players.LocalPlayer".into(), "Players".into(), Some("LocalPlayer".into()))
        );
        assert_eq!(split("char:WaitForChild('Humanoid'):MoveTo(pos)").0, "char.Humanoid.MoveTo");
        assert_eq!(split("game:GetService(\"Players\")").0, "DataModel.GetService");
        assert_eq!(split("Instance.new(\"Part\").Anchored"), ("Part.Anchored".into(), "Part".into(), Some("Anchored".into())));
        assert_eq!(split("CFrame.new(0, 5, 0).Position").0, "CFrame.Position");
        assert_eq!(split("Color3.fromRGB(255, 0, 0):Lerp").0, "Color3.Lerp");
        assert_eq!(split("Instance.new(\"Part\")").0, "Instance.new");
        assert_eq!(split("RunService.Heartbeat:Connect(function(dt) end)").0, "RunService.Heartbeat");
        assert_eq!(split("game.Players.PlayerAdded:Wait()").0, "DataModel.Players.PlayerAdded");
        assert_eq!(split("game:GetService(\"RunService\").Stepped:Once").0, "DataModel.RunService.Stepped");
        assert_eq!(split("Heartbeat:Connect").0, "Heartbeat.Connect");
        assert_eq!(split("a:WaitForChild(\"B\"):WaitForChild(\"C\").D").0, "a.B.C.D");
    }

    #[test]
    fn release_notes_detection() {
        for q in [
            "release notes 736",
            "release-notes-736",
            "content/en-us/release-notes/release-notes-736.md",
            "updates release notes",
            "content/en-us/updates/736",
            "changelog",
        ] {
            assert!(is_release_notes_query(q), "{q}");
        }
        for q in ["DataStoreService", "data store limits", "ProximityPrompt"] {
            assert!(!is_release_notes_query(q), "{q}");
        }
    }
}
