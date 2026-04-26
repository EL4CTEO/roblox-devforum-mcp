#!/usr/bin/env node

// =================================================================
// roblox-devforum-mcp v4.0.0
// State-of-the-art MCP server for Roblox Studio workflow
// 27 tools: DevForum, API Dump, Creator Hub, Luau, Status, Creator Store
// =================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

// ─── Config ─────────────────────────────────────────────────────

const VERSION = "4.0.0";
const DEVFORUM = "https://devforum.roblox.com";
const CREATOR_DOCS = "https://create.roblox.com";
const ROBLOX_STATUS = "https://status.roblox.com";
const CREATOR_STORE = "https://catalog.roblox.com";
const SEARCH_ENGINE = "https://duckduckgo.com/html";

const SERVER = new McpServer({ name: "roblox-devforum-mcp", version: VERSION });

const COMMON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

// ─── HTTP with caching ──────────────────────────────────────────

type CacheEntry = { value: string; ts: number; etag?: string };
const CACHE = new Map<string, CacheEntry>();
const CACHE_KEYS: string[] = [];

function cacheGet(key: string): CacheEntry | undefined {
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    const idx = CACHE_KEYS.indexOf(key);
    if (idx >= 0) CACHE_KEYS.splice(idx, 1);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, value: string, etag?: string) {
  if (CACHE.has(key)) {
    const idx = CACHE_KEYS.indexOf(key);
    if (idx >= 0) CACHE_KEYS.splice(idx, 1);
  } else if (CACHE_KEYS.length >= CACHE_MAX) {
    const oldest = CACHE_KEYS.shift()!;
    CACHE.delete(oldest);
  }
  CACHE.set(key, { value, ts: Date.now(), etag });
  CACHE_KEYS.push(key);
}

async function httpFetch(
  url: string,
  opts: { json?: boolean; etag?: string; retries?: number } = {}
): Promise<Response> {
  const { json = false, etag, retries = MAX_RETRIES } = opts;

  const headers: Record<string, string> = json
    ? { ...COMMON_HEADERS }
    : { "User-Agent": COMMON_HEADERS["User-Agent"] };
  if (etag) headers["If-None-Match"] = etag;

  for (let attempt = 0; attempt < retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { headers, signal: controller.signal });

      if (res.status === 429) {
        const jitter = Math.random() * BASE_BACKOFF_MS;
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        if (res.status === 404) throw new Error(`Not found: ${url}`);
        if (res.status === 304) return res; // conditional cache hit
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      return res;
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === "AbortError" || e.message.includes("fetch failed"))
      ) {
        if (attempt < retries) {
          const jitter = Math.random() * BASE_BACKOFF_MS;
          const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many retries");
}

async function fetchJSONCached(
  url: string,
  opts?: { etag?: boolean }
): Promise<any> {
  const key = `json::${url}`;
  const cached = cacheGet(key);
  try {
    const res = await httpFetch(url, { json: true, etag: opts?.etag ? cached?.etag : undefined });

    if (res.status === 304 && cached) {
      // Update timestamp to extend TTL
      cacheSet(key, cached.value, cached.etag);
      return JSON.parse(cached.value);
    }

    const text = await res.text();
    const newEtag = res.headers.get("ETag") || undefined;
    cacheSet(key, text, newEtag);
    return JSON.parse(text);
  } catch (e: any) {
    // If conditional request fails, fallback to no-etag
    if (opts?.etag && e.message?.includes("Too many retries")) {
      const res2 = await httpFetch(url, { json: true });
      const text = await res2.text();
      cacheSet(key, text, res2.headers.get("ETag") || undefined);
      return JSON.parse(text);
    }
    throw e;
  }
}

async function fetchJSON(url: string): Promise<any> {
  const res = await httpFetch(url, { json: true });
  return res.json();
}

async function fetchJSONWithFallback(urls: string[]): Promise<any> {
  let lastErr: Error | undefined;
  for (const url of urls) {
    try {
      const res = await httpFetch(url, { json: true });
      if (res.ok) return res.json();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (e instanceof Error && e.message.includes("Rate limited")) throw e;
    }
  }
  throw lastErr ?? new Error(`All endpoints failed: ${urls.join(", ")}`);
}

async function fetchHTML(url: string): Promise<string> {
  const res = await httpFetch(url, { json: false });
  return res.text();
}

// ─── HTML/JSON helpers ──────────────────────────────────────────

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function formatDate(d: string): string {
  return new Date(d).toISOString().split("T")[0];
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// ─── Search scoring ─────────────────────────────────────────────

function scoreTopic(t: any): number {
  let score = 0;
  if (t.has_accepted_answer) score += 50;
  if (t.solved) score += 50;
  // Category weight
  if (t.category_id) {
    if (t.category_id === 6) score += 30;    // scripting-support
    if (t.category_id === 36) score += 20;   // updates
    if (t.category_id === 35) score += 15;   // help-and-feedback
  }
  score += (t.views ?? 0) * 0.001;
  score += (t.like_count ?? 0) * 0.5;
  const daysOld = t.created_at
    ? (Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24)
    : 0;
  score += Math.max(0, 30 - daysOld);
  return score;
}

function sortByRelevance(topics: any[]): any[] {
  return [...topics].sort((a, b) => scoreTopic(b) - scoreTopic(a));
}

// ─── DevForum helpers ───────────────────────────────────────────

function topicLine(t: any, users?: Map<number, string>): string {
  const date = t.created_at ? formatDate(t.created_at) : "unknown";
  const title = t.title || t.fancy_title || "Untitled";
  const url = `${DEVFORUM}/t/${t.slug || t.id}/${t.id}`;
  const views = t.views ?? 0;
  const replies = t.posts_count ? t.posts_count - 1 : t.reply_count ?? 0;
  let author = t.last_poster_username || "";
  if (!author && users && t.posters?.length) {
    const poster = t.posters[0];
    if (poster.user_id) author = users.get(poster.user_id) || "";
  }
  if (!author && users && t.id) author = users.get(t.id) || "";
  return `\u2022 ${title}\n  Author: ${author || "unknown"} | Date: ${date} | Replies: ${replies} | Views: ${views}\n  ${url}`;
}

function formatTopics(topics: any[], users: any[], limit: number): string {
  const userMap = new Map<number, string>();
  if (users) for (const u of users) userMap.set(u.id, u.username);
  return topics
    .slice(0, limit)
    .map((t) => {
      if (!t.last_poster_username && t.posters?.length) {
        const poster = t.posters[0];
        if (poster.user_id)
          t.last_poster_username = userMap.get(poster.user_id) || "unknown";
      }
      return topicLine(t, userMap);
    })
    .join("\n\n");
}

function searchUserMap(data: any): Map<number, string> {
  const map = new Map<number, string>();
  if (data.users) for (const u of data.users) map.set(u.id, u.username);
  if (data.posts && !map.size) {
    for (const p of data.posts) {
      if (p.topic_id && p.username && !map.has(p.topic_id))
        map.set(p.topic_id, p.username);
    }
  }
  return map;
}

// ─── Roblox Status ──────────────────────────────────────────────

interface StatusComponent {
  name: string;
  status: string;
  description?: string;
}

interface StatusPage {
  page: { name: string; url: string };
  components: StatusComponent[];
  incidents: any[];
}

function parseStatusHtml(html: string): StatusPage {
  const components: StatusComponent[] = [];
  const incidents: any[] = [];
  // Extract sub-components: container_name -> name, pull-right -> status
  const subRe = /container_name[^>]*>([^<]+)<\/p>[\s\S]*?pull-right[^>]*>([^<]+)<\/p>/g;
  let m;
  while ((m = subRe.exec(html)) !== null) {
    const name = m[1].trim();
    const status = m[2].trim();
    if (name && status) components.push({ name, status });
  }
  // Extract top-level: component_name (without <i> icon) -> status
  const topRe = /component_name[^>]*><i[^>]*><\/i>\s*(\w+)<\/p>[\s\S]*?component-status[^>]*>([^<]+)<\/p>/g;
  while ((m = topRe.exec(html)) !== null) {
    components.unshift({ name: m[1].trim(), status: m[2].trim() });
  }
  // Extract incidents from history section
  const incRe = /class="white"><a[^>]*>([^<]+)<\/a>[\s\S]*?status_description">([^<]+)/g;
  while ((m = incRe.exec(html)) !== null) {
    incidents.push({ name: m[1].trim(), status: m[2].trim() });
  }
  return { page: { name: "Roblox", url: "https://status.roblox.com" }, components, incidents };
}

async function getRobloxStatusData(): Promise<StatusPage> {
  try {
    const res = await httpFetch("https://status.roblox.com", { json: false });
    const html = await res.text();
    return parseStatusHtml(html);
  } catch {
    return { page: { name: "Roblox", url: "https://status.roblox.com" }, components: [], incidents: [] };
  }
}

// ─── API Dump (with conditional caching) ────────────────────────

interface ApiItem {
  Name: string;
  Value: number;
}

interface ApiEnum {
  Name: string;
  Items: ApiItem[];
}

interface ApiMember {
  Name: string;
  MemberType: string;
  Category?: string;
  Security?: string | { Read?: string; Write?: string };
  ValueType?: { Name: string; Category?: string };
  Parameters?: Array<{
    Name: string;
    Type: { Name: string };
    Default?: string;
  }>;
  ReturnType?: { Name: string };
  Tags?: string[];
  Description?: string;
}

interface ApiClass {
  Name: string;
  Superclass?: string;
  Members?: ApiMember[];
  Tags?: string[];
  Description?: string;
}

interface ApiDump {
  Classes: ApiClass[];
  Enums: ApiEnum[];
  Version: number;
}

let apiDumpCache: ApiDump | null = null;
let apiDumpTs = 0;

async function getApiDump(): Promise<ApiDump> {
  if (apiDumpCache && Date.now() - apiDumpTs < CACHE_TTL_MS) return apiDumpCache;
  const data = await fetchJSONCached(
    "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json",
    { etag: true }
  );
  apiDumpCache = data as ApiDump;
  apiDumpTs = Date.now();
  return apiDumpCache!;
}

// ─── Creator Hub docs ───────────────────────────────────────────

async function fetchCreatorDocsHTML(docPath: string): Promise<string> {
  const url = `${CREATOR_DOCS}/${docPath}`;
  const cached = cacheGet(url);
  if (cached) return cached.value;
  const html = await fetchHTML(url);
  cacheSet(url, html);
  return html;
}

function extractNextData(html: string): any {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s
  );
  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // fallthrough
    }
  }
  return null;
}

function flattenDocBody(body: any[]): string {
  if (!Array.isArray(body)) return "";
  return body
    .map((block: any) => {
      if (typeof block === "string") return block;
      if (block.text) return block.text;
      if (block.children)
        return block.children
          .map((c: any) => (typeof c === "string" ? c : c.text || ""))
          .join("");
      if (block.code) return `\`\`\`\n${block.code}\n\`\`\``;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

// ─── Luau Docs ───────────────────────────────────────────────────

async function getLuauDoc(libraryName: string): Promise<string> {
  try {
    const html = await fetchHTML("https://luau-lang.org/library");
    const sectionStart = html.indexOf(`${libraryName} library`);
    if (sectionStart === -1) {
      const available = ["math", "table", "string", "coroutine", "bit32", "utf8", "os", "debug", "buffer", "vector"];
      return `Library "${libraryName}" not found.\nAvailable: ${available.join(", ")}.`;
    }
    const nextSection = html.indexOf(" library", sectionStart + 20);
    const sectionEnd = nextSection > sectionStart ? nextSection : Math.min(sectionStart + 5000, html.length);
    const section = html.substring(sectionStart, sectionEnd);
    const functions = [...section.matchAll(/function\s+([\w.]+)\(([^)]*)\)(?::\s*([^\n]+))?/gi)];
    let out = `# Luau ${libraryName} library\n\n`;
    for (const m of functions) {
      out += `- **${m[1]}**(${m[2]})${m[3] ? ": " + m[3] : ""}\n`;
    }
    if (!functions.length) out += strip(section.substring(0, 3000));
    return out;
  } catch (e) {
    return `Error fetching Luau docs: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── DuckDuckGo site: search ─────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

async function siteSearch(ddg: string, query: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  const url = `${ddg}/?q=${q}+site%3Acreate.roblox.com%2Fdocs`;
  try {
    const html = await fetchHTML(url);
    const results: SearchResult[] = [];
    const anchors = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
    for (const m of anchors) {
      const rawUrl = m[1];
      const title = strip(m[2]);
      if (!title || !rawUrl) continue;
      let realUrl = rawUrl;
      if (rawUrl.startsWith("//")) realUrl = "https:" + rawUrl;
      results.push({ title, url: realUrl });
    }
    return results.slice(0, 10);
  } catch {
    return [];
  }
}

// ─── Creator Store search ──────────────────────────────────────

function fmtTags(tags: any[] | undefined): string {
  if (!tags || !tags.length) return "";
  const flat = tags.map((t: any) => {
    if (typeof t === "string") return t;
    if (typeof t === "object" && t !== null) {
      const parts = Object.entries(t).map(([k, v]) => `${k}: ${v}`);
      return parts.join("; ");
    }
    return String(t);
  });
  return ` [${flat.join(", ")}]`;
}

const VALID_LIMITS = [10, 28, 30, 50, 60, 100, 120];
function normalizeLimit(n: number): number {
  return VALID_LIMITS.find((v: number) => v >= n) || 10;
}

async function searchCreatorStore({ query, assetType, limit }: { query: string; assetType?: string; limit: number }): Promise<any[]> {
  const category = assetType || "Models";
  const searchLimit = normalizeLimit(Math.min(limit, 30));
  const searchUrl = `${CREATOR_STORE}/v1/search/items?Category=${category}&SortType=Relevance&Limit=${searchLimit}&Keyword=${encodeURIComponent(query)}`;
  const searchData = await fetchJSON(searchUrl);
  const items = (searchData.data || []) as any[];
  const assets = items.filter((i: any) => i.itemType === "Asset");

  // Fetch economy details per asset (single-endpoint; no public batch exists)
  const results: any[] = [];
  const maxDetails = Math.min(limit, assets.length);
  for (let i = 0; i < maxDetails; i++) {
    try {
      const id = assets[i].id;
      const details = await fetchJSON(`https://economy.roblox.com/v2/assets/${id}/details`);
      results.push(details);
    } catch (_) {
      // skip failed detail fetch
    }
  }
  return results;
}

// ════════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════════

// ─── DevForum ───────────────────────────────────────────────────

SERVER.registerTool(
  "get_announcements",
  {
    title: "Get Announcements",
    description: "Get latest Roblox Developer Forum announcements",
    inputSchema: z.object({
      limit: z.number().min(1).max(30).default(10).describe("Number of announcements to return"),
    }),
  },
  async ({ limit }) => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/c/updates/announcements/36.json`);
      const text = formatTopics(data.topic_list.topics, data.users, limit);
      return ok(`Roblox DevForum Announcements:\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_latest_posts",
  {
    title: "Get Latest Posts",
    description:
      "Get latest posts from the Roblox Developer Forum, optionally filtered by category",
    inputSchema: z.object({
      limit: z.number().min(1).max(30).default(10).describe("Number of posts to return"),
      category_id: z.number().optional().describe("Optional category ID to filter by"),
    }),
  },
  async ({ limit, category_id }) => {
    try {
      let url = `${DEVFORUM}/latest.json`;
      if (category_id) url += `?category=${category_id}`;
      const data = await fetchJSON(url);
      const topics = sortByRelevance(data.topic_list.topics || []).slice(0, limit);
      const text = formatTopics(topics, data.users, limit);
      return ok(`Latest DevForum Posts:\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "search_devforum",
  {
    title: "Search DevForum",
    description: "Search the Roblox Developer Forum for topics matching a query",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
  },
  async ({ query, limit }) => {
    try {
      const data = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(query + " order:latest")}`
      );
      let topics = data.topics || [];
      if (!topics.length) return ok(`No results found for "${query}".`);
      topics = sortByRelevance(topics);
      const userMap = searchUserMap(data);
      const lines = topics
        .slice(0, limit)
        .map((t: any) => {
          const base = topicLine(t, userMap);
          const solved = t.has_accepted_answer ? " [SOLVED]" : "";
          return base + solved;
        })
        .join("\n\n");
      return ok(`Search results for "${query}":\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_thread",
  {
    title: "Get Thread",
    description:
      "Get a specific DevForum thread. Returns the first post (title + content) and reply count. Use get_post_replies to read replies." +
      " Optionally includes the accepted answer if present.",
    inputSchema: z.object({
      thread_id: z.string().describe("Thread ID or slug"),
      include_op: z.boolean().optional().default(false).describe("Include original post in accepted answer"),
    }),
  },
  async ({ thread_id, include_op }) => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json`);
      const firstPost = data.post_stream?.posts?.[0];
      let text = `Title: ${data.title}\n`;
      text += `Author: ${firstPost?.username || "unknown"} | Date: ${formatDate(data.created_at)}\n`;
      text += `Tags: ${(data.tags || []).join(", ") || "none"}\n`;
      text += `Replies: ${data.posts_count - 1} | Views: ${data.views}\n`;
      text += `Solved: ${data.has_accepted_answer ? "Yes" : "No"}\n`;
      text += `URL: ${DEVFORUM}/t/${data.slug}/${data.id}\n\n`;

      if (firstPost) {
        text += `--- First Post by ${firstPost.username} (${formatDate(firstPost.created_at)}) ---\n`;
        text += strip(firstPost.cooked);
      }

      // Accepted answer
      const hasAccepted = data.has_accepted_answer || data.post_stream?.posts?.some((p: any) => p.accepted_answer);
      if (hasAccepted) {
        const allPosts = data.post_stream?.posts || [];
        const acceptedPost = allPosts.find((p: any) => p.accepted_answer === true);
        if (acceptedPost) {
          text += `\n\n\u2705 ACCEPTED ANSWER by ${acceptedPost.username} (${formatDate(acceptedPost.created_at)})\n`;
          text += strip(acceptedPost.cooked);
        } else if (data.post_stream?.stream?.length > allPosts.length) {
          text += `\n\n\u2705 This thread has an accepted answer, but it is on a later page. Use get_post_replies with a higher page number to find it.`;
        }
      }

      return ok(text.trim());
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_action_required",
  {
    title: "Get Action Required",
    description:
      "Get DevForum topics marked as requiring creator action, from the Updates category",
    inputSchema: z.object({
      tag: z.string().default("action-required").describe("Tag to filter by"),
    }),
  },
  async ({ tag }) => {
    try {
      const searchQ = `"${tag.replace(/-/g, " ")}" in:title category:updates order:latest`;
      const data = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`
      );
      let topics = data.topics || [];
      if (!topics.length) return ok(`No topics found for "${tag}".`);
      topics = sortByRelevance(topics);
      const userMap = searchUserMap(data);
      const lines = topics
        .slice(0, 20)
        .map((t: any) => topicLine(t, userMap))
        .join("\n\n");
      return ok(`Topics requiring action:\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_engine_updates",
  {
    title: "Get Engine Updates",
    description: "Get the latest Roblox engine and Studio updates from the DevForum",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/c/updates/36.json`);
      const text = formatTopics(data.topic_list.topics, data.users, 15);
      return ok(`Roblox Engine & Studio Updates:\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_category",
  {
    title: "Get Category",
    description: "Get topics from a specific DevForum category by slug and ID",
    inputSchema: z.object({
      slug: z.string().describe('Category slug (e.g. "help-and-feedback")'),
      category_id: z.number().describe("Category ID number"),
      limit: z.number().min(1).max(30).default(10).describe("Max topics to return"),
    }),
  },
  async ({ slug, category_id, limit }) => {
    try {
      const data = await fetchJSON(
        `${DEVFORUM}/c/${encodeURIComponent(slug)}/${category_id}.json`
      );
      const text = formatTopics(data.topic_list.topics, data.users, limit);
      return ok(`Topics in "${slug}":\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_top_posts",
  {
    title: "Get Top Posts",
    description: "Get top DevForum posts for a given time period",
    inputSchema: z.object({
      period: z.enum(["daily", "weekly", "monthly", "yearly", "all"]).describe("Time period"),
    }),
  },
  async ({ period }) => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/top/${period}.json`);
      const text = formatTopics(data.topic_list.topics, data.users, 15);
      return ok(`Top posts (${period}):\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_post_replies",
  {
    title: "Get Post Replies",
    description:
      "Get replies for a DevForum thread at a specific page. Fetches one page only.",
    inputSchema: z.object({
      thread_id: z.string().describe("Thread ID"),
      page: z.number().min(1).default(1).describe("Page number (1-indexed)"),
      max_length: z
        .number()
        .min(100)
        .max(8000)
        .optional()
        .describe("Max characters per post (truncated if longer)"),
    }),
  },
  async ({ thread_id, page, max_length }) => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json?page=${page}`);
      const posts = data.post_stream?.posts || [];
      if (!posts.length) return ok(`No posts found on page ${page}.`);
      let text = `Thread: ${data.title} \u2014 Page ${page}\n\n`;
      for (const p of posts) {
        let body = strip(p.cooked);
        if (max_length && body.length > max_length) {
          body = body.slice(0, max_length - 3) + "...";
        }
        text += `--- ${p.username} (${formatDate(p.created_at)}) ---\n`;
        text += body + "\n\n";
      }
      return ok(text.trim());
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_user_posts",
  {
    title: "Get User Posts",
    description: "Get recent activity for a DevForum user",
    inputSchema: z.object({
      username: z.string().describe("DevForum username"),
    }),
  },
  async ({ username }) => {
    try {
      let header = `Recent activity for ${username}:\n\n`;
      try {
        const profile = await fetchJSON(`${DEVFORUM}/u/${encodeURIComponent(username)}.json`);
        const u = profile.user;
        if (u) {
          header = `User: ${u.username} | Trust: ${u.trust_level ?? "unknown"} | Posts: ${u.post_count ?? "unknown"}\n`;
          if (u.title) header += `Title: ${u.title}\n`;
          header += "\n";
        }
      } catch {
        // Profile may be private
      }

      const res = await fetch(
        `${DEVFORUM}/u/${encodeURIComponent(username)}/activity.json`,
        { headers: COMMON_HEADERS }
      );
      if (!res.ok) {
        return ok(
          `${header}Could not fetch activity (HTTP ${res.status}). The profile may be private or the username may be incorrect.`
        );
      }
      const data = await res.json();

      if (Array.isArray(data)) {
        const posts = data.slice(0, 15);
        if (!posts.length) return ok(`${header}No recent activity.`);
        const topicIds = [...new Set(posts.map((p: any) => p.topic_id).filter(Boolean))].slice(0, 10);
        const titleMap = new Map<number, string>();
        await Promise.all(
          topicIds.map(async (id) => {
            try {
              const tData = await fetchJSON(`${DEVFORUM}/t/${id}.json`);
              if (tData.title) titleMap.set(id, tData.title);
            } catch {
              // ignore
            }
          })
        );
        const lines = posts
          .map((p: any) => {
            const excerpt = strip(p.excerpt || p.cooked || "").slice(0, 150);
            const topicTitle = titleMap.get(p.topic_id) || `Topic #${p.topic_id}`;
            const topicSlug = p.slug || p.topic_id;
            const topicUrl = `${DEVFORUM}/t/${topicSlug}/${p.topic_id}`;
            return `\u2022 ${topicTitle}\n  Author: ${p.username || "unknown"} | Date: ${formatDate(p.created_at)}\n  ${topicUrl}\n  ${excerpt}`;
          })
          .join("\n\n");
        return ok(`${header}${lines}`);
      }

      const topics = data.topic_list?.topics || [];
      if (!topics.length) return ok(`${header}No recent topic activity.`);
      const lines = topics.slice(0, 15).map((t: any) => topicLine(t)).join("\n\n");
      return ok(`${header}${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

// ─── Creator Hub ────────────────────────────────────────────────

SERVER.registerTool(
  "get_creator_docs",
  {
    title: "Get Creator Docs",
    description:
      "Fetch Creator Hub docs with __NEXT_DATA__ structured extraction. Use docs path like 'docs/reference/engine/classes/BasePart' or 'docs/production/publishing/publishing-experience'.",
    inputSchema: z.object({
      path: z.string().describe("Doc path (e.g. docs/reference/engine/classes/BasePart)"),
    }),
  },
  async ({ path }) => {
    try {
      const html = await fetchCreatorDocsHTML(path);
      const nextData = extractNextData(html);
      if (!nextData) {
        const cleaned = strip(html).slice(0, 4000);
        return ok(
          `Creator docs page found but no structured data available:\n\n${cleaned}`
        );
      }

      const pageProps = nextData.props?.pageProps;
      const doc = pageProps?.doc || pageProps?.data;
      if (!doc) {
        const cleaned = strip(html).slice(0, 4000);
        return ok(
          `Creator docs page found but no structured doc data:\n\n${cleaned}`
        );
      }

      const title = doc.title || doc.name || "Untitled";
      let out = `# ${title}\n`;
      if (doc.description) out += `${doc.description}\n\n`;

      if (doc.body) {
        out += flattenDocBody(doc.body);
      } else if (doc.content) {
        out +=
          typeof doc.content === "string"
            ? strip(doc.content)
            : flattenDocBody(doc.content);
      }

      return ok(out.trim());
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "search_creator_docs",
  {
    title: "Search Creator Docs",
    description:
      "Search official Roblox Creator Hub documentation (create.roblox.com/docs). Returns direct doc links. For community tutorials, use search_community_resources.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(20).default(10).describe("Max results"),
    }),
  },
  async ({ query, limit }) => {
    try {
      // Primary: DevForum resources category
      const devforumData = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(
          `${query} category:resources order:latest`
        )}`
      );
      let topics = devforumData.topics || [];

      // Fallback: DuckDuckGo site: search
      let ddgResults: SearchResult[] = [];
      if (!topics.length) {
        ddgResults = await siteSearch(SEARCH_ENGINE, query);
      }

      const userMap = searchUserMap(devforumData);
      let lines = topics
        .slice(0, limit)
        .map((t: any) => topicLine(t, userMap));

      for (const r of ddgResults.slice(0, limit)) {
        lines.push(`\u2022 ${r.title}\n  ${r.url}`);
      }

      if (!lines.length) return ok(`No results found for "${query}" in Creator Docs.`);
      return ok(`Creator Docs search for "${query}":\n\n${lines.join("\n\n")}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_luau_docs",
  {
    title: "Get Luau Docs",
    description:
      "Get Luau standard library reference for built-in modules: math, string, table, task, coroutine, os, utf8, bit32, debug.",
    inputSchema: z.object({
      library: z.string().describe('Library name (e.g. "math", "string", "table", "task")'),
    }),
  },
  async ({ library }) => {
    const out = await getLuauDoc(library);
    return ok(out);
  }
);

// ─── API Reference ──────────────────────────────────────────────

SERVER.registerTool(
  "get_api_docs",
  {
    title: "Get API Docs",
    description:
      "Get Roblox Creator documentation for an engine class (properties, methods, events, callbacks, inheritance).",
    inputSchema: z.object({
      class_name: z.string().describe('Engine class name (e.g. "BasePart", "Workspace")'),
      include_inherited: z.boolean().optional().default(false).describe("Include inherited members from parent classes"),
    }),
  },
  async ({ class_name, include_inherited }) => {
    try {
      const dump = await getApiDump();
      const classes = dump.Classes;
      const cls = classes.find(
        (c) => c.Name.toLowerCase() === class_name.toLowerCase()
      );

      if (!cls) {
        const partials = classes
          .filter((c) => c.Name.toLowerCase().includes(class_name.toLowerCase()))
          .slice(0, 10);
        if (partials.length > 0) {
          return ok(
            `Class "${class_name}" not found. Did you mean:\n${partials.map((c) => `- ${c.Name}`).join("\n")}`
          );
        }
        return ok(`Class "${class_name}" not found in the Roblox API.`);
      }

      // Build inheritance chain
      const chain: string[] = [cls.Name];
      let current: ApiClass | undefined = cls;
      while (current?.Superclass && current.Superclass !== "<<<ROOT>>>") {
        chain.push(current.Superclass);
        const parent = classes.find((c) => c.Name === current!.Superclass);
        if (!parent) break;
        current = parent;
      }

      let output = `# ${cls.Name}\n`;
      output += `Inherits: ${chain.join(" > ")}\n`;
      if (cls.Tags && cls.Tags.length > 0)
        output += `Tags: ${cls.Tags.join(", ")}\n`;
      if (cls.Description) output += `Description: ${cls.Description}\n`;
      output += `Docs: ${CREATOR_DOCS}/docs/reference/engine/classes/${cls.Name}\n\n`;

      // Collect members
      const allMembers: ApiMember[] = include_inherited
        ? []
        : [...(cls.Members ?? [])];

      if (include_inherited) {
        let walk: ApiClass | undefined = cls;
        while (walk) {
          if (walk.Members) {
            for (const m of walk.Members) {
              if (!allMembers.some((existing) => existing.Name === m.Name)) {
                allMembers.push(m);
              }
            }
          }
          if (!walk.Superclass || walk.Superclass === "<<<ROOT>>>") break;
          walk = classes.find((c) => c.Name === walk!.Superclass);
        }
      }

      const members = allMembers;
      const properties = members.filter((m) => m.MemberType === "Property");
      const methods = members.filter((m) => m.MemberType === "Function");
      const events = members.filter((m) => m.MemberType === "Event");
      const callbacks = members.filter((m) => m.MemberType === "Callback");

      if (properties.length > 0) {
        output += `## Properties (${properties.length})\n`;
        for (const p of properties) {
          const tags = fmtTags(p.Tags);
          const type = p.ValueType?.Name ?? "unknown";
          const desc = p.Description ? ` \u2014 ${p.Description}` : "";
          output += `- **${p.Name}**: ${type}${tags}${desc}\n`;
        }
        output += "\n";
      }

      if (methods.length > 0) {
        output += `## Methods (${methods.length})\n`;
        for (const m of methods) {
          const tags = fmtTags(m.Tags);
          const params = (m.Parameters ?? [])
            .map(
              (p) =>
                `${p.Name}: ${p.Type.Name}${p.Default !== undefined ? ` = ${p.Default}` : ""}`
            )
            .join(", ");
          const ret = m.ReturnType?.Name ?? "void";
          const desc = m.Description ? ` \u2014 ${m.Description}` : "";
          output += `- **${m.Name}**(${params}): ${ret}${tags}${desc}\n`;
        }
        output += "\n";
      }

      if (events.length > 0) {
        output += `## Events (${events.length})\n`;
        for (const e of events) {
          const tags = fmtTags(e.Tags);
          const params = (e.Parameters ?? [])
            .map((p) => `${p.Name}: ${p.Type.Name}`)
            .join(", ");
          const desc = e.Description ? ` \u2014 ${e.Description}` : "";
          output += `- **${e.Name}**(${params})${tags}${desc}\n`;
        }
        output += "\n";
      }

      if (callbacks.length > 0) {
        output += `## Callbacks (${callbacks.length})\n`;
        for (const c of callbacks) {
          const tags = fmtTags(c.Tags);
          const desc = c.Description ? ` \u2014 ${c.Description}` : "";
          output += `- **${c.Name}**${tags}${desc}\n`;
        }
        output += "\n";
      }

      if (include_inherited) {
        output += `\nNote: Inherited members from ${chain.slice(1).join(", ")} are included.\n`;
      } else if (cls.Superclass && cls.Superclass !== "<<<ROOT>>>") {
        output += `\n_Inherited from ${chain.slice(1).join(", ")} \u2014 use get_api_docs with "include_inherited" for those members._\n`;
      }

      return ok(output);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "search_api_member",
  {
    title: "Search API Member",
    description:
      "Search for a property, method, event, or callback by name across ALL Roblox API classes.",
    inputSchema: z.object({
      query: z.string().describe("Member name to search for (e.g. Touched, Position, Destroy)"),
      member_type: z
        .enum(["Property", "Function", "Event", "Callback"])
        .optional()
        .describe('Filter by member type: Property, Function, Event, or Callback (case-sensitive)'),
      limit: z.number().min(1).max(50).default(10).describe("Max results"),
    }),
  },
  async ({ query, member_type, limit }) => {
    try {
      const dump = await getApiDump();
      const classes = dump.Classes;
      const results: { className: string; member: ApiMember }[] = [];
      const q = query.toLowerCase();
      for (const cls of classes) {
        for (const m of cls.Members ?? []) {
          if (!m.Name.toLowerCase().includes(q)) continue;
          if (member_type && m.MemberType !== member_type) continue;
          results.push({ className: cls.Name, member: m });
        }
      }
      if (!results.length) {
        return ok(
          `No API member found matching "${query}"${member_type ? ` of type ${member_type}` : ""}.`
        );
      }
      const lines = results
        .slice(0, limit)
        .map((r) => `\u2022 ${r.member.Name} (${r.member.MemberType}) in ${r.className}`)
        .join("\n");
      return ok(
        `Results for "${query}"${member_type ? ` [type: ${member_type}]` : ""}:\n\n${lines}`
      );
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_class_hierarchy",
  {
    title: "Get Class Hierarchy",
    description:
      "Get the full inheritance tree for a Roblox class, showing all parent classes and direct subclasses.",
    inputSchema: z.object({
      class_name: z.string().describe('Engine class name (e.g. "BasePart", "RemoteEvent")'),
    }),
  },
  async ({ class_name }) => {
    try {
      const dump = await getApiDump();
      const classes = dump.Classes;
      const cls = classes.find(
        (c) => c.Name.toLowerCase() === class_name.toLowerCase()
      );
      if (!cls) return ok(`Class "${class_name}" not found.`);

      // Parents
      const chain: string[] = [cls.Name];
      let curr: ApiClass | undefined = cls;
      while (curr?.Superclass && curr.Superclass !== "<<<ROOT>>>") {
        chain.push(curr.Superclass);
        curr = classes.find((c) => c.Name === curr!.Superclass);
      }

      // Subclasses
      const children = classes
        .filter((c) => c.Superclass?.toLowerCase() === cls.Name.toLowerCase())
        .map((c) => c.Name)
        .sort();

      let out = `# ${cls.Name} Hierarchy\n\n`;
      out += `Chain: ${chain.join(" > ")}\n`;
      out += `Direct subclasses: ${children.length ? children.join(", ") : "none"}\n`;

      const totalDescendants = classes.filter(
        (c) =>
          c.Superclass &&
          chain.some((a) => a.toLowerCase() === c.Superclass!.toLowerCase())
      ).length;
      out += `Total inheriting classes: ${totalDescendants}\n`;
      return ok(out);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_enum",
  {
    title: "Get Enum",
    description:
      "List or inspect Roblox API enums. If name is provided, returns all values for that enum with descriptions. If omitted, returns list of all enums.",
    inputSchema: z.object({
      name: z.string().optional().describe('Enum name (e.g. "Material", "PartType")'),
      filter: z.string().optional().describe("Filter enum names when listing"),
    }),
  },
  async ({ name, filter }) => {
    try {
      const dump = await getApiDump();
      const allEnums = dump.Enums || [];

      if (name) {
        const match = allEnums.find(
          (e) => e.Name.toLowerCase() === name.toLowerCase()
        );
        if (!match) {
          // Suggest similar
          const similar = allEnums
            .filter((e) => e.Name.toLowerCase().includes(name.toLowerCase()))
            .slice(0, 5)
            .map((e) => e.Name);
          const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
          return ok(`Enum "${name}" not found.${hint}`);
        }
        const items = match.Items || [];
        let out = `# Enum ${match.Name}\n`;
        out += `Items: ${items.length}\n\n`;
        for (const item of items) {
          out += `- **${item.Name}** = ${item.Value}\n`;
        }
        return ok(out);
      }

      let list = allEnums.map((e) => e.Name).sort();
      if (filter) {
        const f = filter.toLowerCase();
        list = list.filter((e) => e.toLowerCase().includes(f));
      }
      return ok(`Roblox API Enums (${list.length} total):\n\n${list.slice(0, 100).join(", ")}`);
    } catch (e) {
      return err(e);
    }
  }
);

// ─── DevForum search helpers ────────────────────────────────────

SERVER.registerTool(
  "get_categories",
  {
    title: "Get Categories",
    description:
      "List all DevForum categories with ID, slug, name, description, and topic count",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/categories.json`);
      const cats = data.category_list?.categories || [];
      let siteCats: Map<number, any> | null = null;
      try {
        const siteData = await fetchJSON(`${DEVFORUM}/site.json`);
        const all = siteData.categories || [];
        siteCats = new Map(all.map((c: any) => [c.id, c]));
      } catch {
        // ignore
      }
      const lines = cats
        .map((c: any) => {
          const desc = c.description_text ? ` \u2014 ${c.description_text.slice(0, 100)}` : "";
          let topicCount = c.topic_count;
          if (!topicCount && siteCats) {
            const subs = [...siteCats.values()].filter(
              (s: any) => s.parent_category_id === c.id
            );
            topicCount = subs.reduce(
              (sum: number, s: any) => sum + (s.topic_count || 0),
              0
            );
          }
          return `\u2022 ${c.name} (ID: ${c.id}, slug: ${c.slug})${desc}\n  Topics: ${topicCount || 0}`;
        })
        .join("\n\n");
      return ok(`DevForum Categories:\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_tags",
  {
    title: "Get Tags",
    description: "List all available DevForum tags with topic counts",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/tags.json`);
      const tags = data.tags || [];
      const sorted = tags
        .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
        .slice(0, 100);
      const lines = sorted
        .map((t: any) => `\u2022 ${t.name} (${t.count} topics)`)
        .join("\n");
      return ok(`DevForum Tags (top 100 by topic count):\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_category_metadata",
  {
    title: "Get Category Metadata",
    description:
      "Get metadata for a specific DevForum category (name, description, subcategories, moderators, topic count). Returns metadata only, not topics.",
    inputSchema: z.object({
      category_id: z.number().describe("Category ID number"),
    }),
  },
  async ({ category_id }) => {
    try {
      const data = await fetchJSON(`${DEVFORUM}/c/${category_id}/show.json`);
      const raw = data.category;
      let topicCount = raw.topic_count;
      let postCount = raw.post_count;
      let subs: any[] = data.subcategory_list?.categories || [];

      if (!topicCount || (!subs.length && raw.subcategory_ids?.length)) {
        try {
          const siteData = await fetchJSON(`${DEVFORUM}/site.json`);
          const allCats: any[] = siteData.categories || [];
          if (!subs.length) {
            subs = allCats.filter((c: any) => c.parent_category_id === category_id);
          }
          if (!topicCount && subs.length) {
            topicCount = subs.reduce(
              (sum: number, s: any) => sum + (s.topic_count || 0),
              0
            );
            postCount = subs.reduce(
              (sum: number, s: any) => sum + (s.post_count || 0),
              0
            );
          }
        } catch {
          // ignore
        }
      }

      let text = `Category: ${raw.name} (ID: ${raw.id})\n`;
      text += `Slug: ${raw.slug}\n`;
      text += `Description: ${strip(raw.description || "none")}\n`;
      text += `Topics: ${topicCount}\n`;
      text += `Posts: ${postCount}\n`;

      if (subs.length) {
        text += `Subcategories: ${subs
          .map((s: any) => `${s.name} (ID: ${s.id}, ${s.topic_count} topics)`)
          .join(", ")}\n`;
      }

      if (raw.moderators?.length) {
        text += `Moderators: ${raw.moderators
          .map((m: any) => m.username)
          .join(", ")}\n`;
      }

      return ok(text.trim());
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "search_bugs",
  {
    title: "Search Bugs",
    description:
      "Search for bug reports on the DevForum. One category at a time.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      category: z
        .enum(["studio-bugs", "engine-bugs"])
        .default("studio-bugs")
        .describe("Bug category"),
      limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
  },
  async ({ query, category, limit }) => {
    try {
      const q = `${query} category:${category} order:latest`;
      const data = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`
      );
      let topics = data.topics || [];
      if (!topics.length)
        return ok(`No bug reports found for "${query}" in ${category}.`);
      topics = sortByRelevance(topics);
      const userMap = searchUserMap(data);
      const lines = topics
        .slice(0, limit)
        .map((t: any) => topicLine(t, userMap))
        .join("\n\n");
      return ok(`Bug reports for "${query}" in ${category}:\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_solved_topics",
  {
    title: "Get Solved Topics",
    description:
      "Search for solved DevForum topics. PREFERRED tool for debugging.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
  },
  async ({ query, limit }) => {
    try {
      const q = `${query} status:solved order:latest`;
      const data = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`
      );
      let topics = data.topics || [];
      if (!topics.length) return ok(`No solved topics found for "${query}".`);
      topics = sortByRelevance(topics);
      const userMap = searchUserMap(data);
      const lines = topics
        .slice(0, limit)
        .map((t: any) => {
          const base = topicLine(t, userMap);
          const accepted = t.has_accepted_answer ? " \u2705 Has accepted answer" : "";
          return base + accepted;
        })
        .join("\n\n");
      return ok(`Solved topics for "${query}":\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "get_new_posts",
  {
    title: "Get New Posts",
    description:
      "Get the newest topics on the DevForum. Falls back to latest if new topics endpoint requires authentication.",
    inputSchema: z.object({
      limit: z.number().min(1).max(30).default(15).describe("Max topics to return"),
    }),
  },
  async ({ limit }) => {
    try {
      const data = await fetchJSONWithFallback([
        `${DEVFORUM}/new.json`,
        `${DEVFORUM}/latest.json?order=created`,
      ]);
      const text = formatTopics(data.topic_list.topics, data.users, limit);
      return ok(`Newest DevForum topics:\n\n${text}`);
    } catch (e) {
      return err(e);
    }
  }
);

SERVER.registerTool(
  "search_community_resources",
  {
    title: "Search Community Resources",
    description:
      "Search community tutorials and resources from the DevForum Resources and Tutorials categories.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(20).default(10).describe("Max results"),
    }),
  },
  async ({ query, limit }) => {
    try {
      const data = await fetchJSON(
        `${DEVFORUM}/search.json?q=${encodeURIComponent(
          `${query} category:resources category:tutorials order:latest`
        )}`
      );
      let topics = data.topics || [];
      if (!topics.length)
        return ok(`No community resources found for "${query}".`);
      topics = sortByRelevance(topics);
      const userMap = searchUserMap(data);
      const lines = topics
        .slice(0, limit)
        .map((t: any) => topicLine(t, userMap))
        .join("\n\n");
      return ok(`Community resources for "${query}":\n\n${lines}`);
    } catch (e) {
      return err(e);
    }
  }
);

// ─── Creator Store ──────────────────────────────────────────────

SERVER.registerTool(
  "search_creator_store",
  {
    title: "Search Creator Store",
    description:
      "Search Roblox Creator Store (catalog) for assets: models, plugins, meshes, audio, decals. Returns asset ID, name, creator, price.",
    inputSchema: z.object({
      query: z.string().describe("Asset name or keyword"),
      asset_type: z
        .enum(["Models", "Audio", "Meshes", "Plugins", "Decals", "Animations", "Badges"])
        .optional()
        .describe("Optional asset category filter"),
      limit: z.number().min(1).max(50).default(10).describe("Max results"),
    }),
  },
  async ({ query, asset_type, limit }) => {
    try {
      const items = await searchCreatorStore({ query, assetType: asset_type, limit });
      if (!items.length) return ok(`No results found for "${query}" in the Creator Store.`);

      const lines = items.map((item: any) => {
        const name = item.Name || "Untitled";
        const creator = item.Creator?.Name || "unknown";
        const id = item.AssetId;
        const price = item.PriceInRobux !== undefined ? (item.PriceInRobux === null ? "N/A" : item.PriceInRobux === 0 ? "Free" : `R$${item.PriceInRobux}`) : "N/A";
        return "\u2022 " + name + "\n  ID: " + id + " | Creator: " + creator + " | Price: " + price + "\n  https://www.roblox.com/library/" + id;
      });

      return ok(`Creator Store results for "${query}":\n\n${lines.join("\n\n")}`);
    } catch (e) {
      return err(e);
    }
  }
);

// ─── Platform ───────────────────────────────────────────────────

SERVER.registerTool(
  "get_roblox_status",
  {
    title: "Get Roblox Status",
    description:
      "Check the current status of Roblox platform services (website, Studio, API, game servers, etc.)",
    inputSchema: z.object({
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include incident descriptions"),
    }),
  },
  async ({ verbose }) => {
    try {
      const data = await getRobloxStatusData();
      const components = data.components || [];
      const statuses = new Map<string, string[]>();
      for (const c of components) {
        const list = statuses.get(c.status) || [];
        list.push(c.name);
        statuses.set(c.status, list);
      }

      let out = `Roblox Platform Status\n`;
      out += `URL: ${data.page.url}\n\n`;
      for (const [status, names] of statuses) {
        out += `### ${status.toUpperCase()}\n`;
        for (const name of names) {
          out += `- ${name}\n`;
        }
        out += "\n";
      }

      // Active incidents
      if (verbose && data.incidents?.length) {
        out += `### Active Incidents\n`;
        for (const inc of data.incidents) {
          out += `- **${inc.name}**: ${inc.status}\n  ${inc.shortlink || ""}\n`;
        }
      }

      return ok(out.trim());
    } catch (e) {
      return err(e);
    }
  }
);

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await SERVER.connect(transport);
}

main().catch(() => {
  process.exit(1);
});
