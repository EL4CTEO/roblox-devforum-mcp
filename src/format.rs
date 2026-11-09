//! HTML -> Markdown, noise stripping and token budgeting.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::time;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).expect($pat));
    };
}
pub(crate) use re;

fn typographic(name: &str) -> Option<&'static str> {
    Some(match name {
        "nbsp" => " ",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "rsquo" | "lsquo" => "'",
        "ldquo" | "rdquo" => "\"",
        "middot" => "·",
        "times" => "×",
        "divide" => "÷",
        "dagger" => "†",
        "Dagger" => "‡",
        "deg" => "°",
        "plusmn" => "±",
        "le" => "≤",
        "ge" => "≥",
        "ne" => "≠",
        "asymp" => "≈",
        "infin" => "∞",
        "rarr" => "→",
        "larr" => "←",
        "harr" => "↔",
        "bull" => "•",
        "trade" => "™",
        "reg" => "®",
        "copy" => "©",
        "minus" => "−",
        _ => return None,
    })
}

fn named(name: &str) -> Option<&'static str> {
    match name {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        _ => typographic(name),
    }
}

fn lookup(name: &str, table: fn(&str) -> Option<&'static str>) -> Option<&'static str> {
    table(name).or_else(|| table(&name.to_ascii_lowercase()))
}

re!(RE_NAMED, r"(?i)&([a-z]+);");
re!(RE_ENTITY, r"(?i)&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));");
re!(RE_TAG, r"<[^>]+>");

/// Decode only the typographic named entities, leaving &lt; &gt; &amp; as written.
pub fn decode_typography(input: &str) -> Cow<'_, str> {
    if !input.contains('&') {
        return Cow::Borrowed(input);
    }
    RE_NAMED.replace_all(input, |c: &Captures| lookup(&c[1], typographic).map(str::to_string).unwrap_or_else(|| c[0].to_string()))
}

/// One pass over every kind of reference, so "&#38;lt;" decodes to "&lt;" and not "<".
pub fn decode_entities(input: &str) -> Cow<'_, str> {
    if !input.contains('&') {
        return Cow::Borrowed(input);
    }
    RE_ENTITY.replace_all(input, |c: &Captures| {
        let point = if let Some(hex) = c.get(1) {
            Some(u32::from_str_radix(hex.as_str(), 16).ok())
        } else {
            c.get(2).map(|dec| dec.as_str().parse::<u32>().ok())
        };
        match point {
            // A reference outside Unicode is left as written.
            Some(p) => p.and_then(char::from_u32).map(String::from).unwrap_or_else(|| c[0].to_string()),
            None => lookup(&c[3], named).map(str::to_string).unwrap_or_else(|| c[0].to_string()),
        }
    })
}

pub fn strip_tags(input: &str) -> Cow<'_, str> {
    if !input.contains('<') {
        return Cow::Borrowed(input);
    }
    RE_TAG.replace_all(input, "")
}

/// Pair each open tag `open` finds (group 1 = tag name) with the first matching close tag,
/// as a lazy regex with a backreference would, and replace the whole element.
fn replace_paired<'a>(s: &'a str, open: &Regex, mut f: impl FnMut(&Captures, &str) -> String) -> Cow<'a, str> {
    let mut out = String::new();
    let mut last = 0;
    let mut pos = 0;
    let mut lower: Option<String> = None;
    while let Some(caps) = open.captures_at(s, pos) {
        let m = caps.get(0).unwrap();
        let low = lower.get_or_insert_with(|| s.to_ascii_lowercase());
        let close = format!("</{}>", caps[1].to_ascii_lowercase());
        match low[m.end()..].find(&close) {
            Some(rel) => {
                let body_end = m.end() + rel;
                out.push_str(&s[last..m.start()]);
                out.push_str(&f(&caps, &s[m.end()..body_end]));
                last = body_end + close.len();
                pos = last;
            }
            None => pos = m.start() + 1,
        }
        if pos > s.len() {
            break;
        }
    }
    if last == 0 && out.is_empty() {
        return Cow::Borrowed(s);
    }
    out.push_str(&s[last..]);
    Cow::Owned(out)
}

/// Bodies of every paired element, in order (table cells).
fn paired_bodies<'a>(s: &'a str, open: &Regex) -> Vec<&'a str> {
    let lower = s.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(caps) = open.captures_at(s, pos) {
        let m = caps.get(0).unwrap();
        let close = format!("</{}>", caps[1].to_ascii_lowercase());
        match lower[m.end()..].find(&close) {
            Some(rel) => {
                out.push(&s[m.end()..m.end() + rel]);
                pos = m.end() + rel + close.len();
            }
            None => pos = m.start() + 1,
        }
    }
    out
}

re!(RE_BR, r"(?i)<br\s*/?>");
re!(RE_CODE, r"(?is)<code\b[^>]*>(.*?)</code>");
re!(RE_STRONG_B, r"(?i)<(strong|b)\b[^>]*>");
re!(RE_EM_I, r"(?i)<(em|i)\b[^>]*>");
re!(RE_LINK, r#"(?is)<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#);
re!(RE_WS, r"\s+");
re!(RE_TABLE, r"(?is)<table\b[^>]*>(.*?)</table>");
re!(RE_TR, r"(?is)<tr\b[^>]*>(.*?)</tr>");
re!(RE_CELL, r"(?i)<(t[hd])\b[^>]*>");

/// One table cell as a single line of Markdown: links, emphasis and code survive, layout does not.
fn cell_text(html: &str) -> String {
    let s = RE_BR.replace_all(html, " ");
    let s = RE_CODE.replace_all(&s, "`$1`");
    let s = replace_paired(&s, &RE_STRONG_B, |_, body| format!("**{body}**"));
    let s = replace_paired(&s, &RE_EM_I, |_, body| format!("*{body}*"));
    let s = RE_LINK.replace_all(&s, |c: &Captures| {
        let href = &c[1];
        let text = strip_tags(&c[2]).trim().to_string();
        if !text.is_empty() && text != href { format!("[{text}]({href})") } else { href.to_string() }
    });
    let s = strip_tags(&s);
    RE_WS.replace_all(&s, " ").replace('|', "\\|").trim().to_string()
}

/// HTML tables as Markdown ones, so a two-column table keeps its pairing.
pub fn html_tables_to_markdown(html: &str) -> Cow<'_, str> {
    if !html.contains("<table") && !html.contains("<TABLE") {
        return Cow::Borrowed(html);
    }
    RE_TABLE.replace_all(html, |c: &Captures| {
        let rows: Vec<Vec<String>> = RE_TR
            .captures_iter(&c[1])
            .map(|row| paired_bodies(row.get(1).unwrap().as_str(), &RE_CELL).into_iter().map(cell_text).collect())
            .collect();
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        if rows.is_empty() || width == 0 {
            return c[0].to_string();
        }
        let line = |cells: &[String]| {
            let padded: Vec<&str> = (0..width).map(|i| cells.get(i).map_or("", String::as_str)).collect();
            format!("| {} |", padded.join(" | "))
        };
        let mut out = vec![line(&rows[0]), line(&vec!["---".to_string(); width])];
        out.extend(rows[1..].iter().map(|r| line(r)));
        format!("\n\n{}\n\n", out.join("\n"))
    })
}

re!(RE_QUOTE_KEEP, r#"(?is)<aside\b[^>]*class="[^"]*quote[^"]*"[^>]*>(.*?)</aside>"#);
re!(RE_QUOTE_CONTROLS, r#"(?is)<div\b[^>]*class="[^"]*quote-controls[^"]*"[^>]*>\s*</div>"#);
re!(RE_AVATAR, r#"(?i)<img\b[^>]*class="[^"]*avatar[^"]*"[^>]*>"#);
re!(RE_QUOTE_TITLE, r#"(?is)<div\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>(.*?)</div>"#);
re!(RE_QUOTE_DROP, r#"(?is)<aside\b[^>]*class="[^"]*quote[^"]*".*?</aside>"#);
re!(RE_ASIDE, r"(?is)<aside\b.*?</aside>");
re!(RE_NOISE, r"(?i)<(script|style|svg|noscript)\b");
re!(RE_LIGHTBOX, r#"(?is)<div\b[^>]*class="[^"]*lightbox-wrapper[^"]*".*?(<img\b[^>]*>).*?</a>"#);
re!(RE_ALT, r#"(?i)\balt="([^"]*)""#);
re!(RE_CHROME_DIV, r#"(?is)<div\b[^>]*class="[^"]*(?:lightbox-wrapper|meta|onebox-body)[^"]*".*?</div>"#);
re!(RE_PRE_CODE, r"(?is)<pre\b[^>]*>\s*<code\b([^>]*)>(.*?)</code>\s*</pre>");
re!(RE_LANG, r"(?i)lang-([A-Za-z0-9_+-]+)");
re!(RE_PRE, r"(?is)<pre\b[^>]*>(.*?)</pre>");
re!(RE_BLOCK_END, r"(?i)</(?:p|div|section|blockquote|h[1-6])>");
re!(RE_H_OPEN, r"(?i)<h([1-6])\b[^>]*>");
re!(RE_LI_OPEN, r"(?i)<li\b[^>]*>");
re!(RE_LI_CLOSE, r"(?i)</li>");
re!(RE_EMOJI, r#"(?i)<img\b[^>]*class="[^"]*emoji[^"]*"[^>]*alt="([^"]*)"[^>]*>"#);
re!(RE_IMG_ALT, r#"(?i)<img\b[^>]*alt="([^"]*)"[^>]*>"#);
re!(RE_IMG, r"(?i)<img\b[^>]*>");
re!(RE_NL3, r"\n{3,}");
re!(RE_PARKED, "\u{0}([0-9]+)\u{0}");

/// Convert a Discourse `cooked` HTML post into compact Markdown. Code blocks are preserved
/// verbatim; quotes (unless kept), images and onebox chrome are reduced to what they say.
pub fn html_to_markdown(html: &str, keep_quotes: bool) -> String {
    if html.is_empty() {
        return String::new();
    }
    // A quote in a reply re-quotes something already on screen; the first post of a topic has
    // nothing earlier to quote, so there the block is real content and its title bar becomes
    // "name wrote:".
    let s: Cow<str> = if keep_quotes {
        RE_QUOTE_KEEP.replace_all(html, |c: &Captures| {
            let body = RE_QUOTE_CONTROLS.replace_all(&c[1], "");
            let body = RE_AVATAR.replace_all(&body, "");
            RE_QUOTE_TITLE
                .replacen(&body, 1, |t: &Captures| {
                    let name = strip_tags(&t[1]).trim().to_string();
                    let name = name.strip_suffix(':').unwrap_or(&name).to_string();
                    if name.is_empty() { String::new() } else { format!("\n{name} wrote:\n") }
                })
                .into_owned()
        })
    } else {
        RE_QUOTE_DROP.replace_all(html, "\n[quoted earlier reply]\n")
    };
    let s = RE_ASIDE.replace_all(&s, "").into_owned();
    let s = replace_paired(&s, &RE_NOISE, |_, _| String::new()).into_owned();
    // An uploaded screenshot keeps the caption its poster gave it.
    let s = RE_LIGHTBOX.replace_all(&s, |c: &Captures| match RE_ALT.captures(&c[1]) {
        Some(a) if !a[1].is_empty() => format!("\n[image: {}]\n", &a[1]),
        _ => "\n[image]\n".to_string(),
    });
    let s = RE_CHROME_DIV.replace_all(&s, "");

    // Code is decoded once and parked outside the string until the very end, so the tag strip
    // and entity decode that run over the whole post never touch it.
    let mut code: Vec<String> = Vec::new();
    let mut park = |text: String| -> String {
        code.push(text);
        format!("\u{0}{}\u{0}", code.len() - 1)
    };
    let s = RE_PRE_CODE.replace_all(&s, |c: &Captures| {
        let lang = RE_LANG.captures(&c[1]).map_or("lua".to_string(), |l| l[1].to_string());
        let body = decode_entities(&strip_tags(&c[2])).trim_end().to_string();
        format!("\n\n{}\n\n", park(format!("```{lang}\n{body}\n```")))
    });
    let s = RE_PRE.replace_all(&s, |c: &Captures| {
        let body = decode_entities(&strip_tags(&c[1])).trim().to_string();
        format!("\n\n{}\n\n", park(format!("```\n{body}\n```")))
    });
    let s = RE_CODE.replace_all(&s, |c: &Captures| park(format!("`{}`", decode_entities(&strip_tags(&c[1])).trim())));
    let s = html_tables_to_markdown(&s).into_owned();

    let s = RE_BR.replace_all(&s, "\n");
    let s = RE_BLOCK_END.replace_all(&s, "\n\n");
    let s = RE_H_OPEN.replace_all(&s, |c: &Captures| format!("\n\n{} ", "#".repeat(c[1].parse().unwrap_or(1))));
    let s = RE_LI_OPEN.replace_all(&s, "\n- ");
    let s = RE_LI_CLOSE.replace_all(&s, "");
    let s = replace_paired(&s, &RE_STRONG_B, |_, body| format!("**{}**", strip_tags(body).trim()));
    let s = replace_paired(&s, &RE_EM_I, |_, body| format!("*{}*", strip_tags(body).trim()));
    let s = RE_EMOJI.replace_all(&s, "$1");
    let s = RE_IMG_ALT.replace_all(&s, |c: &Captures| if c[1].is_empty() { "[image]".to_string() } else { format!("[image: {}]", &c[1]) });
    let s = RE_IMG.replace_all(&s, "[image]");
    let s = RE_LINK.replace_all(&s, |c: &Captures| {
        let href = &c[1];
        let text = strip_tags(&c[2]).trim().to_string();
        // Heading anchors carry no text; their href would land inside the heading.
        if text.is_empty() {
            String::new()
        } else if text == href {
            href.to_string()
        } else {
            format!("[{text}]({href})")
        }
    });
    let stripped = strip_tags(&s);
    let decoded = decode_entities(&stripped);

    let lines: Vec<&str> = decoded.split('\n').map(|l| l.trim_end_matches([' ', '\t'])).filter(|l| l.trim() != ">").collect();
    let joined = pull_up_markers(&lines);
    let out = RE_NL3.replace_all(&joined, "\n\n");
    let out = out.trim();
    if code.is_empty() {
        return out.to_string();
    }
    RE_PARKED
        .replace_all(out, |c: &Captures| c[1].parse::<usize>().ok().and_then(|i| code.get(i)).cloned().unwrap_or_default())
        .into_owned()
}

fn is_bare_marker(line: &str) -> bool {
    let t = line.trim_end_matches([' ', '\t']);
    t == "-" || t == "*" || (!t.is_empty() && t.len() <= 6 && t.bytes().all(|b| b == b'#'))
}

/// A heading's anchor or a list marker left alone on its line ("##", "-") is pulled onto
/// the text that follows it, across blank lines.
fn pull_up_markers(lines: &[&str]) -> String {
    let mut out = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    let mut pending = String::new();
    let mut wrote = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if is_bare_marker(line) {
            let next = lines[i + 1..].iter().position(|l| !l.trim_start_matches([' ', '\t']).is_empty());
            if let Some(offset) = next {
                let marker = line.trim_end_matches([' ', '\t']);
                pending.push_str(marker);
                pending.push(' ');
                i += 1 + offset;
                continue;
            }
        }
        if wrote {
            out.push('\n');
        }
        wrote = true;
        if pending.is_empty() {
            out.push_str(line);
        } else {
            out.push_str(&pending);
            out.push_str(line.trim_start_matches([' ', '\t']));
            pending.clear();
        }
        i += 1;
    }
    out
}

/// "1 reply" / "2 replies".
pub fn plural(count: i64, word: &str) -> String {
    format!("{count} {}{}", word, if count == 1 { "" } else { "s" })
}

pub fn plural_with(count: i64, word: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { word } else { plural })
}

/// Trim text to a token budget (≈4 characters per token) on a paragraph boundary where
/// possible, closing any code fence the cut left open.
pub fn truncate(text: &str, max_tokens: usize, hint: &str) -> String {
    let max_chars = max_tokens * 4;
    if text.len() <= max_chars {
        return text.to_string();
    }
    let Some((cut_end, _)) = text.char_indices().nth(max_chars) else {
        return text.to_string();
    };
    let cut = &text[..cut_end];
    let boundary = cut.rfind("\n\n").max(cut.rfind(". "));
    let kept = match boundary {
        Some(b) if b as f64 > cut.len() as f64 * 0.5 => &cut[..b],
        _ => cut,
    };
    let fences = kept.split('\n').filter(|l| l.starts_with("```")).count();
    let close = if fences % 2 == 1 { "\n```" } else { "" };
    let hint = if hint.is_empty() { String::new() } else { format!(", {hint}") };
    format!("{}{close}\n\n…[truncated{hint}]", kept.trim_end())
}

/// ISO date -> "3 days ago", counted in calendar days (UTC).
pub fn relative_date(iso: Option<&str>) -> String {
    let Some(then) = iso.and_then(time::parse_iso) else { return "unknown".into() };
    let days = ((time::utc_midnight(time::now_ms()) - time::utc_midnight(then)) as f64 / time::DAY_MS as f64).round() as i64;
    match days {
        d if d <= 0 => "today".into(),
        1 => "1 day ago".into(),
        d if d < 30 => format!("{d} days ago"),
        d if d < 365 => format!("{} mo ago", d / 30),
        d => {
            let years = format!("{:.1}", d as f64 / 365.0);
            format!("{} yr ago", years.strip_suffix(".0").unwrap_or(&years))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::{DAY_MS, now_ms};

    fn iso(ms: i64) -> String {
        let secs = ms.div_euclid(1000);
        let day = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        format!("{}T{:02}:{:02}:{:02}Z", crate::time::ymd(day * DAY_MS), rem / 3600, rem / 60 % 60, rem % 60)
    }

    #[test]
    fn keeps_fenced_code_and_drops_chrome() {
        let html = "<p>Broken since <b>today</b>.</p><pre><code class=\"lang-lua\">local ok = pcall(function()\n\tprint(&quot;hi&quot;)\nend)</code></pre><aside class=\"quote\"><blockquote>old reply</blockquote></aside><script>bad()</script>";
        let md = html_to_markdown(html, false);
        assert!(md.contains("```lua"));
        assert!(md.contains("print(\"hi\")"));
        assert!(md.contains("**today**"));
        assert!(md.contains("[quoted earlier reply]"));
        assert!(!md.contains("bad()"));
    }

    #[test]
    fn links_lists_images() {
        let md = html_to_markdown(
            "<ul><li>one</li><li>two</li></ul><a href=\"https://x.dev/a\">docs</a><img alt=\"screenshot\" src=\"a.png\">",
            false,
        );
        assert!(md.contains("- one\n- two"), "{md}");
        assert!(md.contains("[docs](https://x.dev/a)"));
        assert!(md.contains("[image: screenshot]"));
    }

    #[test]
    fn entities() {
        assert_eq!(decode_entities("a &amp; b &#65; &#x42; &hellip;"), "a & b A B …");
        assert_eq!(decode_entities("&#99999999; &#x110000;"), "&#99999999; &#x110000;");
        assert_eq!(decode_entities("&#38;lt;b&#38;gt; &amp;lt; &#x3C;"), "&lt;b&gt; &lt; <");
    }

    #[test]
    fn truncation() {
        let long = "sentence. ".repeat(500);
        let out = truncate(&long, 50, "use get_replies");
        assert!(out.len() < long.len());
        assert!(out.contains("use get_replies"));
        assert_eq!(truncate("short", 50, ""), "short");
        let cut = truncate(&format!("intro\n\n```lua\n{}```", "local x = 1\n".repeat(100)), 50, "");
        assert_eq!(cut.split('\n').filter(|l| l.starts_with("```")).count() % 2, 0);
        assert!(cut.ends_with("```\n\n…[truncated]"), "{cut}");
    }

    #[test]
    fn relative_dates() {
        let days = |n: i64| iso(now_ms() - n * DAY_MS);
        assert_eq!(relative_date(Some(&days(1))), "1 day ago");
        assert_eq!(relative_date(Some(&days(10))), "10 days ago");
        assert!(relative_date(Some(&days(90))).ends_with("mo ago"));
        assert!(relative_date(Some(&days(800))).ends_with("yr ago"));
        assert_eq!(relative_date(None), "unknown");
        let midnight = crate::time::utc_midnight(now_ms());
        assert_eq!(relative_date(Some(&iso(midnight - 30 * 60_000))), "1 day ago");
        assert_eq!(relative_date(Some(&iso(midnight + 60_000))), "today");
    }

    #[test]
    fn quotes_only_when_asked() {
        let html = "<aside class=\"quote\"><blockquote><p>real recap intro</p></blockquote></aside>";
        assert!(html_to_markdown(html, true).contains("real recap intro"));
        assert!(html_to_markdown(html, false).contains("[quoted earlier reply]"));
        assert!(!html_to_markdown(html, false).contains("real recap intro"));
    }

    #[test]
    fn stranded_markers() {
        let html =
            "<h2><a name=\"p-1-news\" class=\"anchor\" href=\"#p-1-news\"></a>\nNews &amp; Alerts</h2><ul><li>\nWe shared a PSA</li></ul>";
        let md = html_to_markdown(html, false);
        assert!(md.lines().any(|l| l == "## News & Alerts"), "{md}");
        assert!(md.lines().any(|l| l == "- We shared a PSA"), "{md}");
        assert!(!md.lines().any(|l| l.trim() == "##" || l.trim() == "-"));
    }

    #[test]
    fn screenshot_caption() {
        let cooked = "<p>Here is an example:</p>\n<p><div class=\"lightbox-wrapper\"><a class=\"lightbox\" href=\"//uploads/original/a.png\" title=\"issue at hand\"><img src=\"//uploads/optimized/a.png\" alt=\"issue at hand\" width=\"690\" height=\"346\"><div class=\"meta\">meta chrome</div></a></div></p>";
        let md = html_to_markdown(cooked, false);
        assert!(md.contains("Here is an example:"));
        assert!(md.contains("[image: issue at hand]"));
        assert!(!md.contains("lightbox") && !md.contains("uploads") && !md.contains("meta chrome"), "{md}");
        let no_alt = html_to_markdown(
            "<div class=\"lightbox-wrapper\"><a class=\"lightbox\" href=\"//x.png\"><img src=\"//x.png\"></a></div>",
            false,
        );
        assert_eq!(no_alt, "[image]");
    }

    #[test]
    fn code_decoded_once() {
        let md = html_to_markdown(
            "<pre><code class=\"lang-lua\">if a &lt; b and c &gt; d then\n  local t: {Array&lt;number&gt;} = {}\n  print(\"&amp;lt;\")\nend</code></pre><p>Use <code>x &lt;= y</code> here &amp; there.</p>",
            false,
        );
        assert!(md.contains("if a < b and c > d then"));
        assert!(md.contains("Array<number>"));
        assert!(md.contains("print(\"&lt;\")"));
        assert!(md.contains("Use `x <= y` here & there."), "{md}");
    }

    #[test]
    fn kept_quote_and_table() {
        let html = "<aside class=\"quote\" data-username=\"rbitia_rbx\" data-post=\"605\" data-topic=\"1\" data-full=\"true\"><div class=\"title\"><div class=\"quote-controls\"></div><img alt=\"\" width=\"24\" src=\"a.png\" class=\"avatar\"> rbitia_rbx:</div><blockquote><p>Roadmap.</p></blockquote></aside><div class=\"md-table\"><table><thead><tr><th>Asked</th><th>Answer</th></tr></thead><tbody><tr><td>Badges</td><td>In <code>February</code> | maybe</td></tr></tbody></table></div>";
        let md = html_to_markdown(html, true);
        assert!(!md.contains("data-") && !md.contains("[image]"), "{md}");
        assert!(md.contains("rbitia_rbx wrote:\n"), "{md}");
        assert!(md.contains("Roadmap."));
        assert!(md.contains("| Asked | Answer |\n| --- | --- |\n| Badges | In `February` \\| maybe |"), "{md}");
    }

    #[test]
    fn plurals() {
        assert_eq!(plural_with(1, "reply", "replies"), "1 reply");
        assert_eq!(plural_with(2, "reply", "replies"), "2 replies");
        assert_eq!(plural(0, "like"), "0 likes");
        assert_eq!(plural(1, "like"), "1 like");
    }
}
