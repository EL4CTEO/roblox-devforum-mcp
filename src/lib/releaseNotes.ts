import type { NewsItem, ReleaseNoteIndexEntry, ReleaseNoteSection } from "../types.js";
import { extractNextData, flattenDocBody } from "./htmlParse.js";
import { stripHtml } from "./sanitize.js";

const SECTION_HEADINGS: Record<string, keyof ReleaseNoteSection> = {
  "new features": "new_features",
  "new feature": "new_features",
  features: "new_features",
  improvements: "improvements",
  improvement: "improvements",
  changes: "improvements",
  fixes: "fixes",
  "bug fixes": "fixes",
  "fixed bugs": "fixes",
  removed: "removed",
  "removed/deprecated": "removed",
  deprecated: "removed",
  deprecations: "removed",
};

function normalizeHeading(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseReleaseNoteSections(text: string): ReleaseNoteSection {
  const sections: ReleaseNoteSection = {};
  const lines = text.split(/\r?\n/);
  let current: keyof ReleaseNoteSection | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = normalizeHeading(line);
    if (heading.length < 80 && SECTION_HEADINGS[heading]) {
      current = SECTION_HEADINGS[heading];
      if (!sections[current]) sections[current] = [];
      continue;
    }

    if (!current) continue;

    const bullet = line.match(/^(?:[-•*]\s+|\d+\.\s+)(.+)$/);
    if (bullet?.[1]) {
      sections[current]?.push(bullet[1].trim());
    }
  }

  return sections;
}

interface DocPage {
  title?: string;
  body?: unknown;
  content?: unknown;
  description?: string;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
  date?: string;
}

function getDocFromNextData(html: string): DocPage | null {
  const next = extractNextData(html) as { props?: { pageProps?: Record<string, unknown> } } | null;
  if (!next) return null;
  const props = next.props?.pageProps;
  if (!props) return null;
  const doc = (props.doc as DocPage | undefined) ?? (props.data as DocPage | undefined);
  return doc ?? null;
}

function flattenContent(doc: DocPage): string {
  let out = "";
  if (doc.description) out += `${doc.description}\n\n`;
  if (Array.isArray(doc.body)) {
    out += flattenDocBody(doc.body);
  } else if (typeof doc.content === "string") {
    out += stripHtml(doc.content);
  } else if (Array.isArray(doc.content)) {
    out += flattenDocBody(doc.content);
  }
  return out.trim();
}

function extractDate(doc: DocPage | null, html: string): string | undefined {
  if (doc) {
    const meta = doc.metadata ?? {};
    for (const key of ["date", "publishedAt", "updatedAt"]) {
      const v = (meta[key] ?? (doc as Record<string, unknown>)[key]) as string | undefined;
      if (typeof v === "string" && v.length >= 8) {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
    }
  }
  const m = html.match(
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b|"(?:date|publishedAt|updatedAt)"\s*:\s*"([^"]+)"/
  );
  if (m) {
    const candidate = m[4] ?? `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

export function extractReleaseNoteIndex(html: string): ReleaseNoteIndexEntry[] {
  const seen = new Set<string>();
  const entries: ReleaseNoteIndexEntry[] = [];

  const slugRe = /release-notes-(\d{2,4})/g;
  for (const m of html.matchAll(slugRe)) {
    const version = m[1];
    if (!version || seen.has(version)) continue;
    seen.add(version);
    entries.push({
      version,
      title: `Release ${version}`,
      url: `https://create.roblox.com/docs/release-notes/release-notes-${version}`,
    });
  }

  entries.sort((a, b) => Number(b.version) - Number(a.version));
  return entries;
}

export function extractReleaseNoteFromHtml(
  html: string,
  version: string,
  url: string
): NewsItem | null {
  const doc = getDocFromNextData(html);
  const text = doc ? flattenContent(doc) : stripHtml(html).slice(0, 8000);
  if (!text) return null;

  const sections = parseReleaseNoteSections(text);
  const sectionCount =
    (sections.new_features?.length ?? 0) +
    (sections.improvements?.length ?? 0) +
    (sections.fixes?.length ?? 0) +
    (sections.removed?.length ?? 0);

  const title = doc?.title?.trim() || `Release ${version}`;
  const date = extractDate(doc, html) ?? "";
  const summary = (doc?.description ?? text.slice(0, 240)).trim();

  const item: NewsItem = {
    type: "release_note",
    title,
    url,
    date,
    summary: summary.slice(0, 400),
    version,
  };
  if (sectionCount > 0) item.sections = sections;
  return item;
}

export function renderReleaseNoteMarkdown(item: NewsItem): string {
  const parts: string[] = [];
  parts.push(`# ${item.title}`);
  if (item.date) parts.push(`_Published ${item.date.slice(0, 10)}_`);
  parts.push("");
  if (item.summary) {
    parts.push(item.summary);
    parts.push("");
  }
  const labels: { key: keyof ReleaseNoteSection; heading: string }[] = [
    { key: "new_features", heading: "New Features" },
    { key: "improvements", heading: "Improvements" },
    { key: "fixes", heading: "Fixes" },
    { key: "removed", heading: "Removed / Deprecated" },
  ];
  for (const { key, heading } of labels) {
    const items = item.sections?.[key];
    if (!items || items.length === 0) continue;
    parts.push(`## ${heading}`);
    for (const entry of items) parts.push(`- ${entry}`);
    parts.push("");
  }
  parts.push(`Source: ${item.url}`);
  return parts.join("\n");
}
