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
  s = s.replace(/<div\b[^>]*class="[^"]*(lightbox-wrapper|meta|onebox-body)[^"]*"[\s\S]*?<\/div>/gi, "");

  // Fenced code: <pre><code class="lang-lua">…</code></pre>
  s = s.replace(
    /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, attrs: string, body: string) => {
      const lang = /lang-([\w+-]+)/i.exec(attrs)?.[1] ?? "lua";
      return `\n\n\`\`\`${lang}\n${decodeEntities(stripTags(body)).replace(/\s+$/, "")}\n\`\`\`\n\n`;
    },
  );
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => `\n\n\`\`\`\n${decodeEntities(stripTags(body)).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => `\`${decodeEntities(stripTags(body)).trim()}\``);

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

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim() !== ">") // leftover blockquote markers from unwrapped quotes
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
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

/** ISO date -> "3 days ago" style, so the model can judge staleness cheaply. */
export function relativeDate(iso: string | undefined): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, "");
  return `${years} yr ago`;
}
