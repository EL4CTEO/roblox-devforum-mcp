/** Official Roblox documentation: creator-docs sources + the engine API dump. */

import { cachedJson } from "./cache.js";
import { envInt, getGithubJson, getText, TTL } from "./http.js";

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

/**
 * Guide pages are MDX: the prose is wrapped in React components and preceded by their
 * imports. A 500-token read of physics/mover-constraints came back roughly four fifths
 * <Grid>, <Card> and <CardMedia>, so the budget bought almost no documentation. The tags go
 * and their text stays — an <Alert> body is real content, its angle brackets are not.
 */
function stripMdx(text: string): string {
  return text
    .replace(/^import\s+\w+\s+from\s+['"][^'"]+['"];?\s*$/gm, "")
    .replace(/<\/?[A-Z]\w*(?:\s[^<>]*?)?\/?>/g, "")
    // The handful of raw HTML tags the guides use are layout too; their text is the content.
    .replace(/<\/?(?:figure|figcaption|div|span|center|br|p)(?:\s[^<>]*?)?\/?>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Resolve a link written inside a docs page to its public URL. Repo-relative hrefs are
 * resolved against the page they came from; "/cloud/..." against the docs root.
 */
function docLinkUrl(href: string, dir: string | undefined): string | undefined {
  const [target, fragment] = href.split("#");
  if (!target) return undefined;
  const base = href.startsWith("/") ? DOCS_ROOT : dir === undefined ? undefined : `${dir}/`;
  if (base === undefined) return undefined;
  try {
    return `${docUrl(resolveDocPath(base + target.replace(/^\//, "")))}${fragment ? `#${fragment}` : ""}`;
  } catch {
    return undefined; // a link out of the docs tree is not one to hand back
  }
}

/**
 * Docs prose is written for the create.roblox.com renderer, not for a reader: it carries
 * `Class.X` cross-reference syntax and repo-relative links like
 * "[notes](../../../physics/mover-constraints.md)". Left alone those reach the caller as
 * dead paths — check_api_health printed one inside BodyVelocity's deprecation note.
 */
export function cleanDocProse(text: string, sourcePath?: string): string {
  // Class./Datatype./Global./Library. are renderer syntax with no Luau meaning; the
  // "Class.Constraint|Constraints" form carries the words to show after the pipe. Enum.X
  // without a pipe is left alone: it is valid Luau, so stripping it would corrupt real code.
  //
  // A method reference writes its call parens before the pipe —
  // "Datatype.Vector3:Cross()|Cross()" — and matching the pipe only straight after the name
  // left both halves on the page: Vector3's own summary reached the caller reading
  // "Vector3:Cross()|Cross()", and Humanoid's page carries twenty of them.
  const s = stripMdx(text).replace(
    /\b(Class|Datatype|Enum|Global|Library|Security)\.([A-Za-z0-9_]+(?:[.:][A-Za-z0-9_]+)?)(\(\))?(?:\|([^`\n]*)(?=`))?/g,
    (whole, kind: string, name: string, parens: string | undefined, display?: string) =>
      display !== undefined ? display : kind === "Enum" ? whole : `${name}${parens ?? ""}`,
  );
  const cut = sourcePath?.lastIndexOf("/") ?? -1;
  const dir = sourcePath !== undefined && cut > 0 ? sourcePath.slice(0, cut) : undefined;
  return s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    if (/^(?:https?:|#|mailto:)/.test(href)) return whole;
    const url = docLinkUrl(href, dir);
    return url !== undefined ? `[${label}](${url})` : label;
  });
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
const SCAN_LIMIT = envInt("DEVFORUM_DOCS_SCAN", 14, 1);

/** Drop YAML front matter and the boilerplate comment header so snippets start at real prose. */
function stripPreamble(text: string): string {
  const out = text
    .replace(/^(?:#[^\n]*\n)+/, "")
    .replace(/^---\n[\s\S]*?\n---\n/, "");
  return out.trimStart();
}

/**
 * Guide front matter is repo bookkeeping, not documentation. Reading
 * cloud-services/data-stores handed the caller `comments: The Creator Hub links to some of
 * the anchors on this page, so if you move any of the headers…` — a note to Roblox's docs
 * team, spending the caller's budget. The title and description are worth keeping; the rest
 * is not.
 */
export function renderGuide(text: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match?.[1]) return text.trimStart();
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*(.+)$`, "m").exec(match[1] as string)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const head = [field("title") ? `# ${field("title")}` : "", field("description") ?? ""].filter(Boolean).join("\n\n");
  const body = text.slice(match[0].length).trimStart();
  return head ? `${head}\n\n${body}` : body;
}

/**
 * Reference pages are machine-generated YAML, and handing it over raw spends a third of the
 * budget on scaffolding: a 700-token read of Vector3 was the "this file is automatically
 * generated" banner plus `code_samples: []`, `tags: []` and `deprecation_message: ''`
 * repeated once per member. Empty fields say nothing that their absence does not.
 */
export function cleanReferenceYaml(text: string): string {
  return text
    .replace(/^(?:#[^\n]*\n)+/, "")
    .split("\n")
    .filter((line) => !/^\s*[a-z_]+:\s*(\[\]|\{\}|''|""|null)\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

/** The `summary:` block at the top of a reference page — what the class or datatype is for. */
export function referenceSummary(yaml: string): string | undefined {
  const at = yaml.search(/^summary:\s*\|?\s*$/m);
  if (at < 0) return undefined;
  const lines = yaml.slice(at).split("\n").slice(1);
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") break;
    if (!/^\s+\S/.test(line)) break;
    body.push(line.trim());
  }
  const text = body.join(" ").trim();
  return text || undefined;
}

/**
 * Members a datatype reference page lists, by bare name ("Magnitude", "new", "Cross").
 * Operator sections are written "- name: Vector3 * Vector3" and are skipped by the pattern.
 *
 * Either separator counts: the docs write properties as "Vector3.Magnitude" and methods as
 * "Vector3:Cross", exactly as Luau calls them. Matching only the dot collected the
 * properties and none of the methods, so check_api_health answered "the Vector3 datatype has
 * no Cross" — and the same for Dot, Lerp, Angle and every CFrame method. Telling a model
 * that working code calls a nonexistent API is the one answer this tool must never give.
 */
export async function datatypeMembers(name: string): Promise<Set<string>> {
  const yaml = await fetchDoc(resolveDocPath(`reference/engine/datatypes/${name}.yaml`));
  const names = new Set<string>();
  for (const m of yaml.matchAll(/^\s*-\s+name:\s+[A-Za-z0-9_]+[.:]([A-Za-z0-9_]+)\s*$/gm)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - 90);
  const raw = text.slice(start, start + 260).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${start + 260 < text.length ? "…" : ""}`;
}

/**
 * How often `term` occurs in `text`, and where it first does.
 *
 * `text.split(term).length - 1` was the old count, which builds an array of every slice of
 * a page that can run past 100 KB — once per query term, per candidate page. Walking with
 * indexOf answers the same question without allocating anything, and returns the first
 * position the caller then wanted anyway instead of scanning for it a second time.
 */
function countTerm(text: string, term: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let at = text.indexOf(term);
  while (at >= 0) {
    if (first < 0) first = at;
    count += 1;
    at = text.indexOf(term, at + term.length);
  }
  return { count, first };
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
        const { count, first } = countTerm(body, term);
        if (count > 0) {
          covered += 1;
          hits += count;
          if (anchor < 0 || (count < 20 && first < anchor)) anchor = first;
        }
      }
      hit.score += (covered / terms.length) * 60 + Math.min(hits, 25) * 1.5;
      const phraseAt = body.indexOf(phrase);
      if (phraseAt >= 0) {
        hit.score += 70;
        anchor = phraseAt;
      }
      // A reference page is YAML, so the text around the match is "name: DataStoreRequestType
      // type: enum summary: |" — the file's shape, not an answer. Its own summary is.
      const raw = hit.kind === "guide" ? undefined : referenceSummary(source);
      if (raw) hit.snippet = cleanDocProse(raw, hit.path);
      else if (anchor >= 0) hit.snippet = cleanDocProse(snippetAround(source, anchor), hit.path);
      return hit;
    }),
  );

  return enriched.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Resolve a caller-supplied repo path, keeping it inside the documentation root.
 *
 * The segments are resolved here rather than left to the CDN: "../../README.md" walked out
 * of content/en-us and returned the repository's own README under a nonsense
 * "create.roblox.com/docs/../../README" URL, which is not a page an agent should be citing.
 */
export function resolveDocPath(path: string): string {
  const clean = path.trim().replace(/^\/+/, "");
  const full = clean.startsWith(DOCS_ROOT) ? clean : `${DOCS_ROOT}${clean}`;
  const parts: string[] = [];
  for (const segment of full.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const resolved = parts.join("/");
  if (!resolved.startsWith(DOCS_ROOT) || resolved.length === DOCS_ROOT.length) {
    throw new Error(`"${path}" is outside the documentation tree — paths start with ${DOCS_ROOT}`);
  }
  return resolved;
}

/** Fetch a documentation page source (Markdown guide or reference YAML). */
export async function fetchDoc(path: string): Promise<string> {
  return getText(RAW_BASE + resolveDocPath(path), TTL.static);
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

/**
 * Lower-cased name -> entry, built once per dump.
 *
 * Every lookup used to walk the whole dump: check_api_health with 25 entries scanned ~1,700
 * classes per entry, and each `classChain` call rebuilt a 1,700-entry Map only to follow
 * three superclasses. The dump is fetched once and never mutated, so the index can be too.
 */
interface DumpIndex {
  classesByLower: Map<string, ApiClass>;
  classesByName: Map<string, ApiClass>;
  enumsByLower: Map<string, { Name: string; Items?: Array<{ Name: string; Value: number }> }>;
  classNames: string[];
}

let indexPromise: Promise<DumpIndex> | undefined;

async function dumpIndex(): Promise<DumpIndex> {
  indexPromise ??= (async () => {
    const dump = await apiDump();
    const classes = dump.Classes ?? [];
    return {
      classesByLower: new Map(classes.map((c) => [c.Name.toLowerCase(), c])),
      classesByName: new Map(classes.map((c) => [c.Name, c])),
      enumsByLower: new Map((dump.Enums ?? []).map((e) => [e.Name.toLowerCase(), e])),
      classNames: classes.map((c) => c.Name),
    };
  })().catch((err: unknown) => {
    // A failed fetch must not be remembered as "the dump has no classes".
    indexPromise = undefined;
    dumpPromise = undefined;
    throw err;
  });
  return indexPromise;
}

export async function findClass(name: string): Promise<ApiClass | undefined> {
  return (await dumpIndex()).classesByLower.get(name.toLowerCase());
}

export async function findEnum(name: string) {
  return (await dumpIndex()).enumsByLower.get(name.toLowerCase());
}

/** Class names that look like the query, used when the exact lookup misses. */
/**
 * Is `known` close enough to what was asked to be worth offering back? A bare substring test
 * is worthless on short names: "SomeClassThatDoesNotExist" contains "Hat", and that is the
 * class check_api_health used to name as the closest match.
 */
function closeEnough(target: string, known: string): boolean {
  const [short, long] = target.length <= known.length ? [target, known] : [known, target];
  if (short.length < 3 || !long.includes(short)) return false;
  return short.length / long.length >= 0.4;
}

/** Closest first, so a suggestion list reads best-to-worst rather than in dump order. */
function byCloseness(target: string) {
  return (a: string, b: string): number =>
    Math.abs(a.length - target.length) - Math.abs(b.length - target.length) || a.localeCompare(b);
}

/** Names close enough to `target` to be worth offering back, closest first. */
export function nearestNames(target: string, known: Iterable<string>, limit = 6): string[] {
  const lower = target.toLowerCase();
  return [...known]
    .filter((n) => closeEnough(lower, n.toLowerCase()))
    .sort(byCloseness(lower))
    .slice(0, limit);
}

export async function suggestClasses(name: string, limit = 8): Promise<string[]> {
  const target = name.toLowerCase();
  return (await dumpIndex()).classNames
    .filter((n) => closeEnough(target, n.toLowerCase()))
    .sort(byCloseness(target))
    .slice(0, limit);
}

/** Walk the inheritance chain so inherited members stay visible. */
export async function classChain(name: string): Promise<ApiClass[]> {
  const { classesByLower, classesByName } = await dumpIndex();
  const chain: ApiClass[] = [];
  let current = classesByLower.get(name.toLowerCase());
  // A malformed dump could name itself as its own superclass; `seen` keeps that a bad
  // answer rather than a hang, and the depth cap stays as the belt to its braces.
  const seen = new Set<string>();
  while (current && chain.length < 12 && !seen.has(current.Name)) {
    seen.add(current.Name);
    chain.push(current);
    current = current.Superclass ? classesByName.get(current.Superclass) : undefined;
  }
  return chain;
}

/* ----------------------------- API health check ---------------------------- */

/**
 * Datatypes (Vector3, CFrame, UDim2…) are not classes and never appear in the API dump, so
 * a class lookup for them wrongly reports "not found". The docs are the source of truth.
 */
export async function findDatatype(name: string): Promise<string | undefined> {
  const target = name.toLowerCase();
  const paths = await docPaths();
  const match = paths.find(
    (p) => p.toLowerCase() === `${DOCS_ROOT}reference/engine/datatypes/${target}.yaml`,
  );
  return match ? titleOf(match) : undefined;
}

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
      if (closeEnough(target, m.Name.toLowerCase())) names.add(m.Name);
    }
  }
  return [...names].sort(byCloseness(target)).slice(0, limit);
}

/** Quote a caller-supplied name for use inside a RegExp; these arrive as raw tool input. */
export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a reference YAML page into its member entries, with the page's own fields first.
 *
 * Members are not the only `- name:` lines in the file: every parameter is one too, nested
 * deeper. Splitting on all of them cut each member off at its own parameter list, so
 * everything written below that — `deprecation_message` included — was filed under a
 * fragment belonging to no member. Humanoid:LoadAnimation names its replacement right there
 * in the docs and check_api_health still printed a bare "DEPRECATED".
 *
 * Members are the shallowest `- name:` lines on the page, so that indent is the boundary.
 */
export function splitMemberBlocks(yaml: string): string[] {
  const indents = [...yaml.matchAll(/^([ \t]*)-[ \t]+name:[ \t]/gm)].map((m) => (m[1] ?? "").length);
  if (indents.length === 0) return [yaml];
  const top = Math.min(...indents);
  const blocks: string[] = [];
  let current = "";
  for (const line of yaml.split("\n")) {
    const at = /^([ \t]*)-[ \t]+name:[ \t]/.exec(line);
    if (at && (at[1] ?? "").length === top) {
      blocks.push(current);
      current = line;
    } else {
      current += (current === "" ? "" : "\n") + line;
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Pull a `deprecation_message` out of a reference YAML file. The dump marks members as
 * deprecated but never says what replaced them; the docs sometimes do.
 */
export function parseDeprecationMessage(yaml: string, memberName?: string): string | undefined {
  // Reference YAML lists members as "  - name: Class.Member"; the class-level fields sit
  // above the first such entry.
  const blocks = splitMemberBlocks(yaml);
  // "Class.Property" but "Class:Method" — the docs use Luau's own call syntax, so a dot-only
  // match found the deprecated properties and missed every deprecated method. The official
  // replacement for Humanoid:LoadAnimation is written right there in the file, and the tool
  // printed "DEPRECATED" with not a word on what to use instead.
  const block = memberName
    ? blocks.find((b) => new RegExp(`^\\s*-\\s+name:\\s+\\S*[.:]${escapeRe(memberName)}\\s*$`, "m").test(b))
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
    const path = resolveDocPath(`reference/engine/classes/${className}.yaml`);
    const yaml = await fetchDoc(path);
    const raw = parseDeprecationMessage(yaml, memberName) ?? (memberName ? parseDeprecationMessage(yaml) : undefined);
    return raw === undefined ? undefined : cleanDocProse(raw, path);
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
