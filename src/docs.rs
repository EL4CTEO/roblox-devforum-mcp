//! Official Roblox documentation: creator-docs sources + the engine API dump.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::{Captures, Regex};
use serde::{Deserialize, Deserializer, Serialize};

use crate::cache::cached_json;
use crate::ctx::{Ctx, STATIC_TTL};
use crate::format::{decode_typography, html_tables_to_markdown, re};
use crate::http::{Error, GITHUB, TEXT};

pub const DOCS_ROOT: &str = "content/en-us/";
const DOCS_REPO: &str = "Roblox/creator-docs";
const RAW_BASE: &str = "https://raw.githubusercontent.com/Roblox/creator-docs/main/";
const TREE_URL: &str = "https://api.github.com/repos/Roblox/creator-docs/git/trees/main?recursive=1";
const API_DUMP_URL: &str = "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json";

pub const TREE_TTL: Duration = Duration::from_secs(24 * 3600);
pub const DUMP_TTL: Duration = Duration::from_secs(12 * 3600);

/* ------------------------------ docs file tree ----------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Guide,
    Class,
    Datatype,
    Enum,
    Global,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Guide => "guide",
            Kind::Class => "class",
            Kind::Datatype => "datatype",
            Kind::Enum => "enum",
            Kind::Global => "global",
        }
    }
}

fn kind_of(path: &str) -> Kind {
    if path.contains("/reference/engine/classes/") {
        Kind::Class
    } else if path.contains("/reference/engine/datatypes/") {
        Kind::Datatype
    } else if path.contains("/reference/engine/enums/") {
        Kind::Enum
    } else if path.contains("/reference/engine/globals/") {
        Kind::Global
    } else {
        Kind::Guide
    }
}

fn strip_ext(s: &str) -> &str {
    s.strip_suffix(".md").or_else(|| s.strip_suffix(".yaml")).unwrap_or(s)
}

pub fn title_of(path: &str) -> String {
    let file = strip_ext(&path[path.rfind('/').map_or(0, |i| i + 1)..]);
    if file == "index" {
        let rel = path.strip_prefix(DOCS_ROOT).unwrap_or(path);
        let rel = rel.strip_suffix("/index.md").or_else(|| rel.strip_suffix("/index.yaml")).unwrap_or(rel);
        rel.to_string()
    } else {
        file.to_string()
    }
}

/// Public documentation URL for a repo path.
pub fn doc_url(path: &str) -> String {
    let rel = strip_ext(path.strip_prefix(DOCS_ROOT).unwrap_or(path));
    let rel = rel.strip_suffix("/index").unwrap_or(rel);
    format!("https://create.roblox.com/docs/{rel}")
}

/// One docs path with everything path scoring needs precomputed once per tree.
pub struct DocEntry {
    pub path: String,
    lower: String,
    title_lower: String,
    title_compact: String,
    kind: Kind,
}

pub struct DocsTree {
    pub entries: Vec<DocEntry>,
    by_lower: HashMap<String, usize>,
}

impl DocsTree {
    pub fn build(paths: Vec<String>) -> Self {
        let mut by_lower = HashMap::with_capacity(paths.len());
        let entries: Vec<DocEntry> = paths
            .into_iter()
            .enumerate()
            .map(|(i, path)| {
                let lower = path.to_lowercase();
                by_lower.insert(lower.clone(), i);
                let title_lower = title_of(&path).to_lowercase();
                let title_compact = title_lower.chars().filter(char::is_ascii_alphanumeric).collect();
                DocEntry { kind: kind_of(&path), path, lower, title_lower, title_compact }
            })
            .collect();
        DocsTree { entries, by_lower }
    }

    /// A docs path by case-insensitive lookup.
    pub fn find(&self, path: &str) -> Option<&str> {
        self.by_lower.get(&path.to_lowercase()).map(|&i| self.entries[i].path.as_str())
    }
}

#[derive(Deserialize)]
struct GitTree {
    #[serde(default)]
    tree: Vec<GitNode>,
}

#[derive(Deserialize)]
struct GitNode {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

pub async fn docs_tree(ctx: &Arc<Ctx>) -> Result<Arc<DocsTree>, Error> {
    let c = ctx.clone();
    ctx.docs_tree
        .get(move || async move {
            // The raw tree is ~3.3 MB; only the filtered path list is kept, cached to disk.
            let paths = cached_json(&c.cfg.cache_dir, "docs-tree", TREE_TTL, || async {
                let data: GitTree = c.http.fetch_json(TREE_URL, GITHUB).await?;
                Ok(data
                    .tree
                    .into_iter()
                    .filter(|n| n.kind == "blob" && n.path.starts_with(DOCS_ROOT) && (n.path.ends_with(".md") || n.path.ends_with(".yaml")))
                    .map(|n| n.path)
                    .collect::<Vec<String>>())
            })
            .await?;
            Ok(DocsTree::build(paths))
        })
        .await
}

async fn find_doc_path(ctx: &Arc<Ctx>, path: &str) -> Result<Option<String>, Error> {
    Ok(docs_tree(ctx).await?.find(path).map(str::to_string))
}

/* --------------------------------- search ---------------------------------- */

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "are", "how", "do", "does", "what", "why", "when", "with", "my",
    "it", "roblox", "can", "get", "use", "using", "make", "making", "should", "way", "best", "you", "your", "want", "need",
];

pub fn query_terms(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let terms: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| t.len() > 1).collect();
    let meaningful: Vec<&str> = terms.iter().copied().filter(|t| !STOPWORDS.contains(t)).collect();
    let chosen = if meaningful.is_empty() { terms } else { meaningful };
    let mut seen = HashSet::new();
    chosen.into_iter().filter(|t| seen.insert(*t)).map(str::to_string).collect()
}

fn score_entry(e: &DocEntry, terms: &[String], compact_query: &str) -> f64 {
    let mut score = 0.0;
    let mut covered = 0usize;
    for term in terms {
        if e.title_compact == *term {
            score += 60.0;
            covered += 1;
        } else if e.title_lower.contains(term.as_str()) {
            score += 20.0;
            covered += 1;
        } else if e.lower.contains(term.as_str()) {
            score += 6.0;
            covered += 1;
        }
    }
    if covered == 0 {
        return 0.0;
    }
    score += covered as f64 / terms.len() as f64 * 25.0;
    if e.title_compact == compact_query {
        score += 80.0;
    }
    if e.kind != Kind::Guide {
        score += 4.0;
    }
    if e.path.ends_with("/index.md") {
        score += 4.0;
    }
    score
}

/// Score a documentation path (stage one — cheap, no network).
pub fn score_path(path: &str, terms: &[String], compact_query: &str) -> f64 {
    let tree = DocsTree::build(vec![path.to_string()]);
    score_entry(&tree.entries[0], terms, compact_query)
}

fn compact_lower(s: &str) -> String {
    s.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

re!(RE_IMPORT, r#"(?m)^import\s+\w+\s+from\s+['"][^'"]+['"];?\s*$"#);
re!(RE_COMPONENT, r"</?[A-Z][A-Za-z0-9_]*(?:\s[^<>]*?)?/?>");
re!(RE_MEDIA_OPEN, r"(?i)<(iframe|video)\b[^<>]*>");
re!(RE_TITLE_ATTR, r#"(?i)\btitle="([^"]*)""#);
re!(RE_HTML_CODE, r"(?i)<code>([^<]*)</code>");
re!(RE_LAYOUT, r"(?i)</?(?:figure|figcaption|div|span|center|br|p|sup|sub)(?:\s[^<>]*?)?/?>");
re!(RE_DOC_IMG, r"(?i)<img\b[^<>]*>");
re!(RE_ALT, r#"(?i)\balt="([^"]*)""#);
re!(RE_NL3, r"\n{3,}");

/// An embedded player is reduced to its title.
fn strip_media(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut pos = 0;
    while let Some(c) = RE_MEDIA_OPEN.captures_at(s, pos) {
        let m = c.get(0).unwrap();
        let close = format!("</{}>", c[1].to_ascii_lowercase());
        let end = lower[m.end()..].find(&close).map_or(m.end(), |rel| m.end() + rel + close.len());
        let whole = &s[m.start()..end];
        out.push_str(&s[last..m.start()]);
        if let Some(t) = RE_TITLE_ATTR.captures(whole)
            && !t[1].to_lowercase().contains("youtube video player")
        {
            out.push_str(&format!("[video: {}]", &t[1]));
        }
        last = end;
        pos = end;
    }
    out.push_str(&s[last..]);
    out
}

/// Guide pages are MDX: the component tags go and their text stays.
fn strip_mdx(text: &str) -> String {
    let s = html_tables_to_markdown(text);
    let s = RE_IMPORT.replace_all(&s, "");
    let s = RE_COMPONENT.replace_all(&s, "");
    let s = strip_media(&s);
    let s = RE_HTML_CODE.replace_all(&s, "`$1`");
    let s = RE_LAYOUT.replace_all(&s, "");
    let s = RE_DOC_IMG.replace_all(&s, |c: &Captures| match RE_ALT.captures(&c[0]) {
        Some(a) if !a[1].is_empty() => format!("[image: {}]", &a[1]),
        _ => String::new(),
    });
    RE_NL3.replace_all(&s, "\n\n").into_owned()
}

/// Resolve a link inside a docs page to its public URL.
fn doc_link_url(href: &str, dir: Option<&str>) -> Option<String> {
    let mut parts = href.split('#');
    let target = parts.next().filter(|t| !t.is_empty())?;
    let fragment = parts.next();
    let base = if href.starts_with('/') { DOCS_ROOT.to_string() } else { format!("{}/", dir?) };
    let resolved = resolve_doc_path(&format!("{base}{}", target.trim_start_matches('/'))).ok()?;
    Some(match fragment.filter(|f| !f.is_empty()) {
        Some(f) => format!("{}#{f}", doc_url(&resolved)),
        None => doc_url(&resolved),
    })
}

re!(RE_XREF, r"\b(Class|Datatype|Enum|Global|Library|Security)\.([A-Za-z0-9_]+(?:[.:][A-Za-z0-9_]+)?)(\(\))?(?:\|([^`\n]*)`)?");
re!(RE_BARE_PIPE, r"`([A-Za-z0-9_]+(?:[.:][A-Za-z0-9_]+)*(?:\(\))?)\|([^`\n]+)`");
re!(RE_MD_LINK, r"\[([^\]]*)\]\(([^)\s]+)\)");

/// Docs prose without renderer syntax: `Class.X` cross-references, display pipes and
/// repo-relative links become what a reader can follow.
pub fn clean_doc_prose(text: &str, source_path: Option<&str>) -> String {
    let mdx = strip_mdx(text);
    let s = decode_typography(&mdx);
    let s = RE_XREF.replace_all(&s, |c: &Captures| {
        if let Some(display) = c.get(4) {
            return format!("{}`", display.as_str());
        }
        let kind = &c[1];
        let parens = c.get(3).map_or("", |m| m.as_str());
        if kind == "Enum" {
            return c[0].to_string();
        }
        let name = &c[2];
        let name = if kind == "Global" {
            name.strip_prefix("LuaGlobals.")
                .or_else(|| name.strip_prefix("LuaGlobals:"))
                .or_else(|| name.strip_prefix("RobloxGlobals."))
                .or_else(|| name.strip_prefix("RobloxGlobals:"))
                .unwrap_or(name)
        } else {
            name
        };
        format!("{name}{parens}")
    });
    let s = RE_BARE_PIPE.replace_all(&s, "`$2`");
    let dir = source_path.and_then(|p| p.rfind('/').filter(|&i| i > 0).map(|i| &p[..i]));
    RE_MD_LINK
        .replace_all(&s, |c: &Captures| {
            let (label, href) = (&c[1], &c[2]);
            if href.starts_with("http:") || href.starts_with("https:") || href.starts_with('#') || href.starts_with("mailto:") {
                return c[0].to_string();
            }
            match doc_link_url(href, dir) {
                Some(url) => format!("[{label}]({url})"),
                None => label.to_string(),
            }
        })
        .into_owned()
}

re!(RE_PREAMBLE_COMMENTS, r"^(?:#[^\n]*\n)+");
re!(RE_FRONT_MATTER, r"^---\n(?s:(.*?))\n---\n");

fn strip_preamble(text: &str) -> String {
    let s = RE_PREAMBLE_COMMENTS.replace(text, "");
    let s = RE_FRONT_MATTER.replace(&s, "");
    s.trim_start().to_string()
}

/// A guide with its front matter reduced to title and description.
pub fn render_guide(text: &str) -> String {
    let Some(c) = RE_FRONT_MATTER.captures(text) else { return text.trim_start().to_string() };
    let front = &c[1];
    let field = |name: &str| -> Option<String> {
        let re = Regex::new(&format!(r"(?m)^{name}:\s*(.+)$")).ok()?;
        let v = re.captures(front)?[1].trim().to_string();
        let v = v.strip_prefix(['\'', '"']).unwrap_or(&v);
        let v = v.strip_suffix(['\'', '"']).unwrap_or(v);
        Some(v.to_string())
    };
    let mut head = Vec::new();
    if let Some(t) = field("title").filter(|t| !t.is_empty()) {
        head.push(format!("# {t}"));
    }
    if let Some(d) = field("description").filter(|d| !d.is_empty()) {
        head.push(d);
    }
    let body = text[c.get(0).unwrap().end()..].trim_start();
    if head.is_empty() { body.to_string() } else { format!("{}\n\n{body}", head.join("\n\n")) }
}

re!(RE_EMPTY_FIELD, r#"^\s*[a-z_]+:\s*(\[\]|\{\}|''|""|null)\s*$"#);
re!(RE_BARE_DEFAULT, r"^\s*default:\s*$");

/// Reference YAML without the generated banner and empty fields.
pub fn clean_reference_yaml(text: &str) -> String {
    let s = RE_PREAMBLE_COMMENTS.replace(text, "");
    let kept: Vec<&str> = s.split('\n').filter(|l| !RE_EMPTY_FIELD.is_match(l) && !RE_BARE_DEFAULT.is_match(l)).collect();
    RE_NL3.replace_all(&kept.join("\n"), "\n\n").trim_start().to_string()
}

re!(RE_SUMMARY_HEAD, r"(?m)^summary:\s*\|?\s*$");

/// The `summary:` block at the top of a reference page.
pub fn reference_summary(yaml: &str) -> Option<String> {
    let at = RE_SUMMARY_HEAD.find(yaml)?.start();
    let mut body = Vec::new();
    for line in yaml[at..].split('\n').skip(1) {
        if line.trim().is_empty() || !line.starts_with(char::is_whitespace) {
            break;
        }
        body.push(line.trim());
    }
    let text = body.join(" ").trim().to_string();
    (!text.is_empty()).then_some(text)
}

re!(RE_DATATYPE_MEMBER, r"(?m)^\s*-\s+name:\s+[A-Za-z0-9_]+[.:]([A-Za-z0-9_]+)\s*$");

/// Members a datatype page lists by bare name; "Vector3.Magnitude" and "Vector3:Cross" alike.
pub fn datatype_member_names(yaml: &str) -> HashSet<String> {
    RE_DATATYPE_MEMBER.captures_iter(yaml).map(|c| c[1].to_string()).collect()
}

pub async fn datatype_members(ctx: &Arc<Ctx>, name: &str) -> Result<HashSet<String>, Error> {
    let yaml = fetch_doc(ctx, &resolve_doc_path(&format!("reference/engine/datatypes/{name}.yaml"))?).await?;
    Ok(datatype_member_names(&yaml))
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn snippet_around(text: &str, index: usize) -> String {
    let start = floor_boundary(text, index.saturating_sub(90));
    let end = floor_boundary(text, start + 260);
    let raw: String = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{raw}{}", if start > 0 { "…" } else { "" }, if end < text.len() { "…" } else { "" })
}

pub struct DocHit {
    pub path: String,
    pub title: String,
    pub kind: Kind,
    pub url: String,
    pub score: f64,
    pub snippet: Option<String>,
}

/// Rank paths first, then download the strongest candidates (concurrently, cached) and score
/// the query against real page content.
pub async fn search_docs(ctx: &Arc<Ctx>, query: &str, limit: usize) -> Result<Vec<DocHit>, Error> {
    let tree = docs_tree(ctx).await?;
    let terms = query_terms(query);
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let compact = compact_lower(query);
    let mut candidates: Vec<(usize, f64)> =
        tree.entries.iter().enumerate().map(|(i, e)| (i, score_entry(e, &terms, &compact))).filter(|c| c.1 > 0.0).collect();
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    candidates.truncate(ctx.cfg.docs_scan.max(limit));
    let phrase = terms.join(" ");
    let finders: Vec<memchr::memmem::Finder> = terms.iter().map(|t| memchr::memmem::Finder::new(t.as_bytes())).collect();

    let scans = candidates.into_iter().map(|(i, score)| {
        let path = tree.entries[i].path.clone();
        let (terms, phrase, finders) = (&terms, &phrase, &finders);
        async move {
            let kind = kind_of(&path);
            let mut hit = DocHit { title: title_of(&path), kind, url: doc_url(&path), score, snippet: None, path };
            let Ok(raw) = fetch_doc(ctx, &hit.path).await else { return hit };
            // MDX components are stripped before matching, so a snippet never starts inside a tag.
            let raw = strip_preamble(&raw);
            let source = if hit.path.ends_with(".md") { strip_mdx(&raw) } else { raw };
            let body = source.to_ascii_lowercase();
            let (mut covered, mut hits, mut anchor) = (0usize, 0usize, None::<usize>);
            for finder in finders {
                let mut count = 0;
                let mut first = None;
                for at in finder.find_iter(body.as_bytes()) {
                    first.get_or_insert(at);
                    count += 1;
                }
                if let Some(first) = first {
                    covered += 1;
                    hits += count;
                    if anchor.is_none_or(|a| count < 20 && first < a) {
                        anchor = Some(first);
                    }
                }
            }
            hit.score += covered as f64 / terms.len() as f64 * 60.0 + hits.min(25) as f64 * 1.5;
            if let Some(at) = body.find(phrase.as_str()) {
                hit.score += 70.0;
                anchor = Some(at);
            }
            // A reference page's own summary beats the YAML around a match.
            let summary = if kind == Kind::Guide { None } else { reference_summary(&source) };
            hit.snippet = match (summary, anchor) {
                (Some(s), _) => Some(clean_doc_prose(&s, Some(&hit.path))),
                (None, Some(a)) => Some(clean_doc_prose(&snippet_around(&source, a), Some(&hit.path))),
                _ => None,
            };
            hit
        }
    });
    let mut hits = futures_util::future::join_all(scans).await;
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(limit);
    Ok(hits)
}

/// Resolve a caller-supplied repo path, keeping it inside the documentation root —
/// percent-encoded dots and backslashes included.
pub fn resolve_doc_path(path: &str) -> Result<String, Error> {
    let mut clean = path.trim().to_string();
    for (from, to) in [("%2e", "."), ("%2E", "."), ("%2f", "/"), ("%2F", "/"), ("%5c", "/"), ("%5C", "/"), ("\\", "/")] {
        clean = clean.replace(from, to);
    }
    let clean = clean.trim_start_matches('/');
    let full = if clean.starts_with(DOCS_ROOT) { clean.to_string() } else { format!("{DOCS_ROOT}{clean}") };
    let mut parts: Vec<&str> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let resolved = parts.join("/");
    if !resolved.starts_with(DOCS_ROOT) || resolved.len() <= DOCS_ROOT.len() {
        return Err(Error::Msg(format!("\"{path}\" is outside the documentation tree — paths start with {DOCS_ROOT}")));
    }
    Ok(resolved)
}

pub struct FoundPage {
    pub path: Option<String>,
    pub near: Vec<String>,
}

/// The page a caller means: a create.roblox.com URL, an extension-less path, a folder index.
pub async fn find_doc_page(ctx: &Arc<Ctx>, input: &str) -> Result<FoundPage, Error> {
    let mut asked = input.trim();
    for prefix in ["https://", "http://"] {
        asked = asked.strip_prefix(prefix).unwrap_or(asked);
    }
    let lower = asked.to_ascii_lowercase();
    if lower.starts_with("create.roblox.com/docs/") {
        asked = &asked["create.roblox.com/docs/".len()..];
        if asked.to_ascii_lowercase().starts_with("en-us/") {
            asked = &asked[6..];
        }
    } else {
        asked = input.trim();
    }
    let asked = asked.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    let resolved = resolve_doc_path(asked)?;
    let bare = strip_ext(&resolved).to_string();
    let has_ext = resolved.ends_with(".md") || resolved.ends_with(".yaml");
    let tree = match docs_tree(ctx).await {
        Ok(t) => t,
        // Without the tree there is nothing to match against; let the fetch decide.
        Err(_) => return Ok(FoundPage { path: Some(if has_ext { resolved } else { format!("{bare}.md") }), near: vec![] }),
    };
    for candidate in [resolved.clone(), format!("{bare}.md"), format!("{bare}/index.md"), format!("{bare}.yaml")] {
        if let Some(found) = tree.find(&candidate) {
            return Ok(FoundPage { path: Some(found.to_string()), near: vec![] });
        }
    }
    let leaf = &bare[bare.rfind('/').map_or(0, |i| i + 1)..];
    let terms = query_terms(&leaf.replace('-', " "));
    let compact = terms.concat();
    let mut scored: Vec<(&str, f64)> = if terms.is_empty() {
        vec![]
    } else {
        tree.entries.iter().map(|e| (e.path.as_str(), score_entry(e, &terms, &compact))).filter(|c| c.1 > 0.0).collect()
    };
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    Ok(FoundPage { path: None, near: scored.into_iter().take(3).map(|c| c.0.to_string()).collect() })
}

/// A documentation page source (Markdown guide or reference YAML).
pub async fn fetch_doc(ctx: &Ctx, path: &str) -> Result<Arc<str>, Error> {
    ctx.http.get_text(&format!("{RAW_BASE}{}", resolve_doc_path(path)?), STATIC_TTL).await
}

pub fn repo_name() -> &'static str {
    DOCS_REPO
}

/* --------------------------------- API dump --------------------------------- */

/// Tags hold strings and, on some members, objects (PreferredDescriptor…); only names count.
fn string_tags<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Tag {
        Name(String),
        Other(serde::de::IgnoredAny),
    }
    let tags: Option<Vec<Tag>> = Option::deserialize(d)?;
    Ok(tags.unwrap_or_default().into_iter().filter_map(|t| if let Tag::Name(n) = t { Some(n) } else { None }).collect())
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TypeRef {
    #[serde(rename = "Name", default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A type is `{Name}`, or — for a function returning several values — an array of them,
/// which reads as the tuple Luau returns: "(CFrame, Vector3)".
impl<'de> Deserialize<'de> for TypeRef {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct One {
            #[serde(rename = "Name", default)]
            name: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shape {
            Many(Vec<One>),
            One(One),
            Other(serde::de::IgnoredAny),
        }
        Ok(match Shape::deserialize(d)? {
            Shape::One(o) => TypeRef { name: o.name },
            Shape::Many(list) => {
                let names: Vec<String> = list.into_iter().filter_map(|o| o.name).collect();
                TypeRef { name: (!names.is_empty()).then(|| format!("({})", names.join(", "))) }
            }
            Shape::Other(_) => TypeRef::default(),
        })
    }
}

fn lenient_default<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        None => None,
        Some(serde_json::Value::String(s)) => Some(s),
        Some(v) => Some(v.to_string()),
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiParam {
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "Type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<TypeRef>,
    #[serde(rename = "Default", default, deserialize_with = "lenient_default", skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Security {
    Level(String),
    Split {
        #[serde(rename = "Read", default, skip_serializing_if = "Option::is_none")]
        read: Option<String>,
        #[serde(rename = "Write", default, skip_serializing_if = "Option::is_none")]
        write: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiMember {
    #[serde(rename = "MemberType", default)]
    pub member_type: String,
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "ValueType", default, skip_serializing_if = "Option::is_none")]
    pub value_type: Option<TypeRef>,
    #[serde(rename = "ReturnType", default, skip_serializing_if = "Option::is_none")]
    pub return_type: Option<TypeRef>,
    #[serde(rename = "Parameters", default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<ApiParam>,
    #[serde(rename = "Security", default, skip_serializing_if = "Option::is_none")]
    pub security: Option<Security>,
    #[serde(rename = "Tags", default, deserialize_with = "string_tags", skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(rename = "ThreadSafety", default, skip_serializing_if = "Option::is_none")]
    pub thread_safety: Option<String>,
}

impl ApiMember {
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiClass {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "Superclass", default, skip_serializing_if = "Option::is_none")]
    pub superclass: Option<String>,
    #[serde(rename = "Tags", default, deserialize_with = "string_tags", skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(rename = "Members", default)]
    pub members: Vec<ApiMember>,
}

impl ApiClass {
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiEnumItem {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "Value", default)]
    pub value: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiEnum {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "Items", default)]
    pub items: Vec<ApiEnumItem>,
}

/// Only the fields the tools read; the rest of the ~2.5 MB dump is skipped while parsing.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ApiDump {
    #[serde(rename = "Classes", default)]
    pub classes: Vec<ApiClass>,
    #[serde(rename = "Enums", default)]
    pub enums: Vec<ApiEnum>,
}

/// Lower-cased name -> entry, built once per dump.
pub struct DumpIndex {
    pub classes: Vec<ApiClass>,
    pub enums: Vec<ApiEnum>,
    by_lower: HashMap<String, usize>,
    by_name: HashMap<String, usize>,
    enum_by_lower: HashMap<String, usize>,
}

pub struct MemberLookup<'a> {
    /// The class the member was actually found on — may be a superclass.
    pub owner: &'a ApiClass,
    pub member: &'a ApiMember,
    /// False when only a different capitalisation matched.
    pub exact: bool,
}

impl DumpIndex {
    pub fn build(dump: ApiDump) -> Self {
        let by_lower = dump.classes.iter().enumerate().map(|(i, c)| (c.name.to_lowercase(), i)).collect();
        let by_name = dump.classes.iter().enumerate().map(|(i, c)| (c.name.clone(), i)).collect();
        let enum_by_lower = dump.enums.iter().enumerate().map(|(i, e)| (e.name.to_lowercase(), i)).collect();
        DumpIndex { classes: dump.classes, enums: dump.enums, by_lower, by_name, enum_by_lower }
    }

    pub fn class(&self, name: &str) -> Option<&ApiClass> {
        self.by_lower.get(&name.to_lowercase()).map(|&i| &self.classes[i])
    }

    pub fn enum_(&self, name: &str) -> Option<&ApiEnum> {
        self.enum_by_lower.get(&name.to_lowercase()).map(|&i| &self.enums[i])
    }

    /// The inheritance chain, guarded against a dump that names a class its own superclass.
    pub fn chain(&self, name: &str) -> Vec<&ApiClass> {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = self.class(name);
        while let Some(c) = current {
            if chain.len() >= 12 || !seen.insert(c.name.as_str()) {
                break;
            }
            chain.push(c);
            current = c.superclass.as_deref().and_then(|s| self.by_name.get(s)).map(|&i| &self.classes[i]);
        }
        chain
    }

    /// `Class.Member` through the chain, exact spelling first; a different capitalisation is
    /// still found (preferring the non-deprecated twin) but flagged.
    pub fn resolve_member(&self, class: &str, member: &str) -> Option<MemberLookup<'_>> {
        let chain = self.chain(class);
        for owner in &chain {
            if let Some(m) = owner.members.iter().find(|m| m.name == member) {
                return Some(MemberLookup { owner, member: m, exact: true });
            }
        }
        let target = member.to_lowercase();
        let mut fallback = None;
        for owner in &chain {
            for m in &owner.members {
                if m.name.to_lowercase() != target {
                    continue;
                }
                if !m.has_tag("Deprecated") {
                    return Some(MemberLookup { owner, member: m, exact: false });
                }
                fallback.get_or_insert(MemberLookup { owner, member: m, exact: false });
            }
        }
        fallback
    }

    pub fn suggest_classes(&self, name: &str, limit: usize) -> Vec<String> {
        nearest_names(name, self.classes.iter().map(|c| c.name.as_str()), limit)
    }

    pub fn suggest_members(&self, class: &str, member: &str, limit: usize) -> Vec<String> {
        let mut names: Vec<&str> = Vec::new();
        let mut seen = HashSet::new();
        for owner in self.chain(class) {
            for m in &owner.members {
                if seen.insert(m.name.as_str()) {
                    names.push(&m.name);
                }
            }
        }
        nearest_names(member, names, limit)
    }
}

pub async fn dump(ctx: &Arc<Ctx>) -> Result<Arc<DumpIndex>, Error> {
    let c = ctx.clone();
    ctx.dump
        .get(move || async move {
            let dump =
                cached_json(&c.cfg.cache_dir, "api-dump", DUMP_TTL, || async { c.http.fetch_json::<ApiDump>(API_DUMP_URL, TEXT).await })
                    .await?;
            Ok(DumpIndex::build(dump))
        })
        .await
}

/// Close enough to offer back: a contained name at least 40% as long as the other.
fn close_enough(target: &str, known: &str) -> bool {
    let (short, long) = if target.len() <= known.len() { (target, known) } else { (known, target) };
    short.len() >= 3 && long.contains(short) && short.len() as f64 / long.len() as f64 >= 0.4
}

/// Names close enough to `target` to be worth offering back, closest first.
pub fn nearest_names<'a>(target: &str, known: impl IntoIterator<Item = &'a str>, limit: usize) -> Vec<String> {
    let lower = target.to_lowercase();
    let mut near: Vec<&str> = known.into_iter().filter(|n| close_enough(&lower, &n.to_lowercase())).collect();
    near.sort_by(|a, b| {
        a.len().abs_diff(lower.len()).cmp(&b.len().abs_diff(lower.len())).then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
    });
    near.into_iter().take(limit).map(str::to_string).collect()
}

/* ------------------------------ reference pages ----------------------------- */

pub async fn find_datatype(ctx: &Arc<Ctx>, name: &str) -> Result<Option<String>, Error> {
    Ok(find_doc_path(ctx, &format!("{DOCS_ROOT}reference/engine/datatypes/{name}.yaml")).await?.map(|p| title_of(&p)))
}

pub async fn find_library(ctx: &Arc<Ctx>, name: &str) -> Result<Option<String>, Error> {
    Ok(find_doc_path(ctx, &format!("{DOCS_ROOT}reference/engine/libraries/{name}.yaml")).await?.map(|p| title_of(&p)))
}

/// A function or constant documented on a library or globals page.
pub struct DocMember {
    pub name: String,
    pub exact: bool,
    pub deprecated: bool,
    pub note: Option<String>,
    pub path: String,
}

fn member_name_line(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('-')?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let rest = rest.trim_start().strip_prefix("name:")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let token = rest.trim();
    (!token.is_empty() && !token.contains(char::is_whitespace)).then_some(token)
}

/// Member entries of a reference page, keyed by the name the docs give them.
pub fn reference_members(yaml: &str) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for block in split_member_blocks(yaml).into_iter().skip(1) {
        if let Some(name) = block.split('\n').find_map(member_name_line)
            && seen.insert(name.to_string())
        {
            out.push((name.to_string(), block.clone()));
        }
    }
    out
}

/// Whether a member block lists `Deprecated` under its own `tags:`.
pub fn block_is_deprecated(block: &str) -> bool {
    let lines: Vec<&str> = block.split('\n').collect();
    let Some(at) = lines.iter().position(|l| l.trim() == "tags:") else { return false };
    for line in &lines[at + 1..] {
        let Some(tag) = line.trim_start().strip_prefix('-').filter(|r| r.starts_with(char::is_whitespace)) else { break };
        let tag = tag.trim();
        if tag.is_empty() || tag.contains(char::is_whitespace) {
            break;
        }
        if tag == "Deprecated" {
            return true;
        }
    }
    false
}

async fn lookup_on_pages(ctx: &Arc<Ctx>, paths: &[String], name: &str) -> Result<Option<DocMember>, Error> {
    let fetches = paths.iter().map(|p| async move { fetch_doc(ctx, p).await.map(|y| (p.clone(), reference_members(&y))) });
    let pages: Vec<(String, Vec<(String, String)>)> =
        futures_util::future::join_all(fetches).await.into_iter().collect::<Result<_, _>>()?;
    let describe = |path: &str, doc_name: &str, block: &str, exact: bool| {
        let deprecated = block_is_deprecated(block);
        let note = if deprecated { block_deprecation_guidance(block).map(|r| clean_doc_prose(&r, Some(path))) } else { None };
        DocMember { name: doc_name.to_string(), exact, deprecated, note, path: path.to_string() }
    };
    for (path, members) in &pages {
        if let Some((n, b)) = members.iter().find(|(n, _)| n == name) {
            return Ok(Some(describe(path, n, b, true)));
        }
    }
    let lower = name.to_lowercase();
    for (path, members) in &pages {
        if let Some((n, b)) = members.iter().find(|(n, _)| n.to_lowercase() == lower) {
            return Ok(Some(describe(path, n, b, false)));
        }
    }
    Ok(None)
}

/// `task.wait`, `math.clamp`: a function or constant on one of Luau's libraries.
pub async fn library_member(ctx: &Arc<Ctx>, library: &str, member: &str) -> Result<Option<DocMember>, Error> {
    let path = resolve_doc_path(&format!("reference/engine/libraries/{library}.yaml"))?;
    lookup_on_pages(ctx, &[path], &format!("{library}.{member}")).await
}

pub const GLOBAL_PAGES: [&str; 2] = ["reference/engine/globals/LuaGlobals.yaml", "reference/engine/globals/RobloxGlobals.yaml"];

/// `wait`, `print`, `typeof`: a bare global function or value.
pub async fn global_member(ctx: &Arc<Ctx>, name: &str) -> Result<Option<DocMember>, Error> {
    let paths: Vec<String> = GLOBAL_PAGES.iter().map(|p| resolve_doc_path(p)).collect::<Result<_, _>>()?;
    lookup_on_pages(ctx, &paths, name).await
}

/// Split a reference page into member entries (the shallowest `- name:` lines), page fields first.
pub fn split_member_blocks(yaml: &str) -> Vec<String> {
    let indent_of = |line: &str| -> Option<usize> {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let rest = trimmed.strip_prefix('-')?;
        let after = rest.trim_start_matches([' ', '\t']);
        if after.len() == rest.len() {
            return None;
        }
        let after = after.strip_prefix("name:")?;
        after.starts_with([' ', '\t']).then_some(line.len() - trimmed.len())
    };
    let Some(top) = yaml.split('\n').filter_map(indent_of).min() else { return vec![yaml.to_string()] };
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in yaml.split('\n') {
        if indent_of(line) == Some(top) {
            blocks.push(std::mem::take(&mut current));
            current.push_str(line);
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }
    blocks.push(current);
    blocks
}

/// Whether a block names `member` the way the docs do: "Class.Member" or "Class:Member".
fn block_names_member(block: &str, member: &str) -> bool {
    block
        .split('\n')
        .filter_map(member_name_line)
        .any(|token| token.strip_suffix(member).is_some_and(|prefix| prefix.ends_with(['.', ':'])))
}

/// A `deprecation_message` from reference YAML: the page's own, or one member's guidance.
pub fn parse_deprecation_message(yaml: &str, member: Option<&str>) -> Option<String> {
    let blocks = split_member_blocks(yaml);
    match member {
        Some(m) => blocks.iter().find(|b| block_names_member(b, m)).and_then(|b| block_deprecation_guidance(b)),
        None => blocks.first().and_then(|b| block_deprecation_message(b)),
    }
}

fn is_block_indicator(s: &str) -> bool {
    matches!(s, "|" | ">" | "|-" | "|+" | ">-" | ">+")
}

/// One scalar field of a block, joined onto a single line.
fn block_scalar(block: &str, key: &str, paragraph: bool) -> Option<String> {
    let lines: Vec<&str> = block.split('\n').collect();
    let prefix = format!("{key}:");
    let at = lines.iter().position(|l| l.trim_start().starts_with(&prefix))?;
    let first = lines[at];
    let inline = first[first.find(':')? + 1..].trim();
    if !inline.is_empty() && !is_block_indicator(inline) {
        let v = inline.strip_prefix(['\'', '"']).unwrap_or(inline);
        let v = v.strip_suffix(['\'', '"']).unwrap_or(v).trim();
        return (!v.is_empty()).then(|| v.to_string());
    }
    if !is_block_indicator(inline) {
        return None;
    }
    let indent = first.len() - first.trim_start().len();
    let mut body = Vec::new();
    for line in &lines[at + 1..] {
        if line.trim().is_empty() {
            if paragraph && !body.is_empty() {
                break;
            }
            continue;
        }
        if line.len() - line.trim_start().len() <= indent {
            break;
        }
        body.push(line.trim());
    }
    let text = body.join(" ").trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn block_deprecation_message(block: &str) -> Option<String> {
    block_scalar(block, "deprecation_message", false)
}

pub fn block_summary(block: &str) -> Option<String> {
    block_scalar(block, "summary", true)
}

re!(RE_DEPRECATION_WORDS, r"(?i)supersed|deprecat|replace|instead|obsolete|no longer|legacy");

/// What to use instead: the `deprecation_message`, or — since most are empty — the opening
/// paragraph of the description when it talks about the deprecation.
pub fn block_deprecation_guidance(block: &str) -> Option<String> {
    block_deprecation_message(block).or_else(|| block_scalar(block, "description", true).filter(|lead| RE_DEPRECATION_WORDS.is_match(lead)))
}

/// Best-effort replacement guidance from the docs for a deprecated class or member.
pub async fn deprecation_note(ctx: &Arc<Ctx>, class: &str, member: Option<&str>) -> Option<String> {
    let path = resolve_doc_path(&format!("reference/engine/classes/{class}.yaml")).ok()?;
    let yaml = fetch_doc(ctx, &path).await.ok()?;
    let raw = parse_deprecation_message(&yaml, member).or_else(|| member.and_then(|_| parse_deprecation_message(&yaml, None)))?;
    Some(clean_doc_prose(&raw, Some(&path)))
}

pub struct MemberDocs {
    pub summary: Option<String>,
    pub deprecation: Option<String>,
}

/// What the docs say about one class member: its summary, and what replaced it if anything.
pub async fn member_docs(ctx: &Arc<Ctx>, class: &str, member: &str) -> Option<MemberDocs> {
    let path = resolve_doc_path(&format!("reference/engine/classes/{class}.yaml")).ok()?;
    let yaml = fetch_doc(ctx, &path).await.ok()?;
    let blocks = split_member_blocks(&yaml);
    let block = blocks.iter().skip(1).find(|b| block_names_member(b, member))?;
    Some(MemberDocs {
        summary: block_summary(block).map(|s| clean_doc_prose(&s, Some(&path))),
        deprecation: block_deprecation_guidance(block).map(|s| clean_doc_prose(&s, Some(&path))),
    })
}

#[derive(Debug, PartialEq)]
pub struct MemberSecurity {
    pub level: String,
    /// "all" | "read" | "write"
    pub scope: &'static str,
}

/// The security a member sits behind, and which half of the access it covers.
pub fn security_of(member: &ApiMember) -> Option<MemberSecurity> {
    match member.security.as_ref()? {
        Security::Level(s) if s == "None" => None,
        Security::Level(s) => Some(MemberSecurity { level: s.clone(), scope: "all" }),
        Security::Split { read, write } => {
            let read = read.as_deref().filter(|r| *r != "None");
            let write = write.as_deref().filter(|w| *w != "None");
            match (read, write) {
                (Some(r), Some(w)) if r == w => Some(MemberSecurity { level: r.into(), scope: "all" }),
                (Some(r), Some(w)) => Some(MemberSecurity { level: format!("{r}/{w}"), scope: "all" }),
                (Some(r), None) => Some(MemberSecurity { level: r.into(), scope: "read" }),
                (None, Some(w)) => Some(MemberSecurity { level: w.into(), scope: "write" }),
                (None, None) => None,
            }
        }
    }
}

pub fn signature(m: &ApiMember) -> String {
    let ty = |t: &Option<TypeRef>, fallback: &str| t.as_ref().and_then(|t| t.name.clone()).unwrap_or_else(|| fallback.to_string());
    match m.member_type.as_str() {
        "Function" | "Callback" => {
            let params: Vec<String> = m
                .parameters
                .iter()
                .map(|p| {
                    let d = p.default.as_ref().map_or(String::new(), |d| format!(" = {d}"));
                    format!("{}: {}{d}", p.name, ty(&p.ty, "any"))
                })
                .collect();
            // The dump names "returns nothing" `null`; Luau writes it ().
            let ret = match m.return_type.as_ref().and_then(|t| t.name.as_deref()) {
                None | Some("null") => "()".to_string(),
                Some(r) => r.to_string(),
            };
            format!("{}({}) -> {ret}", m.name, params.join(", "))
        }
        "Event" => {
            let params: Vec<String> = m.parameters.iter().map(|p| format!("{}: {}", p.name, ty(&p.ty, "any"))).collect();
            format!("{}({})", m.name, params.join(", "))
        }
        _ => format!("{}: {}", m.name, ty(&m.value_type, "unknown")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_terms() {
        assert_eq!(
            doc_url("content/en-us/reference/engine/classes/DataStoreService.yaml"),
            "https://create.roblox.com/docs/reference/engine/classes/DataStoreService"
        );
        assert_eq!(
            doc_url("content/en-us/cloud-services/data-stores/index.md"),
            "https://create.roblox.com/docs/cloud-services/data-stores"
        );
        assert_eq!(query_terms("how do I fix data store limits"), ["fix", "data", "store", "limits"]);
        assert_eq!(query_terms("how to use it"), ["how", "to", "use", "it"]);
        let exact =
            score_path("content/en-us/reference/engine/classes/DataStoreService.yaml", &["datastoreservice".into()], "datastoreservice");
        let partial = score_path("content/en-us/cloud-services/data-stores/index.md", &["data".into(), "store".into()], "datastore");
        assert!(exact > partial);
        assert_eq!(score_path("content/en-us/ui/buttons.md", &["datastore".into()], "datastore"), 0.0);
    }

    #[test]
    fn signatures_and_security() {
        let m: ApiMember = serde_json::from_str(r#"{"MemberType":"Function","Name":"GetDataStore","ReturnType":{"Name":"GlobalDataStore"},"Parameters":[{"Name":"name","Type":{"Name":"string"}},{"Name":"scope","Type":{"Name":"string"},"Default":"global"}],"Tags":["Yields",{"PreferredDescriptor":{"Name":"x"}}]}"#).unwrap();
        assert_eq!(signature(&m), "GetDataStore(name: string, scope: string = global) -> GlobalDataStore");
        assert_eq!(m.tags, ["Yields"]);
        let p: ApiMember = serde_json::from_str(
            r#"{"MemberType":"Property","Name":"Health","ValueType":{"Name":"float"},"Security":{"Read":"None","Write":"PluginSecurity"}}"#,
        )
        .unwrap();
        assert_eq!(signature(&p), "Health: float");
        assert_eq!(security_of(&p), Some(MemberSecurity { level: "PluginSecurity".into(), scope: "write" }));
        let s: ApiMember = serde_json::from_str(r#"{"MemberType":"Function","Name":"X","Security":"RobloxScriptSecurity"}"#).unwrap();
        assert_eq!(security_of(&s).unwrap().scope, "all");
        let n: ApiMember =
            serde_json::from_str(r#"{"MemberType":"Property","Name":"X","Security":{"Read":"None","Write":"None"}}"#).unwrap();
        assert_eq!(security_of(&n), None);
        let tuple: ApiMember = serde_json::from_str(r#"{"MemberType":"Function","Name":"ComputeR15BodyBoundingBox","Parameters":[],"ReturnType":[{"Category":"DataType","Name":"CFrame"},{"Category":"DataType","Name":"Vector3"}]}"#).unwrap();
        assert_eq!(signature(&tuple), "ComputeR15BodyBoundingBox() -> (CFrame, Vector3)");
    }

    /// The real dump, when a copy is on disk (set DEVFORUM_DUMP_FILE); skipped otherwise.
    #[test]
    fn parses_the_real_dump() {
        let Ok(path) = std::env::var("DEVFORUM_DUMP_FILE") else { return };
        let bytes = std::fs::read(path).unwrap();
        let dump: ApiDump = serde_json::from_slice(&bytes).unwrap();
        assert!(dump.classes.len() > 500 && dump.enums.len() > 100);
        let index = DumpIndex::build(dump);
        assert!(index.resolve_member("Part", "Touched").is_some());
    }

    #[test]
    fn doc_paths_stay_inside() {
        let root = DOCS_ROOT;
        assert_eq!(resolve_doc_path("cloud-services/data-stores/index.md").unwrap(), format!("{root}cloud-services/data-stores/index.md"));
        assert_eq!(resolve_doc_path("/cloud-services/x.md").unwrap(), format!("{root}cloud-services/x.md"));
        assert_eq!(resolve_doc_path("guides/./intro.md").unwrap(), format!("{root}guides/intro.md"));
        assert_eq!(resolve_doc_path("tutorials\\index.md").unwrap(), format!("{root}tutorials/index.md"));
        for p in [
            "../../README.md",
            "content/en-us/../../README.md",
            "../",
            "%2e%2e/%2e%2e/README.md",
            "a/%2E%2E/%2e%2e/%2e%2e/x",
            "..\\..\\README.md",
            "..%2f..%2fREADME.md",
        ] {
            assert!(resolve_doc_path(p).unwrap_err().to_string().contains("outside the documentation tree"), "{p}");
        }
    }

    #[test]
    fn prose_cleanup() {
        let from = Some("content/en-us/reference/engine/classes/BodyVelocity.yaml");
        assert_eq!(
            clean_doc_prose("Use `Class.LinearVelocity`, see the [notes](../../../physics/mover-constraints.md#legacy).", from),
            "Use `LinearVelocity`, see the [notes](https://create.roblox.com/docs/physics/mover-constraints#legacy)."
        );
        assert!(
            clean_doc_prose("[std](/cloud/reference/DataStoreEntry)", None)
                .ends_with("(https://create.roblox.com/docs/cloud/reference/DataStoreEntry)")
        );
        assert_eq!(clean_doc_prose("Set `Enum.Material.Neon` on `Class.Part`.", None), "Set `Enum.Material.Neon` on `Part`.");
        assert_eq!(clean_doc_prose("See [notes](../../../../elsewhere.md).", from), "See notes.");
        assert_eq!(clean_doc_prose("See [notes](https://example.com).", None), "See [notes](https://example.com).");
        assert_eq!(clean_doc_prose("includes `Class.Constraint|Constraints` that", None), "includes `Constraints` that");
        assert_eq!(clean_doc_prose("see `Enum.KeyCode|key codes`", None), "see `key codes`");
        assert_eq!(clean_doc_prose("see `Datatype.Vector3:Cross()|Cross()` for this", None), "see `Cross()` for this");
        assert_eq!(clean_doc_prose("`Class.Humanoid:MoveTo()|MoveTo()`", None), "`MoveTo()`");
        assert_eq!(clean_doc_prose("call `Datatype.CFrame.fromEulerAnglesXYZ()`", None), "call `CFrame.fromEulerAnglesXYZ()`");
        assert_eq!(clean_doc_prose("wrap it in `Global.LuaGlobals.pcall()`", None), "wrap it in `pcall()`");
        assert_eq!(clean_doc_prose("`Global.RobloxGlobals.warn()`", None), "`warn()`");
        assert_eq!(clean_doc_prose("`Global.LuaGlobals.require`", None), "`require`");
        assert_eq!(clean_doc_prose("`Global.LuaGlobals.pcall()|pcall()`", None), "`pcall()`");
        assert_eq!(clean_doc_prose("`Library.table.insert()`", None), "`table.insert()`");
        let prose = clean_doc_prose(
            "A 3&times;3 matrix.\n<table><tr><th>A</th></tr><tr><td>R00</td></tr></table>\n<code>CFrame.LookVector|LookVector</code> and &lt;b&gt;",
            None,
        );
        assert!(prose.contains("3×3 matrix"));
        assert!(prose.contains("| A |\n| --- |\n| R00 |"), "{prose}");
        assert!(prose.contains("`LookVector` and &lt;b&gt;"), "{prose}");
    }

    #[test]
    fn mdx_unwrapped() {
        let page = "import Foo from '../includes/studio/x.md'\n<Grid container spacing={4}>\n<Button href=\"../physics/constraints/linear-velocity.md\">Linear Velocity</Button>\n<p></p>\n<CardMedia component=\"video\" src=\"../a.mp4\" />\n<figcaption>`Class.LinearVelocity` applies force</figcaption>\n</Grid>";
        assert_eq!(
            clean_doc_prose(page, Some("content/en-us/physics/mover-constraints.md")).trim(),
            "Linear Velocity\n\n`LinearVelocity` applies force"
        );
    }

    #[test]
    fn guide_and_yaml_shaping() {
        let page = render_guide(
            "---\ntitle: Data stores\ndescription: How to store persistent data.\ncomments: The Creator Hub links to some of the anchors on this page.\n---\nThe `DataStoreService` lets you store data.\n",
        );
        assert!(page.starts_with("# Data stores"));
        assert!(page.contains("How to store persistent data.") && page.contains("DataStoreService"));
        assert!(!page.contains("comments:") && !page.contains("---"));
        assert_eq!(render_guide("# Already Markdown\n\nbody"), "# Already Markdown\n\nbody");
        let out = clean_reference_yaml(
            "# This file is automatically generated.\n# To submit a bug report, see …\nname: Vector3\ntype: datatype\ncode_samples: []\ntags: []\ndeprecation_message: ''\nsummary: |\n  A 3D value.\n",
        );
        assert!(out.starts_with("name: Vector3"));
        assert!(!out.contains("automatically generated") && !out.contains("code_samples") && !out.contains("deprecation_message"));
        assert!(out.contains("summary: |\n  A 3D value."));
        assert!(!clean_reference_yaml("params:\n  - name: x\n    default:\n    type: number\n").contains("default"));
        let yaml = "name: DataStoreRequestType\ntype: enum\nsummary: |\n  Indicates the type of data\n  store request being made.\ndescription: |\n  Categorizes operations.\n";
        assert_eq!(reference_summary(yaml).as_deref(), Some("Indicates the type of data store request being made."));
        assert_eq!(reference_summary("name: X\ntype: class\n"), None);
    }

    #[test]
    fn deprecations() {
        let yaml = "name: BodyVelocity\ndeprecation_message: |\n  This object is deprecated and should not be used for new work.\n  Use LinearVelocity instead.\nproperties:\n  - name: BodyVelocity.Velocity\n    deprecation_message: 'Use LinearVelocity.VectorVelocity.'\n    security:\n      read: None\n  - name: BodyVelocity.P\n    deprecation_message: ''";
        assert!(parse_deprecation_message(yaml, None).unwrap().contains("Use LinearVelocity instead"));
        assert_eq!(parse_deprecation_message(yaml, Some("Velocity")).as_deref(), Some("Use LinearVelocity.VectorVelocity."));
        assert_eq!(parse_deprecation_message(yaml, Some("P")), None);
        assert_eq!(parse_deprecation_message(yaml, Some("Missing")), None);
        assert_eq!(parse_deprecation_message("name: X\n", Some("a[")), None);
        let yaml = "name: Humanoid\nproperties:\n  - name: Humanoid.Torso\n    deprecation_message: |\n      Use Humanoid.RootPart instead.\nmethods:\n  - name: Humanoid:LoadAnimation\n    parameters:\n      - name: animation\n    deprecation_message: |\n      Use Animator:LoadAnimation instead.\n";
        assert_eq!(parse_deprecation_message(yaml, Some("Torso")).as_deref(), Some("Use Humanoid.RootPart instead."));
        assert_eq!(parse_deprecation_message(yaml, Some("LoadAnimation")).as_deref(), Some("Use Animator:LoadAnimation instead."));
        let block = "  - name: Model:SetPrimaryPartCFrame\n    description: |\n      This function has been superseded by `PVInstance:PivotTo()`.\n\n      Sets the CFrame.\n    deprecation_message: ''\n";
        assert_eq!(block_deprecation_guidance(block).as_deref(), Some("This function has been superseded by `PVInstance:PivotTo()`."));
        assert_eq!(block_deprecation_guidance(&block.replace("superseded by `PVInstance:PivotTo()`", "a plain sentence")), None);
    }

    #[test]
    fn member_blocks() {
        let yaml = "name: Humanoid\ntype: class\nmethods:\n  - name: Humanoid:LoadAnimation\n    parameters:\n      - name: animation\n        type: Animation\n    tags:\n      - Deprecated\n    deprecation_message: |\n      Use Animator:LoadAnimation instead.\n  - name: Humanoid:MoveTo\n    summary: |\n      Moves the humanoid.\n";
        let blocks = split_member_blocks(yaml);
        assert_eq!(blocks.len(), 3);
        assert!(blocks[1].contains("LoadAnimation") && blocks[1].contains("Use Animator:LoadAnimation instead."));
        assert!(block_is_deprecated(&blocks[1]));
        assert!(blocks[2].contains("MoveTo"));
    }

    #[test]
    fn suggestions_stay_close() {
        let members = ["Magnitude", "Unit", "Cross", "Dot", "FuzzyEq", "new"];
        assert_eq!(nearest_names("magnitud", members, 6), ["Magnitude"]);
        assert!(nearest_names("TotallyFakeMember", members, 6).is_empty());
        assert!(nearest_names("SomeClassThatDoesNotExist", ["Hat", "Humanoid"], 8).is_empty());
    }
}
