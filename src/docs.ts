/** Official Roblox documentation: creator-docs sources + the engine API dump. */

import { cachedJson } from "./cache.js";
import { getGithubJson, getText, TTL } from "./http.js";

const DOCS_REPO = "Roblox/creator-docs";
const DOCS_BRANCH = "main";
const DOCS_ROOT = "content/en-us/";
const RAW_BASE = `https://raw.githubusercontent.com/${DOCS_REPO}/${DOCS_BRANCH}/`;
const API_DUMP_URL =
  "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json";

/* ------------------------------ docs file tree ----------------------------- */

let treePromise: Promise<string[]> | undefined;

async function docPaths(): Promise<string[]> {
  // The raw tree is ~3.3 MB; only the filtered path list is kept, and it is cached to disk
  // so a new session does not pay that download again on its first docs search.
  treePromise ??= cachedJson("docs-tree", 24 * 3_600_000, async () => {
    const data = await getGithubJson<{ tree?: Array<{ path: string; type: string }> }>(
      `https://api.github.com/repos/${DOCS_REPO}/git/trees/${DOCS_BRANCH}?recursive=1`,
      TTL.static,
    );
    return (data.tree ?? [])
      .filter((n) => n.type === "blob" && n.path.startsWith(DOCS_ROOT) && /\.(md|yaml)$/.test(n.path))
      .map((n) => n.path);
  });
  return treePromise;
}

export interface DocHit {
  path: string;
  title: string;
  kind: "guide" | "class" | "datatype" | "enum" | "global";
  url: string;
  score: number;
  snippet?: string;
}

/** Words that carry no signal in a documentation query. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "are", "how", "do",
  "does", "what", "why", "when", "with", "my", "it", "roblox", "can", "get", "use", "using",
]);

export function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1);
  const meaningful = terms.filter((t) => !STOPWORDS.has(t));
  return [...new Set(meaningful.length ? meaningful : terms)];
}

function kindOf(path: string): DocHit["kind"] {
  if (path.includes("/reference/engine/classes/")) return "class";
  if (path.includes("/reference/engine/datatypes/")) return "datatype";
  if (path.includes("/reference/engine/enums/")) return "enum";
  if (path.includes("/reference/engine/globals/")) return "global";
  return "guide";
}

function titleOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|yaml)$/, "");
  return file === "index" ? path.slice(DOCS_ROOT.length).replace(/\/index\.(md|yaml)$/, "") : file;
}

/** Public documentation URL for a repo path. */
export function docUrl(path: string): string {
  const rel = path.slice(DOCS_ROOT.length).replace(/\.(md|yaml)$/, "").replace(/\/index$/, "");
  return `https://create.roblox.com/docs/${rel}`;
}

/** Score a documentation path (stage one — cheap, no network). */
export function scorePath(path: string, terms: string[], compactQuery: string): number {
  const lower = path.toLowerCase();
  const titleLower = titleOf(path).toLowerCase();
  const titleCompact = titleLower.replace(/[^a-z0-9]/g, "");

  let score = 0;
  let covered = 0;
  for (const term of terms) {
    if (titleCompact === term) {
      score += 60;
      covered += 1;
    } else if (titleLower.includes(term)) {
      score += 20;
      covered += 1;
    } else if (lower.includes(term)) {
      score += 6;
      covered += 1;
    }
  }
  if (covered === 0) return 0;
  score += (covered / terms.length) * 25; // reward pages that cover the whole query
  if (titleCompact === compactQuery) score += 80; // exact class or page name
  if (kindOf(path) !== "guide") score += 4;
  if (path.endsWith("/index.md")) score += 4;
  return score;
}

/** How many candidate pages get their content downloaded and scored. */
const SCAN_LIMIT = Number(process.env.DEVFORUM_DOCS_SCAN ?? 14);

/** Drop YAML front matter and the boilerplate comment header so snippets start at real prose. */
function stripPreamble(text: string): string {
  const out = text
    .replace(/^(?:#[^\n]*\n)+/, "")
    .replace(/^---\n[\s\S]*?\n---\n/, "");
  return out.trimStart();
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - 90);
  const raw = text.slice(start, start + 260).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${start + 260 < text.length ? "…" : ""}`;
}

/**
 * Search the official docs. Paths are ranked first, then the strongest candidates are
 * downloaded (and cached) so the query can be matched against real page content.
 */
export async function searchDocs(query: string, limit: number): Promise<DocHit[]> {
  const paths = await docPaths();
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const compact = query.toLowerCase().replace(/[^a-z0-9]/g, "");

  const candidates = paths
    .map((path) => ({ path, score: scorePath(path, terms, compact) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (candidates.length === 0) return [];

  const scanned = candidates.slice(0, Math.max(SCAN_LIMIT, limit));
  const phrase = terms.join(" ");

  const enriched = await Promise.all(
    scanned.map(async (candidate) => {
      const hit: DocHit = {
        path: candidate.path,
        title: titleOf(candidate.path),
        kind: kindOf(candidate.path),
        url: docUrl(candidate.path),
        score: candidate.score,
      };
      let source: string;
      try {
        source = stripPreamble(await fetchDoc(candidate.path));
      } catch {
        return hit; // path score alone still ranks it
      }
      const body = source.toLowerCase();

      let covered = 0;
      let hits = 0;
      let anchor = -1;
      for (const term of terms) {
        const found = body.split(term).length - 1;
        if (found > 0) {
          covered += 1;
          hits += found;
          const at = body.indexOf(term);
          if (anchor < 0 || (found < 20 && at < anchor)) anchor = at;
        }
      }
      hit.score += (covered / terms.length) * 60 + Math.min(hits, 25) * 1.5;
      const phraseAt = body.indexOf(phrase);
      if (phraseAt >= 0) {
        hit.score += 70;
        anchor = phraseAt;
      }
      if (anchor >= 0) hit.snippet = snippetAround(source, anchor);
      return hit;
    }),
  );

  return enriched.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Fetch a documentation page source (Markdown guide or reference YAML). */
export async function fetchDoc(path: string): Promise<string> {
  const clean = path.replace(/^\/+/, "");
  const full = clean.startsWith(DOCS_ROOT) ? clean : `${DOCS_ROOT}${clean}`;
  return getText(RAW_BASE + full, TTL.static);
}

/* ------------------------------- API dump -------------------------------- */

export interface ApiMember {
  MemberType: string;
  Name: string;
  ValueType?: { Name?: string };
  ReturnType?: { Name?: string };
  Parameters?: Array<{ Name: string; Type?: { Name?: string }; Default?: string }>;
  Security?: string | { Read?: string; Write?: string };
  Tags?: string[];
  ThreadSafety?: string;
}

export interface ApiClass {
  Name: string;
  Superclass?: string;
  MemoryCategory?: string;
  Tags?: string[];
  Members?: ApiMember[];
}

interface ApiDump {
  Classes?: ApiClass[];
  Enums?: Array<{ Name: string; Items?: Array<{ Name: string; Value: number }> }>;
}

let dumpPromise: Promise<ApiDump> | undefined;

async function apiDump(): Promise<ApiDump> {
  dumpPromise ??= cachedJson(
    "api-dump",
    12 * 3_600_000,
    async () => JSON.parse(await getText(API_DUMP_URL, 0)) as ApiDump,
  );
  return dumpPromise;
}

export async function findClass(name: string): Promise<ApiClass | undefined> {
  const dump = await apiDump();
  const target = name.toLowerCase();
  return dump.Classes?.find((c) => c.Name.toLowerCase() === target);
}

export async function findEnum(name: string) {
  const dump = await apiDump();
  const target = name.toLowerCase();
  return dump.Enums?.find((e) => e.Name.toLowerCase() === target);
}

/** Class names that look like the query, used when the exact lookup misses. */
export async function suggestClasses(name: string, limit = 8): Promise<string[]> {
  const dump = await apiDump();
  const target = name.toLowerCase();
  return (dump.Classes ?? [])
    .map((c) => c.Name)
    .filter((n) => n.toLowerCase().includes(target) || target.includes(n.toLowerCase()))
    .slice(0, limit);
}

/** Walk the inheritance chain so inherited members stay visible. */
export async function classChain(name: string): Promise<ApiClass[]> {
  const dump = await apiDump();
  const byName = new Map((dump.Classes ?? []).map((c) => [c.Name, c]));
  const chain: ApiClass[] = [];
  let current = byName.get((await findClass(name))?.Name ?? "");
  while (current && chain.length < 12) {
    chain.push(current);
    current = current.Superclass ? byName.get(current.Superclass) : undefined;
  }
  return chain;
}

/* ----------------------------- API health check ---------------------------- */

export interface MemberLookup {
  /** The class the member was actually found on — may be a superclass. */
  owner: ApiClass;
  member: ApiMember;
}

/** Resolve `Class.Member` through the inheritance chain, case-insensitively. */
export async function resolveMember(className: string, memberName: string): Promise<MemberLookup | undefined> {
  const target = memberName.toLowerCase();
  for (const owner of await classChain(className)) {
    const member = (owner.Members ?? []).find((m) => m.Name.toLowerCase() === target);
    if (member) return { owner, member };
  }
  return undefined;
}

/** Member names on a class (and its superclasses) that look like the given name. */
export async function suggestMembers(className: string, memberName: string, limit = 6): Promise<string[]> {
  const target = memberName.toLowerCase();
  const names = new Set<string>();
  for (const owner of await classChain(className)) {
    for (const m of owner.Members ?? []) {
      const lower = m.Name.toLowerCase();
      if (lower.includes(target) || target.includes(lower)) names.add(m.Name);
      if (names.size >= limit) return [...names];
    }
  }
  return [...names];
}

/**
 * Pull a `deprecation_message` out of a reference YAML file. The dump marks members as
 * deprecated but never says what replaced them; the docs sometimes do.
 */
export function parseDeprecationMessage(yaml: string, memberName?: string): string | undefined {
  // Reference YAML lists members as "  - name: Class.Member"; the class-level fields sit
  // above the first such entry.
  const blocks = yaml.split(/\n(?=\s*-\s+name:\s)/);
  const block = memberName
    ? blocks.find((b) => new RegExp(`^\\s*-\\s+name:\\s+\\S*\\.${memberName}\\s*$`, "m").test(b))
    : blocks[0];
  if (!block) return undefined;

  const lines = block.split("\n");
  const at = lines.findIndex((l) => /^\s*deprecation_message:/.test(l));
  if (at < 0) return undefined;

  const first = lines[at] ?? "";
  const inline = first.slice(first.indexOf(":") + 1).trim();
  if (inline && !/^[|>][-+]?$/.test(inline)) {
    const unquoted = inline.replace(/^['"]|['"]$/g, "").trim();
    return unquoted || undefined;
  }
  if (!/^[|>][-+]?$/.test(inline)) return undefined;

  // Block scalar: take the following lines that are indented further than the key.
  const indent = (first.match(/^\s*/)?.[0] ?? "").length;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if ((line.match(/^\s*/)?.[0] ?? "").length <= indent) break;
    body.push(line.trim());
  }
  const text = body.join(" ").trim();
  return text || undefined;
}

/** Best-effort replacement guidance from the docs for a deprecated class or member. */
export async function deprecationNote(className: string, memberName?: string): Promise<string | undefined> {
  try {
    const yaml = await fetchDoc(`reference/engine/classes/${className}.yaml`);
    return parseDeprecationMessage(yaml, memberName) ?? (memberName ? parseDeprecationMessage(yaml) : undefined);
  } catch {
    return undefined; // docs are a bonus, never required
  }
}

export function securityOf(member: ApiMember): string | undefined {
  const sec = member.Security;
  if (!sec) return undefined;
  if (typeof sec === "string") return sec === "None" ? undefined : sec;
  const parts = [sec.Read, sec.Write].filter((s): s is string => Boolean(s) && s !== "None");
  return parts.length ? [...new Set(parts)].join("/") : undefined;
}

export function signature(member: ApiMember): string {
  if (member.MemberType === "Function" || member.MemberType === "Callback") {
    const params = (member.Parameters ?? [])
      .map((p) => `${p.Name}: ${p.Type?.Name ?? "any"}${p.Default !== undefined ? ` = ${p.Default}` : ""}`)
      .join(", ");
    return `${member.Name}(${params}) -> ${member.ReturnType?.Name ?? "void"}`;
  }
  if (member.MemberType === "Event") {
    const params = (member.Parameters ?? []).map((p) => `${p.Name}: ${p.Type?.Name ?? "any"}`).join(", ");
    return `${member.Name}(${params})`;
  }
  return `${member.Name}: ${member.ValueType?.Name ?? "unknown"}`;
}
