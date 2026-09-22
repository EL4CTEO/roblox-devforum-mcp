/** HTML -> Markdown, noise stripping and token budgeting. Zero dependencies. */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', middot: "·",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

/**
 * Convert a Discourse `cooked` HTML post into compact Markdown.
 * Code blocks are preserved verbatim; quotes, images and onebox chrome are dropped.
 */
export function htmlToMarkdown(html: string, options: { keepQuotes?: boolean } = {}): string {
  if (!html) return "";
  let s = html;

  // Drop containers that are pure noise for a debugging agent. A quote in a reply is almost
  // always a re-quote of something already on screen — but the first post of a topic has
  // nothing earlier to quote, so there the block is real content (Roblox styles its Weekly
  // Recap summaries this way), and callers pass keepQuotes for it.
  s = options.keepQuotes
    ? s.replace(/<aside\b[^>]*class="[^"]*quote[^"]*"([\s\S]*?)<\/aside>/gi, (_m, body: string) => body)
    : s.replace(/<aside\b[^>]*class="[^"]*quote[^"]*"[\s\S]*?<\/aside>/gi, "\n[quoted earlier reply]\n");
  s = s.replace(/<aside\b[\s\S]*?<\/aside>/gi, "");
  s = s.replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, "");
  // Discourse wraps an uploaded screenshot in <div class="lightbox-wrapper"><a><img alt=…>.
  // The wrapper is chrome, but the alt is what the poster titled the screenshot, and dropping
  // the whole div dropped that with it: a reply that is one screenshot came out as its lead-in
  // sentence and then nothing — "Here is an example of how the issue comes about in my
  // servers:" followed by blank, which reads as a post with no content rather than one holding
  // a picture. A bare <img> already became "[image: …]" further down; this is the same picture,
  // only wrapped.
  s = s.replace(
    /<div\b[^>]*class="[^"]*lightbox-wrapper[^"]*"[\s\S]*?(<img\b[^>]*>)[\s\S]*?<\/a>/gi,
    (_m, img: string) => {
      const alt = /\balt="([^"]*)"/i.exec(img)?.[1];
      return alt ? `\n[image: ${alt}]\n` : "\n[image]\n";
    },
  );
  s = s.replace(/<div\b[^>]*class="[^"]*(lightbox-wrapper|meta|onebox-body)[^"]*"[\s\S]*?<\/div>/gi, "");

  // Code is decoded once and then parked outside the string until the very end. It used to
  // be decoded in place, so the tag strip and entity decode that run over the whole post
  // afterwards ran over the code a second time: `if a < b and c > d then` came out as
  // `if a  d then`, `Array<number>` as `Array`, and a literal "&lt;" in a string as "<".
  // Luau compares with < and > on nearly every line, so this corrupted most answers.
  const code: string[] = [];
  const park = (text: string): string => `\u0000${code.push(text) - 1}\u0000`;

  // Fenced code: <pre><code class="lang-lua">…</code></pre>
  s = s.replace(
    /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, attrs: string, body: string) => {
      const lang = /lang-([\w+-]+)/i.exec(attrs)?.[1] ?? "lua";
      return `\n\n${park(`\`\`\`${lang}\n${decodeEntities(stripTags(body)).replace(/\s+$/, "")}\n\`\`\``)}\n\n`;
    },
  );
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => `\n\n${park(`\`\`\`\n${decodeEntities(stripTags(body)).trim()}\n\`\`\``)}\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => park(`\`${decodeEntities(stripTags(body)).trim()}\``));

  // Structure
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|blockquote|h[1-6])>/gi, "\n\n");
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `);
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body: string) => `**${stripTags(body).trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body: string) => `*${stripTags(body).trim()}*`);
  // Discourse renders emoji as <img class="emoji" alt=":star:">; keep the shortcode, drop the frame.
  s = s.replace(/<img\b[^>]*class="[^"]*emoji[^"]*"[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => alt);
  s = s.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[image: ${alt}]` : "[image]"));
  s = s.replace(/<img\b[^>]*>/gi, "[image]");
  s = s.replace(
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, body: string) => {
      const text = stripTags(body).trim();
      // Heading anchors (<a name=… class="anchor"></a>) carry no text; emitting their href
      // would paste "#p-123-section-name" into the middle of the heading.
      if (!text) return "";
      return text === href ? href : `[${text}](${href})`;
    },
  );

  s = decodeEntities(stripTags(s));

  return (
    s
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .filter((line) => line.trim() !== ">") // leftover blockquote markers from unwrapped quotes
      .join("\n")
      // Discourse puts a newline between a heading's anchor and its text, and between a list
      // marker and its content. Once the anchor is stripped that leaves a bare "##" or "-"
      // stranded on its own line, so pull the text back up onto the marker.
      .replace(/^(#{1,6}|[-*])[ \t]*\n+[ \t]*(?=\S)/gm, "$1 ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? "")
  );
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

/** "1 reply" / "2 replies" — a result line that says "1 replies" reads as a rendering bug. */
export function plural(count: number, word: string, plural = `${word}s`): string {
  return `${count} ${count === 1 ? word : plural}`;
}

/** Roughly 4 characters per token — good enough for output budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Trim text to a token budget on a paragraph boundary where possible. */
export function truncate(text: string, maxTokens: number, hint = ""): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  const kept = boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut;
  return `${kept.trimEnd()}\n\n…[truncated${hint ? `, ${hint}` : ""}]`;
}

/** Start of the UTC day holding `ms`. Forum timestamps are UTC, so the comparison is too. */
function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** ISO date -> "3 days ago" style, so the model can judge staleness cheaply. */
export function relativeDate(iso: string | undefined): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  // Calendar days, not 24-hour blocks: a post from 20:00 yesterday read at 18:00 today is
  // 22 hours old but is not "today", and get_weekly_recap printed the contradiction out
  // loud as "published 2026-08-28 (today)".
  const days = Math.round((utcMidnight(Date.now()) - utcMidnight(then)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, "");
  return `${years} yr ago`;
}
