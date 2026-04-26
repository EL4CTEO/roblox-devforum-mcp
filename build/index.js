#!/usr/bin/env node
"use strict";
// ─── Imports ─────────────────────────────────────────────────────
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = __importStar(require("zod"));
// ─── Constants ────────────────────────────────────────────────────
const VERSION = "3.2.1";
const DEVFORUM = "https://devforum.roblox.com";
const CREATOR_DOCS = "https://create.roblox.com";
const ROBLOX_STATUS = "https://status.roblox.com";
const SERVER = new mcp_js_1.McpServer({ name: "roblox-devforum-mcp", version: VERSION });
const COMMON_HEADERS = {
    Accept: "application/json",
    "User-Agent": `roblox-devforum-mcp/${VERSION}`,
};
const FETCH_TIMEOUT_MS = 15000; // 15s per request
const MAX_RETRIES = 3; // Readme advertised
const BASE_BACKOFF_MS = 1000; // 1s base backoff
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min TTL
const CACHE_MAX = 200; // 200-entry LRU
// ─── HTTP Helpers ────────────────────────────────────────────────
async function httpFetch(url, opts = {}) {
    const { json = false, retries = MAX_RETRIES } = opts;
    for (let attempt = 0; attempt < retries + 1; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                headers: json ? COMMON_HEADERS : { "User-Agent": COMMON_HEADERS["User-Agent"] },
                signal: controller.signal,
            });
            if (res.status === 429) {
                const jitter = Math.random() * BASE_BACKOFF_MS;
                const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter;
                await new Promise((r) => setTimeout(r, delay));
                continue; // retry
            }
            if (!res.ok) {
                if (res.status === 404)
                    throw new Error(`Not found: ${url}`);
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            return res;
        }
        catch (e) {
            if (e instanceof Error &&
                (e.name === "AbortError" || e.message.includes("fetch failed"))) {
                if (attempt < retries) {
                    const jitter = Math.random() * BASE_BACKOFF_MS;
                    const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + jitter;
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
            }
            throw e;
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw new Error("Too many retries");
}
async function fetchJSON(url) {
    const res = await httpFetch(url, { json: true });
    return res.json();
}
async function fetchJSONWithFallback(urls) {
    let lastErr;
    for (const url of urls) {
        try {
            const res = await httpFetch(url, { json: true });
            if (res.ok)
                return res.json();
        }
        catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            if (e instanceof Error && e.message.includes("Rate limited"))
                throw e;
        }
    }
    throw lastErr ?? new Error(`All endpoints failed: ${urls.join(", ")}`);
}
async function fetchHTML(url) {
    const res = await httpFetch(url, { json: false });
    return res.text();
}
const CACHE = new Map();
const CACHE_KEYS = [];
function cacheGet(key) {
    const entry = CACHE.get(key);
    if (!entry)
        return undefined;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        CACHE.delete(key);
        const idx = CACHE_KEYS.indexOf(key);
        if (idx >= 0)
            CACHE_KEYS.splice(idx, 1);
        return undefined;
    }
    return entry.value;
}
function cacheSet(key, value) {
    if (CACHE.has(key)) {
        CACHE.delete(key); // move to end
        const idx = CACHE_KEYS.indexOf(key);
        if (idx >= 0)
            CACHE_KEYS.splice(idx, 1);
    }
    else if (CACHE_KEYS.length >= CACHE_MAX) {
        const oldest = CACHE_KEYS.shift();
        CACHE.delete(oldest);
    }
    CACHE.set(key, { value, ts: Date.now() });
    CACHE_KEYS.push(key);
}
// ─── HTML Strip ─────────────────────────────────────────────────
function strip(html) {
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
// ─── Date / Format Helpers ─────────────────────────────────────
function formatDate(d) {
    return new Date(d).toISOString().split("T")[0];
}
function topicLine(t, users) {
    const date = t.created_at ? formatDate(t.created_at) : "unknown";
    const title = t.title || t.fancy_title || "Untitled";
    const url = `${DEVFORUM}/t/${t.slug || t.id}/${t.id}`;
    const views = t.views ?? 0;
    const replies = t.posts_count ? t.posts_count - 1 : t.reply_count ?? 0;
    let author = t.last_poster_username || "";
    // Discourse search returns user_id in posters
    if (!author && users && t.posters?.length) {
        const poster = t.posters[0];
        if (poster.user_id)
            author = users.get(poster.user_id) || "";
    }
    if (!author && users && t.id) {
        author = users.get(t.id) || "";
    }
    return `\u2022 ${title}\n  Author: ${author || "unknown"} | Date: ${date} | Replies: ${replies} | Views: ${views}\n  ${url}`;
}
function formatTopics(topics, users, limit) {
    const userMap = new Map();
    if (users)
        for (const u of users)
            userMap.set(u.id, u.username);
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
function searchUserMap(data) {
    const map = new Map();
    if (data.users)
        for (const u of data.users)
            map.set(u.id, u.username);
    if (data.posts && !map.size) {
        for (const p of data.posts) {
            if (p.topic_id && p.username && !map.has(p.topic_id))
                map.set(p.topic_id, p.username);
        }
    }
    return map;
}
function ok(text) {
    return { content: [{ type: "text", text }] };
}
function err(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
// ─── Search Scoring (README advertised) ──────────────────────────
function scoreTopic(t) {
    let score = 0;
    // Solved boost
    if (t.has_accepted_answer)
        score += 50;
    if (t.solved)
        score += 50;
    // Category weight: bug reports > scripting support > general
    if (t.category_id) {
        if (t.category_id === 6)
            score += 30; // scripting-support
        if (t.category_id === 36)
            score += 20; // updates
        if (t.category_id === 35)
            score += 15; // help-and-feedback
    }
    // Engagement
    score += (t.views ?? 0) * 0.001;
    score += (t.like_count ?? 0) * 0.5;
    // Recency
    const daysOld = t.created_at
        ? (Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : 0;
    score += Math.max(0, 30 - daysOld); // up to +30 for fresh topics
    return score;
}
function sortByRelevance(topics) {
    return [...topics].sort((a, b) => scoreTopic(b) - scoreTopic(a));
}
async function getRobloxStatusData() {
    const data = await fetchJSON("https://kctbh9vrtdwd.statuspage.io//api/v2/components.json");
    return data;
}
let apiDumpCache = null;
let apiDumpTs = 0;
async function getApiDump() {
    if (apiDumpCache && Date.now() - apiDumpTs < CACHE_TTL_MS)
        return apiDumpCache;
    const data = await fetchJSON("https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json");
    apiDumpCache = data.Classes;
    apiDumpTs = Date.now();
    return apiDumpCache;
}
// ─── Creator Hub __NEXT_DATA__ ─────────────────────────────────
async function fetchCreatorDocsHTML(docPath) {
    const url = `${CREATOR_DOCS}/${docPath}`;
    const cached = cacheGet(url);
    if (cached)
        return cached;
    const html = await fetchHTML(url);
    cacheSet(url, html);
    return html;
}
function extractNextData(html) {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
    if (match && match[1]) {
        try {
            return JSON.parse(match[1]);
        }
        catch {
            // fallthrough
        }
    }
    return null;
}
function flattenDocBody(body) {
    if (!Array.isArray(body))
        return "";
    return body
        .map((block) => {
        if (typeof block === "string")
            return block;
        if (block.text)
            return block.text;
        if (block.children)
            return block.children.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
        if (block.code)
            return `\`\`\`\n${block.code}\n\`\`\``;
        return "";
    })
        .filter(Boolean)
        .join("\n\n");
}
// ─── Luau Docs ───────────────────────────────────────────────────
async function getLuauDoc(libraryName) {
    try {
        const data = await fetchJSON("https://raw.githubusercontent.com/luau-lang/luau/master/docs/_data/library.json");
        const lib = data.libraries?.find((l) => l.name?.toLowerCase() === libraryName.toLowerCase());
        if (!lib) {
            const available = (data.libraries || [])
                .map((l) => l.name)
                .filter(Boolean)
                .join(", ");
            return `Library "${libraryName}" not found.\nAvailable Luau libraries: ${available || "none found"}.`;
        }
        let out = `# Luau ${lib.name}\n`;
        if (lib.description)
            out += `${lib.description}\n\n`;
        for (const fn of lib.functions || []) {
            const params = (fn.parameters || []).map((p) => `${p.name}: ${p.type}`).join(", ");
            out += `- **${fn.name}**(${params})${fn.returns ? `: ${fn.returns}` : ""}\n`;
        }
        for (const prop of lib.properties || []) {
            out += `- **${prop.name}**: ${prop.type}\n`;
        }
        for (const enumObj of lib.enums || []) {
            out += `- **${enumObj.name}**${enumObj.description ? ` \u2014 ${enumObj.description}` : ""}\n`;
        }
        return out;
    }
    catch (e) {
        return `Error fetching Luau docs: ${e instanceof Error ? e.message : String(e)}`;
    }
}
// ─── Tools: DevForum ───────────────────────────────────────────
SERVER.registerTool("get_announcements", {
    title: "Get Announcements",
    description: "Get latest Roblox Developer Forum announcements",
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(10).describe("Number of announcements to return"),
    }),
}, async ({ limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/c/updates/announcements/36.json`);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Roblox DevForum Announcements:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_latest_posts", {
    title: "Get Latest Posts",
    description: "Get latest posts from the Roblox Developer Forum, optionally filtered by category",
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(10).describe("Number of posts to return"),
        category_id: z.number().optional().describe("Optional category ID to filter by"),
    }),
}, async ({ limit, category_id }) => {
    try {
        let url = `${DEVFORUM}/latest.json`;
        if (category_id)
            url += `?category=${category_id}`;
        const data = await fetchJSON(url);
        const sc = scoreTopic;
        const topics = sortByRelevance(data.topic_list.topics || []).slice(0, limit);
        const text = formatTopics(topics, data.users, limit);
        return ok(`Latest DevForum Posts:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("search_devforum", {
    title: "Search DevForum",
    description: "Search the Roblox Developer Forum for topics matching a query",
    inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
}, async ({ query, limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(query + " order:latest")}`);
        let topics = data.topics || [];
        if (!topics.length)
            return ok(`No results found for "${query}".`);
        topics = sortByRelevance(topics);
        const userMap = searchUserMap(data);
        const lines = topics
            .slice(0, limit)
            .map((t) => {
            const base = topicLine(t, userMap);
            const solved = t.has_accepted_answer ? " [SOLVED]" : "";
            return base + solved;
        })
            .join("\n\n");
        return ok(`Search results for "${query}":\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_thread", {
    title: "Get Thread",
    description: "Get a specific DevForum thread. Returns the first post (title + content) and reply count. Use get_post_replies to read replies.",
    inputSchema: z.object({
        thread_id: z.string().describe("Thread ID or slug"),
    }),
}, async ({ thread_id }) => {
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
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_action_required", {
    title: "Get Action Required",
    description: "Get DevForum topics marked as requiring creator action, from the Updates category",
    inputSchema: z.object({
        tag: z.string().default("action-required").describe("Tag to filter by"),
    }),
}, async ({ tag }) => {
    try {
        const searchQ = `"${tag.replace(/-/g, " ")}" in:title category:updates order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`);
        let topics = data.topics || [];
        if (!topics.length)
            return ok(`No topics found for "${tag}".`);
        topics = sortByRelevance(topics);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, 20).map((t) => topicLine(t, userMap)).join("\n\n");
        return ok(`Topics requiring action:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_engine_updates", {
    title: "Get Engine Updates",
    description: "Get the latest Roblox engine and Studio updates from the DevForum",
    inputSchema: z.object({}),
}, async () => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/c/updates/36.json`);
        const text = formatTopics(data.topic_list.topics, data.users, 15);
        return ok(`Roblox Engine & Studio Updates:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_category", {
    title: "Get Category",
    description: "Get topics from a specific DevForum category by slug and ID",
    inputSchema: z.object({
        slug: z.string().describe('Category slug (e.g. "help-and-feedback")'),
        category_id: z.number().describe("Category ID number"),
        limit: z.number().min(1).max(30).default(10).describe("Max topics to return"),
    }),
}, async ({ slug, category_id, limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/c/${encodeURIComponent(slug)}/${category_id}.json`);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Topics in "${slug}":\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_top_posts", {
    title: "Get Top Posts",
    description: "Get top DevForum posts for a given time period",
    inputSchema: z.object({
        period: z.enum(["daily", "weekly", "monthly", "yearly", "all"]).describe("Time period"),
    }),
}, async ({ period }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/top/${period}.json`);
        const text = formatTopics(data.topic_list.topics, data.users, 15);
        return ok(`Top posts (${period}):\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_post_replies", {
    title: "Get Post Replies",
    description: "Get replies for a DevForum thread at a specific page. Fetches one page only \u2014 never auto-paginates.",
    inputSchema: z.object({
        thread_id: z.string().describe("Thread ID"),
        page: z.number().min(1).default(1).describe("Page number (1-indexed)"),
    }),
}, async ({ thread_id, page }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json?page=${page}`);
        const posts = data.post_stream?.posts || [];
        if (!posts.length)
            return ok(`No posts found on page ${page}.`);
        let text = `Thread: ${data.title} \u2014 Page ${page}\n\n`;
        for (const p of posts) {
            text += `--- ${p.username} (${formatDate(p.created_at)}) ---\n`;
            text += strip(p.cooked) + "\n\n";
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_user_posts", {
    title: "Get User Posts",
    description: "Get recent activity for a DevForum user",
    inputSchema: z.object({
        username: z.string().describe("DevForum username"),
    }),
}, async ({ username }) => {
    try {
        let header = `Recent activity for ${username}:\n\n`;
        try {
            const profile = await fetchJSON(`${DEVFORUM}/u/${encodeURIComponent(username)}.json`);
            const u = profile.user;
            if (u) {
                header = `User: ${u.username} | Trust: ${u.trust_level ?? "unknown"} | Posts: ${u.post_count ?? "unknown"}\n`;
                if (u.title)
                    header += `Title: ${u.title}\n`;
                header += "\n";
            }
        }
        catch {
            // Profile may be private
        }
        const res = await fetch(`${DEVFORUM}/u/${encodeURIComponent(username)}/activity.json`, { headers: COMMON_HEADERS });
        if (!res.ok) {
            return ok(`${header}Could not fetch activity (HTTP ${res.status}). The profile may be private or the username may be incorrect.`);
        }
        const data = await res.json();
        if (Array.isArray(data)) {
            const posts = data.slice(0, 15);
            if (!posts.length)
                return ok(`${header}No recent activity.`);
            const topicIds = [...new Set(posts.map((p) => p.topic_id).filter(Boolean))].slice(0, 10);
            const titleMap = new Map();
            await Promise.all(topicIds.map(async (id) => {
                try {
                    const tData = await fetchJSON(`${DEVFORUM}/t/${id}.json`);
                    if (tData.title)
                        titleMap.set(id, tData.title);
                }
                catch {
                    // ignore
                }
            }));
            const lines = posts
                .map((p) => {
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
        if (!topics.length)
            return ok(`${header}No recent topic activity.`);
        const lines = topics.slice(0, 15).map((t) => topicLine(t)).join("\n\n");
        return ok(`${header}${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_api_docs", {
    title: "Get API Docs",
    description: "Get Roblox Creator documentation for an engine class (properties, methods, events)",
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "Workspace")'),
        include_inherited: z.boolean().optional().default(false).describe("Include key inherited members from parent classes"),
    }),
}, async ({ class_name, include_inherited }) => {
    try {
        const classes = await getApiDump();
        const cls = classes.find((c) => c.Name.toLowerCase() === class_name.toLowerCase());
        if (!cls) {
            const partials = classes
                .filter((c) => c.Name.toLowerCase().includes(class_name.toLowerCase()))
                .slice(0, 10);
            if (partials.length > 0) {
                return ok(`Class "${class_name}" not found. Did you mean:\n${partials.map((c) => `- ${c.Name}`).join("\n")}`);
            }
            return ok(`Class "${class_name}" not found in the Roblox API.`);
        }
        // Build inheritance chain
        const chain = [cls.Name];
        let current = cls;
        while (current?.Superclass && current.Superclass !== "<<<ROOT>>>") {
            chain.push(current.Superclass);
            const parent = classes.find((c) => c.Name === current.Superclass);
            if (!parent)
                break;
            current = parent;
        }
        let output = `# ${cls.Name}\n`;
        output += `Inherits: ${chain.join(" > ")}\n`;
        if (cls.Tags && cls.Tags.length > 0)
            output += `Tags: ${cls.Tags.join(", ")}\n`;
        output += `Docs: ${CREATOR_DOCS}/docs/reference/engine/classes/${cls.Name}\n\n`;
        // Collect members (own + optionally inherited)
        const allMembers = include_inherited ? [] : [...(cls.Members ?? [])];
        if (include_inherited) {
            let walk = cls;
            while (walk) {
                if (walk.Members) {
                    for (const m of walk.Members) {
                        // Avoid duplicating overridden members
                        if (!allMembers.some((existing) => existing.Name === m.Name)) {
                            allMembers.push(m);
                        }
                    }
                }
                if (!walk.Superclass || walk.Superclass === "<<<ROOT>>>")
                    break;
                walk = classes.find((c) => c.Name === walk.Superclass);
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
                const tags = p.Tags ? ` [${p.Tags.join(", ")}]` : "";
                const type = p.ValueType?.Name ?? "unknown";
                output += `- **${p.Name}**: ${type}${tags}\n`;
            }
            output += "\n";
        }
        if (methods.length > 0) {
            output += `## Methods (${methods.length})\n`;
            for (const m of methods) {
                const tags = m.Tags ? ` [${m.Tags.join(", ")}]` : "";
                const params = (m.Parameters ?? [])
                    .map((p) => `${p.Name}: ${p.Type.Name}${p.Default !== undefined ? ` = ${p.Default}` : ""}`)
                    .join(", ");
                const ret = m.ReturnType?.Name ?? "void";
                output += `- **${m.Name}**(${params}): ${ret}${tags}\n`;
            }
            output += "\n";
        }
        if (events.length > 0) {
            output += `## Events (${events.length})\n`;
            for (const e of events) {
                const tags = e.Tags ? ` [${e.Tags.join(", ")}]` : "";
                const params = (e.Parameters ?? []).map((p) => `${p.Name}: ${p.Type.Name}`).join(", ");
                output += `- **${e.Name}**(${params})${tags}\n`;
            }
            output += "\n";
        }
        if (callbacks.length > 0) {
            output += `## Callbacks (${callbacks.length})\n`;
            for (const c of callbacks) {
                const tags = c.Tags ? ` [${c.Tags.join(", ")}]` : "";
                output += `- **${c.Name}**${tags}\n`;
            }
            output += "\n";
        }
        if (include_inherited) {
            output += `\nNote: Inherited members from ${chain.slice(1).join(", ")} are included.\n`;
        }
        else if (cls.Superclass && cls.Superclass !== "<<<ROOT>>>") {
            output += `\n_Inherited from ${chain.slice(1).join(", ")} \u2014 use get_api_docs with "include_inherited" for those members._\n`;
        }
        return ok(output);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("search_creator_docs", {
    title: "Search Creator Docs",
    description: "Search community tutorials and resources from the DevForum Resources category. For official Roblox API docs, use get_api_docs instead.",
    inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().min(1).max(20).default(10).describe("Max results"),
    }),
}, async ({ query, limit }) => {
    try {
        const devforumData = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(`${query} category:resources order:latest`)}`);
        let topics = devforumData.topics || [];
        if (topics.length) {
            topics = sortByRelevance(topics);
            const userMap = searchUserMap(devforumData);
            const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join("\n\n");
            return ok(`Creator Docs search for "${query}":\n\n${lines}`);
        }
        return ok(`No results found for "${query}" in Creator Docs.`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_creator_docs", {
    title: "Get Creator Docs",
    description: "Fetch Creator Hub docs with __NEXT_DATA__ structured extraction. Use docs path like 'docs/reference/engine/classes/BasePart' or 'docs/production/publishing/publishing-experience'.",
    inputSchema: z.object({
        path: z.string().describe("Doc path (e.g. docs/reference/engine/classes/BasePart)"),
    }),
}, async ({ path }) => {
    try {
        const html = await fetchCreatorDocsHTML(path);
        const nextData = extractNextData(html);
        if (!nextData) {
            // Fallback: return stripped HTML
            const cleaned = strip(html).slice(0, 4000);
            return ok(`Creator docs page found but no structured data available:\n\n${cleaned}`);
        }
        const pageProps = nextData.props?.pageProps;
        const doc = pageProps?.doc || pageProps?.data;
        if (!doc) {
            const cleaned = strip(html).slice(0, 4000);
            return ok(`Creator docs page found but no structured doc data:\n\n${cleaned}`);
        }
        const title = doc.title || doc.name || "Untitled";
        let out = `# ${title}\n`;
        if (doc.description)
            out += `${doc.description}\n\n`;
        if (doc.body) {
            out += flattenDocBody(doc.body);
        }
        else if (doc.content) {
            out += typeof doc.content === "string" ? strip(doc.content) : flattenDocBody(doc.content);
        }
        return ok(out.trim());
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_luau_docs", {
    title: "Get Luau Docs",
    description: "Get Luau standard library reference for built-in modules: math, string, table, task, coroutine, os, utf8, bit32, debug.",
    inputSchema: z.object({
        library: z.string().describe('Library name (e.g. "math", "string", "table", "task")'),
    }),
}, async ({ library }) => {
    const out = await getLuauDoc(library);
    return ok(out);
});
SERVER.registerTool("get_categories", {
    title: "Get Categories",
    description: "List all DevForum categories with ID, slug, name, description, and topic count",
    inputSchema: z.object({}),
}, async () => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/categories.json`);
        const cats = data.category_list?.categories || [];
        let siteCats = null;
        try {
            const siteData = await fetchJSON(`${DEVFORUM}/site.json`);
            const all = siteData.categories || [];
            siteCats = new Map(all.map((c) => [c.id, c]));
        }
        catch {
            // ignore
        }
        const lines = cats
            .map((c) => {
            const desc = c.description_text ? ` \u2014 ${c.description_text.slice(0, 100)}` : "";
            let topicCount = c.topic_count;
            if (!topicCount && siteCats) {
                const subs = [...siteCats.values()].filter((s) => s.parent_category_id === c.id);
                topicCount = subs.reduce((sum, s) => sum + (s.topic_count || 0), 0);
            }
            return `\u2022 ${c.name} (ID: ${c.id}, slug: ${c.slug})${desc}\n  Topics: ${topicCount || 0}`;
        })
            .join("\n\n");
        return ok(`DevForum Categories:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_tags", {
    title: "Get Tags",
    description: "List all available DevForum tags with topic counts",
    inputSchema: z.object({}),
}, async () => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/tags.json`);
        const tags = data.tags || [];
        const sorted = tags
            .sort((a, b) => (b.count || 0) - (a.count || 0))
            .slice(0, 100);
        const lines = sorted.map((t) => `\u2022 ${t.name} (${t.count} topics)`).join("\n");
        return ok(`DevForum Tags (top 100 by topic count):\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_category_metadata", {
    title: "Get Category Metadata",
    description: "Get metadata for a specific DevForum category (name, description, subcategories, moderators, topic count). Returns metadata only, not topics.",
    inputSchema: z.object({
        category_id: z.number().describe("Category ID number"),
    }),
}, async ({ category_id }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/c/${category_id}/show.json`);
        const raw = data.category;
        let topicCount = raw.topic_count;
        let postCount = raw.post_count;
        let subs = data.subcategory_list?.categories || [];
        // Fallback: /site.json for parent categories
        if (!topicCount || (!subs.length && raw.subcategory_ids?.length)) {
            try {
                const siteData = await fetchJSON(`${DEVFORUM}/site.json`);
                const allCats = siteData.categories || [];
                if (!subs.length) {
                    subs = allCats.filter((c) => c.parent_category_id === category_id);
                }
                if (!topicCount && subs.length) {
                    topicCount = subs.reduce((sum, s) => sum + (s.topic_count || 0), 0);
                    postCount = subs.reduce((sum, s) => sum + (s.post_count || 0), 0);
                }
            }
            catch {
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
                .map((s) => `${s.name} (ID: ${s.id}, ${s.topic_count} topics)`)
                .join(", ")}\n`;
        }
        if (raw.moderators?.length) {
            text += `Moderators: ${raw.moderators
                .map((m) => m.username)
                .join(", ")}\n`;
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("search_bugs", {
    title: "Search Bugs",
    description: "Search for bug reports on the DevForum. One category at a time \u2014 Discourse does not support multiple category filters.",
    inputSchema: z.object({
        query: z.string().describe("Search query"),
        category: z
            .enum(["studio-bugs", "engine-bugs"])
            .default("studio-bugs")
            .describe("Bug category"),
        limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
}, async ({ query, category, limit }) => {
    try {
        const q = `${query} category:${category} order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        let topics = data.topics || [];
        if (!topics.length)
            return ok(`No bug reports found for "${query}" in ${category}.`);
        topics = sortByRelevance(topics);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join("\n\n");
        return ok(`Bug reports for "${query}" in ${category}:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_solved_topics", {
    title: "Get Solved Topics",
    description: "Search for solved DevForum topics. PREFERRED tool for debugging \u2014 use this before get_thread or get_post_replies.",
    inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().min(1).max(30).default(10).describe("Max results"),
    }),
}, async ({ query, limit }) => {
    try {
        const q = `${query} status:solved order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        let topics = data.topics || [];
        if (!topics.length)
            return ok(`No solved topics found for "${query}".`);
        topics = sortByRelevance(topics);
        const userMap = searchUserMap(data);
        const lines = topics
            .slice(0, limit)
            .map((t) => {
            const base = topicLine(t, userMap);
            const accepted = t.has_accepted_answer ? " \u2705 Has accepted answer" : "";
            return base + accepted;
        })
            .join("\n\n");
        return ok(`Solved topics for "${query}":\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_new_posts", {
    title: "Get New Posts",
    description: "Get the newest topics on the DevForum. Falls back to latest if new topics endpoint requires authentication.",
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(15).describe("Max topics to return"),
    }),
}, async ({ limit }) => {
    try {
        const data = await fetchJSONWithFallback([
            `${DEVFORUM}/new.json`,
            `${DEVFORUM}/latest.json?order=created`,
        ]);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Newest DevForum topics:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
// ─── Tools: API Reference ───────────────────────────────────────
SERVER.registerTool("search_api_member", {
    title: "Search API Member",
    description: "Search for a property, method, event, or callback by name across ALL Roblox API classes. Useful to find where a member exists or what classes implement a specific interface.",
    inputSchema: z.object({
        query: z.string().describe("Member name to search for (e.g. Touched, Position, Destroy)"),
        member_type: z
            .enum(["Property", "Function", "Event", "Callback"])
            .optional()
            .describe("Filter by member type"),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
    }),
}, async ({ query, member_type, limit }) => {
    try {
        const classes = await getApiDump();
        const results = [];
        const q = query.toLowerCase();
        for (const cls of classes) {
            for (const m of cls.Members ?? []) {
                if (!m.Name.toLowerCase().includes(q))
                    continue;
                if (member_type && m.MemberType !== member_type)
                    continue;
                results.push({ className: cls.Name, member: m });
            }
        }
        if (!results.length) {
            return ok(`No API member found matching "${query}"${member_type ? ` of type ${member_type}` : ""}.`);
        }
        const lines = results
            .slice(0, limit)
            .map((r) => `\u2022 ${r.member.Name} (${r.member.MemberType}) in ${r.className}`)
            .join("\n");
        return ok(`Results for "${query}"${member_type ? ` [type: ${member_type}]` : ""}:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_class_hierarchy", {
    title: "Get Class Hierarchy",
    description: "Get the full inheritance tree for a Roblox class, showing all parent classes and direct subclasses.",
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "RemoteEvent")'),
    }),
}, async ({ class_name }) => {
    try {
        const classes = await getApiDump();
        const cls = classes.find((c) => c.Name.toLowerCase() === class_name.toLowerCase());
        if (!cls)
            return ok(`Class "${class_name}" not found.`);
        // Parents
        const chain = [cls.Name];
        let curr = cls;
        while (curr?.Superclass && curr.Superclass !== "<<<ROOT>>>") {
            chain.push(curr.Superclass);
            curr = classes.find((c) => c.Name === curr.Superclass);
        }
        // Subclasses (direct children)
        const children = classes
            .filter((c) => c.Superclass?.toLowerCase() === cls.Name.toLowerCase())
            .map((c) => c.Name)
            .sort();
        let out = `# ${cls.Name} Hierarchy\n\n`;
        out += `Chain: ${chain.join(" > ")}\n`;
        if (children.length) {
            out += `Direct subclasses: ${children.join(", ")}\n`;
        }
        else {
            out += `Direct subclasses: none\n`;
        }
        // Total descendants
        const totalDescendants = classes.filter((c) => c.Superclass &&
            chain.some((ancestor) => ancestor.toLowerCase() === c.Superclass.toLowerCase())).length;
        out += `Total inheriting classes: ${totalDescendants}\n`;
        return ok(out);
    }
    catch (e) {
        return err(e);
    }
});
SERVER.registerTool("get_enum", {
    title: "Get Enum",
    description: "List or inspect Roblox API enums. If name is provided, returns all values for that enum. If omitted, returns list of all enums.",
    inputSchema: z.object({
        name: z.string().optional().describe('Enum name (e.g. "Material", "PartType")'),
        filter: z.string().optional().describe("Filter enum names when listing"),
    }),
}, async ({ name, filter }) => {
    try {
        const data = await getApiDump();
        // Collect all unique enum names from ValueType references
        const enumSet = new Set();
        for (const cls of data) {
            for (const m of cls.Members ?? []) {
                if (m.ValueType?.Category === "Enum")
                    enumSet.add(m.ValueType.Name);
            }
        }
        const enums = [...enumSet].sort();
        if (name) {
            const match = enums.find((e) => e.toLowerCase() === name.toLowerCase());
            if (!match)
                return ok(`Enum "${name}" not found.`);
            // We don't have enum values in Full-API-Dump.json, just list existence
            return ok(`Enum “${match}” exists in the Roblox API.\nIt is referenced as a ValueType on various classes.\nFor full values, see the Creator Docs enum page.`);
        }
        let list = enums;
        if (filter) {
            const f = filter.toLowerCase();
            list = list.filter((e) => e.toLowerCase().includes(f));
        }
        return ok(`Roblox API Enums (${list.length} total):\n\n${list.slice(0, 100).join(", ")}`);
    }
    catch (e) {
        return err(e);
    }
});
// ─── Tools: Community Resources ─────────────────────────────────
SERVER.registerTool("search_community_resources", {
    title: "Search Community Resources",
    description: "Search community tutorials and resources from the DevForum Resources and Tutorials categories.",
    inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().min(1).max(20).default(10).describe("Max results"),
    }),
}, async ({ query, limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(`${query} category:resources category:tutorials order:latest`)}`);
        let topics = data.topics || [];
        if (!topics.length)
            return ok(`No community resources found for "${query}".`);
        topics = sortByRelevance(topics);
        const userMap = searchUserMap(data);
        const lines = topics
            .slice(0, limit)
            .map((t) => topicLine(t, userMap))
            .join("\n\n");
        return ok(`Community resources for "${query}":\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
// ─── Tools: Platform ────────────────────────────────────────────
SERVER.registerTool("get_roblox_status", {
    title: "Get Roblox Status",
    description: "Check the current status of Roblox platform services (website, Studio, API, game servers, etc.)",
    inputSchema: z.object({}),
}, async () => {
    try {
        const data = await getRobloxStatusData();
        const components = data.components || [];
        const statuses = new Map();
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
        return ok(out.trim());
    }
    catch (e) {
        return err(e);
    }
});
// ─── Main ───────────────────────────────────────────────────────
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await SERVER.connect(transport);
}
main().catch(() => {
    process.exit(1);
});
