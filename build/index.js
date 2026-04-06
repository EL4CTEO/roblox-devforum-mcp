#!/usr/bin/env node
"use strict";
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
const z = __importStar(require("zod/v4"));
const DEVFORUM = 'https://devforum.roblox.com';
const CREATOR_DOCS = 'https://create.roblox.com';
const VERSION = '3.0.0';
const server = new mcp_js_1.McpServer({ name: 'roblox-devforum-mcp', version: VERSION });
const ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const COMMON_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': `roblox-devforum-mcp/${VERSION}`
};
const REQUEST_TIMEOUT = 15000;
const CACHE_MAX = 200;
const CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const inflight = new Map();
async function fetchWithTimeout(url, opts = {}, retry = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
        const res = await fetch(url, { ...opts, signal: controller.signal });
        clearTimeout(timer);
        if (retry && (res.status === 502 || res.status === 503 || res.status === 520)) {
            await new Promise(r => setTimeout(r, 500));
            return fetchWithTimeout(url, opts, false);
        }
        return res;
    }
    catch (e) {
        clearTimeout(timer);
        if (retry && e instanceof Error && (e.name === 'AbortError' || e.message.includes('network'))) {
            try { return await fetchWithTimeout(url, opts, false); } catch { }
        }
        throw e;
    }
}
async function cachedFetchJSON(url, ttl = CACHE_TTL) {
    const cached = CACHE.get(url);
    if (cached && (Date.now() - cached.time) < ttl)
        return cached.data;
    if (inflight.has(url))
        return inflight.get(url);
    const promise = (async () => {
        const res = await fetchWithTimeout(url, { headers: COMMON_HEADERS });
        if (res.status === 429)
            throw new Error('Rate limited by server. Please wait and try again.');
        if (res.status === 404)
            throw new Error(`Not found: ${url}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        if (CACHE.size >= CACHE_MAX) {
            const oldest = [...CACHE.entries()].sort((a, b) => a[1].time - b[1].time)[0];
            if (oldest)
                CACHE.delete(oldest[0]);
        }
        CACHE.set(url, { data, time: Date.now() });
        return data;
    })();
    inflight.set(url, promise);
    try {
        return await promise;
    }
    finally {
        inflight.delete(url);
    }
}
async function fetchJSON(url) {
    return cachedFetchJSON(url);
}
async function fetchJSONWithFallback(urls) {
    for (const url of urls) {
        try {
            const res = await fetchWithTimeout(url, { headers: COMMON_HEADERS });
            if (res.status === 429)
                throw new Error('Rate limited by server. Please wait and try again.');
            if (res.ok)
                return await res.json();
        }
        catch (e) {
            if (e instanceof Error && e.message.startsWith('Rate limited'))
                throw e;
        }
    }
    throw new Error(`All endpoints failed: ${urls.join(', ')}`);
}
async function fetchHTML(url) {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': `roblox-devforum-mcp/${VERSION}` } });
    if (res.status === 429)
        throw new Error('Rate limited by server. Please wait and try again.');
    if (res.status === 404)
        throw new Error(`Not found: ${url}`);
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
}
function strip(html) {
    if (!html) return '';
    let result = html;
    const codeBlocks = [];
    result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
        const idx = codeBlocks.length;
        let code = content.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '');
        code = code.replace(/<[^>]+>/g, '');
        code = code.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        codeBlocks.push(code.trim());
        return `\n__CODEBLOCK_${idx}__\n`;
    });
    result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
        const idx = codeBlocks.length;
        let code = content.replace(/<[^>]+>/g, '');
        code = code.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        codeBlocks.push(code.trim());
        return `\`__CODEBLOCK_${idx}__\``;
    });
    result = result
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    for (let i = 0; i < codeBlocks.length; i++) {
        const block = codeBlocks[i];
        const marker = `__CODEBLOCK_${i}__`;
        if (result.includes('`' + marker + '`')) {
            result = result.replace('`' + marker + '`', '`' + block + '`');
        } else {
            result = result.replace(marker, '```\n' + block + '\n```');
        }
    }
    return result;
}
function formatDate(d) {
    return new Date(d).toISOString().split('T')[0];
}
function topicLine(t, users) {
    const date = t.created_at ? formatDate(t.created_at) : 'unknown';
    const title = t.title || t.fancy_title || 'Untitled';
    const url = `${DEVFORUM}/t/${t.slug || t.id}/${t.id}`;
    const views = t.views != null ? t.views : 'N/A';
    const replies = t.posts_count ? t.posts_count - 1 : (t.reply_count ?? 0);
    let author = '';
    if (users && t.posters?.length) {
        const poster = t.posters[0];
        author = users.get(poster.user_id) || '';
    }
    if (!author) {
        author = t.last_poster_username || '';
    }
    return `\u2022 ${title}\n  Author: ${author || 'unknown'} | Date: ${date} | Replies: ${replies} | Views: ${views}\n  ${url}`;
}
function formatTopics(topics, users, limit) {
    const userMap = new Map();
    if (users)
        for (const u of users)
            userMap.set(u.id, u.username);
    return topics.slice(0, limit).map(t => {
        if (!t.last_poster_username && t.posters?.length) {
            const poster = t.posters[0];
            t.last_poster_username = userMap.get(poster.user_id) || 'unknown';
        }
        return topicLine(t, userMap);
    }).join('\n\n');
}
function buildUserMap(users) {
    const userMap = new Map();
    if (users)
        for (const u of users)
            userMap.set(u.id, u.username);
    return userMap;
}
function searchUserMap(data) {
    const map = buildUserMap(data.users);
    if (data.posts && !map.size) {
        for (const p of data.posts) {
            if (p.topic_id && p.username && !map.has(p.topic_id))
                map.set(p.topic_id, p.username);
        }
    }
    return map;
}
function ok(text) {
    return { content: [{ type: 'text', text }] };
}
function err(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}
let apiDumpFullCache = null;
let apiDumpCacheTime = 0;
let classIndex = null;
const API_DUMP_TTL = 6 * 60 * 60 * 1000;
async function getApiDumpFull() {
    const now = Date.now();
    if (apiDumpFullCache && (now - apiDumpCacheTime) < API_DUMP_TTL)
        return apiDumpFullCache;
    try {
        const data = await fetchJSON('https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json');
        apiDumpFullCache = data;
        apiDumpCacheTime = now;
        classIndex = new Map();
        for (const cls of data.Classes || []) {
            classIndex.set(cls.Name.toLowerCase(), cls);
        }
        return apiDumpFullCache;
    }
    catch (e) {
        if (apiDumpFullCache)
            return apiDumpFullCache;
        throw e;
    }
}
async function getApiDump() {
    await getApiDumpFull();
    return apiDumpFullCache.Classes;
}
function findClass(name) {
    return classIndex?.get(name.toLowerCase()) || null;
}
// ─── Tools ─────────────────────────────────────────────────────────
server.registerTool('get_announcements', {
    annotations: ANNOTATIONS,
    title: 'Get Announcements',
    description: 'Get latest Roblox Developer Forum announcements',
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(10).describe('Number of announcements to return')
    })
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
server.registerTool('get_latest_posts', {
    annotations: ANNOTATIONS,
    title: 'Get Latest Posts',
    description: 'Get latest posts from the Roblox Developer Forum (popular/curated mix), optionally filtered by category. For strictly chronological newest posts, use get_new_posts instead.',
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(10).describe('Number of posts to return'),
        category_id: z.number().optional().describe('Optional category ID to filter by')
    })
}, async ({ limit, category_id }) => {
    try {
        let url = `${DEVFORUM}/latest.json`;
        if (category_id)
            url += `?category=${category_id}`;
        const data = await fetchJSON(url);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Latest DevForum Posts:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_devforum', {
    annotations: ANNOTATIONS,
    title: 'Search DevForum',
    description: 'Search the Roblox Developer Forum for topics matching a query. Optionally filter by category slug for scoped results.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        category: z.string().optional().describe('Optional category to scope search (e.g. "scripting-support", "help-and-feedback", "resources")'),
        limit: z.number().min(1).max(30).default(10).describe('Max results')
    })
}, async ({ query, category, limit }) => {
    try {
        let searchQ = query + ' order:latest';
        if (category)
            searchQ += ` category:${category}`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No results found for "${query}"${category ? ` in ${category}` : ''}.`);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, limit).map((t) => {
            const base = topicLine(t, userMap);
            const solved = t.has_accepted_answer ? ' [SOLVED]' : '';
            return base + solved;
        }).join('\n\n');
        return ok(`Search results for "${query}"${category ? ` in ${category}` : ''}:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_thread', {
    annotations: ANNOTATIONS,
    title: 'Get Thread',
    description: 'Get a specific DevForum thread. Returns the first post (title + content), reply count, accepted answer info, and if solved, the accepted answer content. Use get_post_replies to read full replies.',
    inputSchema: z.object({
        thread_id: z.string().describe('Thread ID or slug'),
        max_length: z.number().min(500).max(10000).default(5000).describe('Max characters for first post content (truncated if longer)')
    })
}, async ({ thread_id, max_length }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json`);
        const firstPost = data.post_stream?.posts?.[0];
        const acceptedAnswer = data.accepted_answer;
        const solved = !!acceptedAnswer || data.has_accepted_answer || (data.tags || []).includes('solved') || (data.title || '').includes('[SOLVED]');
        const acceptedPostId = acceptedAnswer?.post_number || null;
        const acceptedUser = acceptedAnswer?.username || null;
        let text = `Title: ${data.title}\n`;
        text += `Author: ${firstPost?.username || 'unknown'} | Date: ${formatDate(data.created_at)}\n`;
        text += `Tags: ${(data.tags || []).join(', ') || 'none'}\n`;
        text += `Replies: ${data.posts_count - 1} | Views: ${data.views}\n`;
        text += `Solved: ${solved ? 'Yes' : 'No'}\n`;
        if (acceptedPostId) {
            text += `Accepted Answer: Post #${acceptedPostId} by ${acceptedUser || 'unknown'}\n`;
        }
        text += `URL: ${DEVFORUM}/t/${data.slug}/${data.id}\n\n`;
        if (firstPost) {
            text += `--- First Post by ${firstPost.username} (${formatDate(firstPost.created_at)}) ---\n`;
            let content = strip(firstPost.cooked);
            if (content.length > max_length) {
                content = content.slice(0, max_length) + '...';
            }
            text += content;
        }
        if (acceptedAnswer && acceptedPostId) {
            text += `\n\n--- Accepted Answer by ${acceptedUser || 'unknown'} (Post #${acceptedPostId}) ---\n`;
            try {
                const postData = await fetchJSON(`${DEVFORUM}/t/${thread_id}/${acceptedPostId}.json`);
                const acceptedPost = postData.post_stream?.posts?.[0];
                if (acceptedPost) {
                    let acceptedContent = strip(acceptedPost.cooked);
                    if (acceptedContent.length > 3000) {
                        acceptedContent = acceptedContent.slice(0, 3000) + '...';
                    }
                    text += acceptedContent;
                }
            } catch {
                if (acceptedAnswer.excerpt) {
                    let excerpt = acceptedAnswer.excerpt;
                    if (excerpt.length > 1500) {
                        excerpt = excerpt.slice(0, 1500) + '...';
                    }
                    text += excerpt;
                }
            }
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_action_required', {
    annotations: ANNOTATIONS,
    title: 'Get Action Required',
    description: 'Get DevForum topics marked as requiring creator action, from the Updates category',
    inputSchema: z.object({
        tag: z.string().default('action-required').describe('Tag to filter by')
    })
}, async ({ tag }) => {
    try {
        const searchQ = `"${tag.replace(/-/g, ' ')}" in:title category:updates order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No topics found for "${tag}".`);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, 20).map((t) => topicLine(t, userMap)).join('\n\n');
        return ok(`Topics requiring action:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_engine_updates', {
    annotations: ANNOTATIONS,
    title: 'Get Engine Updates',
    description: 'Get the latest Roblox engine and Studio release notes, changelogs, and technical updates. Returns topics tagged with release notes from the Updates category. Covers engine changes, API additions/removals, deprecations, and new features. Use get_announcements for general announcements.',
    inputSchema: z.object({
        limit: z.number().min(1).max(20).default(10).describe('Number of updates to return')
    })
}, async ({ limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent('category:updates tag:weekly-recap order:latest')}`);
        const topics = data.topics || [];
        if (topics.length) {
            const userMap = searchUserMap(data);
            const lines = topics.slice(0, limit).map(t => topicLine(t, userMap)).join('\n\n');
            return ok(`Engine Release Notes:\n\n${lines}`);
        }
        const fallback = await fetchJSON(`${DEVFORUM}/c/updates/36.json`);
        const text = formatTopics(fallback.topic_list.topics, fallback.users, limit);
        return ok(`Roblox Updates (general):\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_category', {
    annotations: ANNOTATIONS,
    title: 'Get Category',
    description: 'Get topics from a specific DevForum category by slug and ID. For subcategories, include parent_slug (e.g. scripting-support under help-and-feedback).',
    inputSchema: z.object({
        slug: z.string().describe('Category slug (e.g. "help-and-feedback", "scripting-support")'),
        category_id: z.number().describe('Category ID number'),
        limit: z.number().min(1).max(30).default(10).describe('Max topics to return'),
        parent_slug: z.string().optional().describe('Parent category slug for subcategories (e.g. "help-and-feedback" for scripting-support)')
    })
}, async ({ slug, category_id, limit, parent_slug }) => {
    try {
        const urls = parent_slug
            ? [
                `${DEVFORUM}/c/${encodeURIComponent(parent_slug)}/${encodeURIComponent(slug)}/${category_id}.json`,
                `${DEVFORUM}/c/${encodeURIComponent(slug)}/${category_id}.json`
            ]
            : [`${DEVFORUM}/c/${encodeURIComponent(slug)}/${category_id}.json`];
        const data = await fetchJSONWithFallback(urls);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Topics in "${slug}":\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_top_posts', {
    annotations: ANNOTATIONS,
    title: 'Get Top Posts',
    description: 'Get top DevForum posts for a given time period',
    inputSchema: z.object({
        period: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'all']).describe('Time period'),
        limit: z.number().min(1).max(15).default(15).describe('Max results')
    })
}, async ({ period, limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/top/${period}.json`);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Top posts (${period}):\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_post_replies', {
    annotations: ANNOTATIONS,
    title: 'Get Post Replies',
    description: 'Get replies for a DevForum thread at a specific page. Fetches one page only — never auto-paginates. Use page parameter to navigate through long threads.',
    inputSchema: z.object({
        thread_id: z.string().describe('Thread ID'),
        page: z.number().min(1).default(1).describe('Page number (1-indexed)'),
        include_op: z.boolean().default(false).describe('Include the original post (post #1) in the output'),
        max_length: z.number().min(100).max(5000).default(2000).describe('Max characters per post (truncated if longer)')
    })
}, async ({ thread_id, page, include_op, max_length }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json?page=${page}`);
        let posts = data.post_stream?.posts || [];
        if (!posts.length)
            return ok(`No posts found on page ${page}.`);
        const totalPosts = data.posts_count || posts.length;
        const totalPages = Math.ceil(totalPosts / posts.length) || 1;
        if (!include_op) {
            posts = posts.filter(p => p.post_number > 1);
        }
        let text = `Thread: ${data.title} — Page ${page} of ~${totalPages}\n\n`;
        for (const p of posts) {
            const likes = p.actions_summary?.find((a) => a.id === 2)?.count || 0;
            const meta = [`Post #${p.post_number}`];
            if (likes > 0)
                meta.push(`${likes} like${likes > 1 ? 's' : ''}`);
            if (p.wiki)
                meta.push('wiki');
            text += `--- ${p.username} (${formatDate(p.created_at)}) [${meta.join(', ')}] ---\n`;
            let content = strip(p.cooked);
            if (content.length > max_length) {
                content = content.slice(0, max_length) + '...';
            }
            text += content + '\n\n';
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_user_posts', {
    annotations: ANNOTATIONS,
    title: 'Get User Posts',
    description: 'Get recent activity for a DevForum user',
    inputSchema: z.object({
        username: z.string().describe('DevForum username')
    })
}, async ({ username }) => {
    try {
        let header = `Recent activity for ${username}:\n\n`;
        try {
            const profile = await fetchJSON(`${DEVFORUM}/u/${encodeURIComponent(username)}.json`);
            const u = profile.user;
            if (u) {
                header = `User: ${u.username} | Trust: ${u.trust_level ?? 'unknown'} | Posts: ${u.post_count ?? 'unknown'}\n`;
                if (u.title)
                    header += `Title: ${u.title}\n`;
                header += '\n';
            }
        }
        catch { }
        const res = await fetchWithTimeout(`${DEVFORUM}/u/${encodeURIComponent(username)}/activity.json`, { headers: COMMON_HEADERS });
        if (!res.ok) {
            return ok(`${header}Could not fetch activity (HTTP ${res.status}). The profile may be private or the username may be incorrect.`);
        }
        const data = await res.json();
        if (Array.isArray(data)) {
            const posts = data.slice(0, 15);
            if (!posts.length)
                return ok(`${header}No recent activity.`);
            const titleMap = new Map();
            for (const p of posts) {
                if (p.topic_id && (p.fancy_title || p.raw || p.blurb)) {
                    titleMap.set(p.topic_id, p.fancy_title || p.raw || p.blurb);
                }
            }
            const missingIds = [...new Set(posts.map((p) => p.topic_id).filter((id) => id && !titleMap.has(id)))].slice(0, 5);
            await Promise.all(missingIds.map(async (id) => {
                try {
                    const tData = await fetchJSON(`${DEVFORUM}/t/${id}.json`);
                    if (tData.title)
                        titleMap.set(id, tData.title);
                }
                catch { }
            }));
            const lines = posts.map((p) => {
                const excerpt = strip(p.excerpt || p.cooked || '').slice(0, 150);
                const topicTitle = titleMap.get(p.topic_id) || `Topic #${p.topic_id}`;
                const topicSlug = p.slug || p.topic_id;
                const topicUrl = `${DEVFORUM}/t/${topicSlug}/${p.topic_id}`;
                return `\u2022 ${topicTitle}\n  Author: ${p.username || 'unknown'} | Date: ${formatDate(p.created_at)}\n  ${topicUrl}\n  ${excerpt}`;
            }).join('\n\n');
            return ok(`${header}${lines}`);
        }
        const topics = data.topic_list?.topics || [];
        if (!topics.length)
            return ok(`${header}No recent topic activity.`);
        const lines = topics.slice(0, 15).map((t) => topicLine(t)).join('\n\n');
        return ok(`${header}${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_api_docs', {
    annotations: ANNOTATIONS,
    title: 'Get API Docs',
    description: 'Get Roblox Creator documentation for an engine class (properties, methods, events, callbacks, inheritance). This is the go-to for any API reference question. Do NOT use search_creator_docs for class reference.',
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "Workspace")'),
        include_inherited: z.boolean().default(false).describe('Include key inherited members from parent classes')
    })
}, async ({ class_name, include_inherited }) => {
    try {
        const classes = await getApiDump();
        const cls = findClass(class_name);
        if (!cls) {
            const partials = classes
                .filter(c => c.Name.toLowerCase().includes(class_name.toLowerCase()))
                .slice(0, 10);
            if (partials.length > 0) {
                return ok(`Class "${class_name}" not found. Did you mean:\n${partials.map(c => `- ${c.Name}`).join('\n')}`);
            }
            return ok(`Class "${class_name}" not found in the Roblox API.`);
        }
        const chain = [cls.Name];
        let current = cls;
        while (current.Superclass && current.Superclass !== '<<<ROOT>>>') {
            chain.push(current.Superclass);
            const parent = classes.find(c => c.Name === current.Superclass);
            if (!parent)
                break;
            current = parent;
        }
        let output = `# ${cls.Name}\n`;
        output += `Inherits: ${chain.join(' > ')}\n`;
        if (cls.Tags && cls.Tags.length > 0)
            output += `Tags: ${cls.Tags.join(', ')}\n`;
        output += `Docs: ${CREATOR_DOCS}/docs/reference/engine/classes/${cls.Name}\n\n`;
        const members = cls.Members ?? [];
        const properties = members.filter(m => m.MemberType === 'Property');
        const methods = members.filter(m => m.MemberType === 'Function');
        const events = members.filter(m => m.MemberType === 'Event');
        const callbacks = members.filter(m => m.MemberType === 'Callback');
        if (properties.length > 0) {
            output += `## Properties (${properties.length})\n`;
            for (const p of properties) {
                const tags = p.Tags ? ` [${p.Tags.join(', ')}]` : '';
                const type = p.ValueType?.Name ?? 'unknown';
                output += `- **${p.Name}**: ${type}${tags}\n`;
            }
            output += '\n';
        }
        if (methods.length > 0) {
            output += `## Methods (${methods.length})\n`;
            for (const m of methods) {
                const tags = m.Tags ? ` [${m.Tags.join(', ')}]` : '';
                const params = (m.Parameters ?? [])
                    .map(p => `${p.Name}: ${p.Type.Name}${p.Default !== undefined ? ` = ${p.Default}` : ''}`)
                    .join(', ');
                const ret = m.ReturnType?.Name ?? 'void';
                output += `- **${m.Name}**(${params}): ${ret}${tags}\n`;
            }
            output += '\n';
        }
        if (events.length > 0) {
            output += `## Events (${events.length})\n`;
            for (const e of events) {
                const tags = e.Tags ? ` [${e.Tags.join(', ')}]` : '';
                const params = (e.Parameters ?? [])
                    .map(p => `${p.Name}: ${p.Type.Name}`)
                    .join(', ');
                output += `- **${e.Name}**(${params})${tags}\n`;
            }
            output += '\n';
        }
        if (callbacks.length > 0) {
            output += `## Callbacks (${callbacks.length})\n`;
            for (const c of callbacks) {
                const tags = c.Tags ? ` [${c.Tags.join(', ')}]` : '';
                output += `- **${c.Name}**${tags}\n`;
            }
            output += '\n';
        }
        if (cls.Superclass && cls.Superclass !== '<<<ROOT>>>') {
            if (include_inherited) {
                const IMPORTANT_TAGS = ['Deprecated', 'NotBrowsable', 'Hidden'];
                const inheritedMembers = [];
                for (const parentName of chain.slice(1)) {
                    const parentCls = classes.find(c => c.Name === parentName);
                    if (!parentCls)
                        continue;
                    const parentMembers = (parentCls.Members || []).filter(m => {
                        if (m.Tags && m.Tags.some(t => IMPORTANT_TAGS.includes(t)))
                            return false;
                        return true;
                    });
                    for (const m of parentMembers) {
                        inheritedMembers.push({ class: parentName, member: m });
                    }
                }
                if (inheritedMembers.length > 0) {
                    const shown = inheritedMembers.slice(0, 80);
                    output += `\n## Inherited Members (showing ${shown.length} of ${inheritedMembers.length})\n`;
                    for (const im of shown) {
                        const m = im.member;
                        const tags = m.Tags ? ` [${m.Tags.join(', ')}]` : '';
                        if (m.MemberType === 'Property') {
                            output += `- ${im.class}.${m.Name}: ${m.ValueType?.Name || 'unknown'}${tags}\n`;
                        }
                        else if (m.MemberType === 'Function') {
                            const params = (m.Parameters || []).map(p => `${p.Name}: ${p.Type.Name}`).join(', ');
                            output += `- ${im.class}.${m.Name}(${params}): ${m.ReturnType?.Name || 'void'}${tags}\n`;
                        }
                        else if (m.MemberType === 'Event') {
                            const params = (m.Parameters || []).map(p => `${p.Name}: ${p.Type.Name}`).join(', ');
                            output += `- ${im.class}.${m.Name}(${params})${tags}\n`;
                        }
                    }
                    if (inheritedMembers.length > 80) {
                        output += `\n_...and ${inheritedMembers.length - 80} more inherited members._\n`;
                    }
                }
            }
            else {
                output += `\n_Inherited from ${chain.slice(1).join(', ')} \u2014 use get_api_docs with the parent class name, or set include_inherited=true for those members._\n`;
            }
        }
        return ok(output);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_community_resources', {
    annotations: ANNOTATIONS,
    title: 'Search Community Resources',
    description: 'Search community tutorials and resources from the DevForum Resources and Tutorials categories. NOT the official Creator Hub (create.roblox.com). For official API reference, use get_api_docs instead.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(20).default(10).describe('Max results')
    })
}, async ({ query, limit }) => {
    try {
        const searchQ = `${query} category:resources order:latest`;
        const devforumData = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`);
        const topics = devforumData.topics || [];
        let results = '';
        if (topics.length) {
            const userMap = searchUserMap(devforumData);
            const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
            results += `DevForum Resources for "${query}":\n\n${lines}`;
        }
        if (!results) {
            const fallbackQ = `${query} category:tutorials order:latest`;
            try {
                const fallbackData = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(fallbackQ)}`);
                const fallbackTopics = fallbackData.topics || [];
                if (fallbackTopics.length) {
                    const userMap = searchUserMap(fallbackData);
                    const lines = fallbackTopics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
                    results += `DevForum Tutorials for "${query}":\n\n${lines}`;
                }
            }
            catch { }
        }
        if (!results) {
            results = `No results found for "${query}" in Creator Docs or tutorials.`;
        }
        return ok(results);
    }
    catch (e) {
        return err(e);
    }
});
const LUAU_STDLIB = {
    math: {
        desc: 'Mathematical functions (all angles in radians)',
        funcs: [
            { name: 'math.abs(x)', desc: 'Absolute value' },
            { name: 'math.ceil(x)', desc: 'Round up to integer' },
            { name: 'math.clamp(x, min, max)', desc: 'Clamp x between min and max' },
            { name: 'math.floor(x)', desc: 'Round down to integer' },
            { name: 'math.lerp(a, b, t)', desc: 'Linear interpolation between a and b by t (0-1)' },
            { name: 'math.max(x, ...)', desc: 'Maximum of all arguments' },
            { name: 'math.min(x, ...)', desc: 'Minimum of all arguments' },
            { name: 'math.random([min,] max)', desc: 'Random integer in [min, max] or [1, max] or [0, 1)' },
            { name: 'math.round(x)', desc: 'Round to nearest integer (ties away from zero)' },
            { name: 'math.sign(x)', desc: '-1, 0, or 1' },
            { name: 'math.sqrt(x)', desc: 'Square root' },
            { name: 'math.noise(x [, y [, z]])', desc: 'Perlin noise value' },
            { name: 'math.sin(x)', desc: 'Sine' },
            { name: 'math.cos(x)', desc: 'Cosine' },
            { name: 'math.tan(x)', desc: 'Tangent' },
            { name: 'math.asin(x)', desc: 'Arc sine' },
            { name: 'math.acos(x)', desc: 'Arc cosine' },
            { name: 'math.atan2(y, x)', desc: 'Arc tangent of y/x' },
            { name: 'math.atan(x)', desc: 'Arc tangent' },
            { name: 'math.log(x [, base])', desc: 'Logarithm' },
            { name: 'math.exp(x)', desc: 'e^x' },
            { name: 'math.pi', desc: '3.14159...' },
            { name: 'math.huge', desc: 'Infinity' },
            { name: 'math.rad(deg)', desc: 'Degrees to radians' },
            { name: 'math.deg(rad)', desc: 'Radians to degrees' },
            { name: 'math.type(x)', desc: '"integer", "float", or nil' },
            { name: 'math.tointeger(x)', desc: 'Convert to integer or nil' }
        ]
    },
    string: {
        desc: 'String manipulation functions',
        funcs: [
            { name: 'string.byte(s [, i [, j]])', desc: 'Return byte values of characters' },
            { name: 'string.char(...)', desc: 'Build string from byte values' },
            { name: 'string.find(s, pattern [, init [, plain]])', desc: 'Find pattern in string, returns start, end, captures' },
            { name: 'string.format(s, ...)', desc: 'Printf-style formatting (%s, %d, %f, %x, %o, %e, %g, %q, %i, %u)' },
            { name: 'string.gmatch(s, pattern)', desc: 'Iterator over all pattern matches' },
            { name: 'string.gsub(s, pattern, repl [, n])', desc: 'Global substitution, returns modified string + count' },
            { name: 'string.len(s)', desc: 'String length' },
            { name: 'string.lower(s)', desc: 'Lowercase' },
            { name: 'string.upper(s)', desc: 'Uppercase' },
            { name: 'string.match(s, pattern [, init])', desc: 'First pattern match, returns captures' },
            { name: 'string.rep(s, n [, sep])', desc: 'Repeat string n times with optional separator' },
            { name: 'string.reverse(s)', desc: 'Reverse string' },
            { name: 'string.sub(s, i [, j])', desc: 'Substring (1-indexed, negative counts from end)' },
            { name: 'string.split(s, sep)', desc: 'Split string by separator into table' },
            { name: 'string.pack(fmt, ...)', desc: 'Binary pack values into string' },
            { name: 'string.unpack(fmt, s [, pos])', desc: 'Unpack binary string' },
            { name: 'string.packsize(fmt)', desc: 'Size of packed string for format' },
            { name: 'string.trim(s)', desc: 'Remove leading/trailing whitespace (Luau)' },
            { name: 'string.escapepattern(s)', desc: 'Escape magic pattern characters (Luau)' }
        ]
    },
    table: {
        desc: 'Table manipulation functions',
        funcs: [
            { name: 'table.concat(t [, sep [, i [, j]]])', desc: 'Join table elements into string' },
            { name: 'table.insert(t, [pos,] value)', desc: 'Insert value at position (default end)' },
            { name: 'table.remove(t [, pos])', desc: 'Remove and return element at position (default last)' },
            { name: 'table.sort(t [, comp])', desc: 'Sort in-place using comparator' },
            { name: 'table.find(t, value [, init])', desc: 'Find value in array, return index or nil (Luau)' },
            { name: 'table.clear(t)', desc: 'Remove all elements (Luau)' },
            { name: 'table.clone(t)', desc: 'Shallow copy (Luau)' },
            { name: 'table.freeze(t)', desc: 'Make table read-only (Luau)' },
            { name: 'table.isfrozen(t)', desc: 'Check if frozen (Luau)' },
            { name: 'table.getn(t)', desc: 'Array length (deprecated, use #t)' },
            { name: 'table.create(n [, value])', desc: 'Create array of n elements (Luau)' },
            { name: 'table.move(a1, f, e, t [, a2])', desc: 'Move elements between tables' },
            { name: 'table.unpack(t [, i [, j]])', desc: 'Return elements as multiple values' },
            { name: 'table.pack(...)', desc: 'Pack arguments into table with .n field' }
        ]
    },
    task: {
        desc: 'Task scheduling (replaces spawn/delay/coroutine.wrap for most uses)',
        funcs: [
            { name: 'task.spawn(f, ...)', desc: 'Run function in new thread immediately' },
            { name: 'task.defer(f, ...)', desc: 'Run function in new thread at next deferred step' },
            { name: 'task.delay(t, f, ...)', desc: 'Run function after t seconds' },
            { name: 'task.wait([t])', desc: 'Yield for t seconds (default 0 = next frame). Returns actual delta.' },
            { name: 'task.cancel(thread)', desc: 'Cancel a running thread' },
            { name: 'task.synchronize()', desc: 'Begin synchronized section (parallel Luau)' },
            { name: 'task.desynchronize()', desc: 'Begin desynchronized section (parallel Luau)' }
        ]
    },
    coroutine: {
        desc: 'Coroutine functions',
        funcs: [
            { name: 'coroutine.create(f)', desc: 'Create coroutine from function' },
            { name: 'coroutine.resume(co, ...)', desc: 'Resume coroutine, pass arguments' },
            { name: 'coroutine.running()', desc: 'Return current running coroutine' },
            { name: 'coroutine.status(co)', desc: 'Status: suspended, running, normal, dead' },
            { name: 'coroutine.wrap(f)', desc: 'Create coroutine, return resume function' },
            { name: 'coroutine.yield(...)', desc: 'Suspend coroutine, pass values to resume' },
            { name: 'coroutine.close(co)', desc: 'Close coroutine and run all to-be-closed vars (Luau)' }
        ]
    },
    os: {
        desc: 'Operating system functions',
        funcs: [
            { name: 'os.clock()', desc: 'High-precision elapsed time in seconds' },
            { name: 'os.date([fmt [, time]])', desc: 'Format date string. "*t" returns table.' },
            { name: 'os.difftime(t2, t1)', desc: 'Difference in seconds' },
            { name: 'os.time([table])', desc: 'Current time or table to epoch seconds' }
        ]
    },
    utf8: {
        desc: 'UTF-8 string support',
        funcs: [
            { name: 'utf8.char(...)', desc: 'Build string from codepoints' },
            { name: 'utf8.codepoint(s [, i [, j]])', desc: 'Return codepoints' },
            { name: 'utf8.len(s [, i [, j]])', desc: 'Length in codepoints' },
            { name: 'utf8.offset(s, n [, i])', desc: 'Byte offset of n-th codepoint' },
            { name: 'utf8.graphemes(s [, i [, j]])', desc: 'Iterator over grapheme clusters (Luau)' },
            { name: 'utf8.nfcnormalize(s)', desc: 'NFC normalize (Luau)' },
            { name: 'utf8.nfdnormalize(s)', desc: 'NFD normalize (Luau)' },
            { name: 'utf8.pattern', desc: 'Pattern matching a single UTF-8 byte sequence' }
        ]
    },
    bit32: {
        desc: 'Bitwise operations (32-bit integers)',
        funcs: [
            { name: 'bit32.band(...)', desc: 'Bitwise AND' },
            { name: 'bit32.bnot(x)', desc: 'Bitwise NOT' },
            { name: 'bit32.bor(...)', desc: 'Bitwise OR' },
            { name: 'bit32.bxor(...)', desc: 'Bitwise XOR' },
            { name: 'bit32.btest(...)', desc: 'True if AND result is non-zero' },
            { name: 'bit32.extract(n, field [, width])', desc: 'Extract bits' },
            { name: 'bit32.replace(n, v, field [, width])', desc: 'Replace bits' },
            { name: 'bit32.countlz(x)', desc: 'Count leading zeros (Luau)' },
            { name: 'bit32.countrz(x)', desc: 'Count trailing zeros (Luau)' },
            { name: 'bit32.lshift(x, disp)', desc: 'Left shift' },
            { name: 'bit32.rshift(x, disp)', desc: 'Logical right shift' },
            { name: 'bit32.arshift(x, disp)', desc: 'Arithmetic right shift' },
            { name: 'bit32.lrotate(x, disp)', desc: 'Left rotate' },
            { name: 'bit32.rrotate(x, disp)', desc: 'Right rotate' }
        ]
    },
    debug: {
        desc: 'Debug functions',
        funcs: [
            { name: 'debug.traceback([msg [, level]])', desc: 'Stack traceback string' },
            { name: 'debug.info(f, options)', desc: 'Get function info: "s" source, "l" line, "n" name, "a" args (Luau)' },
            { name: 'debug.profilebegin(label)', desc: 'Start profiler label (Roblox)' },
            { name: 'debug.profileend()', desc: 'End profiler label (Roblox)' },
            { name: 'debug.setmemorycategory(label)', desc: 'Set memory category (Roblox)' },
            { name: 'debug.resetmemorycategory()', desc: 'Reset memory category (Roblox)' }
        ]
    }
};
server.registerTool('get_creator_docs', {
    annotations: ANNOTATIONS,
    title: 'Get Creator Docs',
    description: 'Fetch documentation from the Roblox Creator Hub (create.roblox.com). Use for official guides, tutorials, and API references. For DevForum discussions, use search_devforum instead.',
    inputSchema: z.object({
        path: z.string().describe('Doc path (e.g. "docs/reference/engine/classes/BasePart" or "docs/production/publishing/publishing-experience")')
    })
}, async ({ path }) => {
    try {
        const cleanPath = path.replace(/^\/+|\/+$/g, '');
        const url = `${CREATOR_DOCS}/${cleanPath}`;
        const html = await fetchHTML(url);
        let content = strip(html);
        const mainMatch = content.match(/Skip to main content([\s\S]+)/i);
        if (mainMatch)
            content = mainMatch[1].trim();
        if (content.length > 8000) {
            content = content.slice(0, 8000) + '\n\n... (truncated, page content exceeds limit)';
        }
        if (content.length < 100) {
            return ok(`Page returned minimal content (likely JavaScript-rendered). Try fetching via web reader.\nURL: ${url}`);
        }
        return ok(`Creator Hub Docs: ${cleanPath}\nURL: ${url}\n\n${content}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_creator_docs', {
    annotations: ANNOTATIONS,
    title: 'Search Creator Docs',
    description: 'Search the Roblox Creator Hub documentation for guides, tutorials, and references. For community resources/tutorials from the DevForum, use search_community_resources instead.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(20).default(10).describe('Max results')
    })
}, async ({ query, limit }) => {
    try {
        const searchQ = `${query} order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(searchQ)}`);
        const topics = data.topics || [];
        let results = '';
        if (topics.length) {
            const userMap = searchUserMap(data);
            const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
            results += `DevForum results for "${query}":\n\n${lines}\n\n`;
        }
        const creatorUrl = `${CREATOR_DOCS}/docs?search=${encodeURIComponent(query)}`;
        results += `Creator Hub search: ${creatorUrl}`;
        if (!topics.length) {
            results = `No DevForum results for "${query}". Try the Creator Hub: ${creatorUrl}`;
        }
        return ok(results);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_luau_docs', {
    annotations: ANNOTATIONS,
    title: 'Get Luau Docs',
    description: 'Get Luau standard library reference for built-in modules. Covers math, string, table, task, coroutine, os, utf8, bit32, debug.',
    inputSchema: z.object({
        library: z.string().describe('Library name (e.g. "math", "string", "table", "task", "coroutine", "os", "utf8", "bit32", "debug")')
    })
}, async ({ library }) => {
    try {
        const lib = LUAU_STDLIB[library.toLowerCase()];
        if (!lib) {
            const available = Object.keys(LUAU_STDLIB).join(', ');
            const partial = Object.keys(LUAU_STDLIB).filter(k => k.includes(library.toLowerCase()));
            if (partial.length)
                return ok(`Library "${library}" not found. Did you mean: ${partial.join(', ')}?\nAvailable: ${available}`);
            return ok(`Library "${library}" not found. Available: ${available}`);
        }
        let text = `# Luau ${library}\n${lib.desc}\n\n`;
        for (const f of lib.funcs) {
            text += `- **${f.name}** — ${f.desc}\n`;
        }
        text += `\nDocs: ${CREATOR_DOCS}/docs/luau`;
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_category_metadata', {
    annotations: ANNOTATIONS,
    title: 'Get Category Metadata',
    description: 'Get metadata for a specific DevForum category (name, description, subcategories, moderators, topic count). Returns metadata only, not topics.',
    inputSchema: z.object({
        category_id: z.number().describe('Category ID number')
    })
}, async ({ category_id }) => {
    try {
        const urls = [
            `${DEVFORUM}/c/${category_id}/show.json`,
            `${DEVFORUM}/c/${category_id}.json`
        ];
        const data = await fetchJSONWithFallback(urls);
        const raw = data.category;
        let topicCount = raw.topic_count;
        let postCount = raw.post_count;
        let subs = data.subcategory_list?.categories || [];
        // Fallback: /site.json for parent categories (Discourse hides subcategories from /categories.json)
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
            catch { }
        }
        let text = `Category: ${raw.name} (ID: ${raw.id})\n`;
        text += `Slug: ${raw.slug}\n`;
        text += `Description: ${strip(raw.description || 'none')}\n`;
        text += `Topics: ${topicCount}\n`;
        text += `Posts: ${postCount}\n`;
        if (subs.length) {
            text += `Subcategories: ${subs.map((s) => `${s.name} (ID: ${s.id}, ${s.topic_count} topics)`).join(', ')}\n`;
        }
        if (raw.moderators?.length) {
            text += `Moderators: ${raw.moderators.map((m) => m.username).join(', ')}\n`;
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_bugs', {
    annotations: ANNOTATIONS,
    title: 'Search Bugs',
    description: 'Search for bug reports on the DevForum. Can search studio-bugs, engine-bugs, or both at once.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        category: z.enum(['studio-bugs', 'engine-bugs', 'all']).default('all').describe('Bug category'),
        limit: z.number().min(1).max(30).default(10).describe('Max results')
    })
}, async ({ query, category, limit }) => {
    try {
        const categories = category === 'all' ? ['studio-bugs', 'engine-bugs'] : [category];
        const allTopics = new Map();
        const allUsers = new Map();
        await Promise.all(categories.map(async (cat) => {
            const q = `${query} category:${cat} order:latest`;
            const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
            const topics = data.topics || [];
            for (const t of topics) {
                if (!allTopics.has(t.id))
                    allTopics.set(t.id, t);
            }
            if (data.users) {
                for (const u of data.users)
                    allUsers.set(u.id, u.username);
            }
        }));
        const topics = [...allTopics.values()];
        if (!topics.length)
            return ok(`No bug reports found for "${query}"${category === 'all' ? '' : ` in ${category}`}.`);
        const lines = topics.slice(0, limit).map((t) => topicLine(t, allUsers)).join('\n\n');
        return ok(`Bug reports for "${query}"${category === 'all' ? '' : ` in ${category}`}:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_solved_topics', {
    annotations: ANNOTATIONS,
    title: 'Get Solved Topics',
    description: 'Search for solved DevForum topics. PREFERRED tool for debugging \u2014 use this before get_thread or get_post_replies.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(30).default(10).describe('Max results')
    })
}, async ({ query, limit }) => {
    try {
        const q = `${query} status:solved order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No solved topics found for "${query}".`);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, limit).map((t) => {
            const base = topicLine(t, userMap);
            const accepted = t.has_accepted_answer ? ' \u2705 Has accepted answer' : '';
            return base + accepted;
        }).join('\n\n');
        return ok(`Solved topics for "${query}":\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_new_posts', {
    annotations: ANNOTATIONS,
    title: 'Get New Posts',
    description: 'Get the most recently created topics on the DevForum (strictly chronological by creation date, includes brand-new threads with 0 replies). Different from get_latest_posts which returns popular/curated topics.',
    inputSchema: z.object({
        limit: z.number().min(1).max(30).default(15).describe('Max topics to return')
    })
}, async ({ limit }) => {
    try {
        const data = await fetchJSONWithFallback([
            `${DEVFORUM}/new.json`,
            `${DEVFORUM}/latest.json?order=created`
        ]);
        const text = formatTopics(data.topic_list.topics, data.users, limit);
        return ok(`Newest DevForum topics:\n\n${text}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_api_member', {
    annotations: ANNOTATIONS,
    title: 'Search API Member',
    description: 'Search for a property, method, event, or callback by name across ALL Roblox API classes. Useful to find where a member exists or what classes implement a specific interface.',
    inputSchema: z.object({
        query: z.string().describe('Member name to search for (e.g. "Touched", "Position", "Destroy")'),
        member_type: z.enum(['Property', 'Function', 'Event', 'Callback']).optional().describe('Filter by member type'),
        limit: z.number().min(1).max(50).default(20).describe('Max results')
    })
}, async ({ query, member_type, limit }) => {
    try {
        const classes = await getApiDump();
        const lower = query.toLowerCase();
        const results = [];
        for (const cls of classes) {
            const members = (cls.Members || []).filter(m => {
                if (!m.Name.toLowerCase().includes(lower))
                    return false;
                if (member_type && m.MemberType !== member_type)
                    return false;
                return true;
            });
            for (const m of members) {
                results.push({ class: cls.Name, member: m });
            }
        }
        if (!results.length)
            return ok(`No API member matching "${query}" found.`);
        let text = `API members matching "${query}" (${results.length} found, showing ${Math.min(results.length, limit)}):\n\n`;
        for (const r of results.slice(0, limit)) {
            const m = r.member;
            const tags = m.Tags ? ` [${m.Tags.join(', ')}]` : '';
            if (m.MemberType === 'Property') {
                text += `- ${r.class}.${m.Name}: ${m.ValueType?.Name || 'unknown'}${tags}\n`;
            }
            else if (m.MemberType === 'Function') {
                const params = (m.Parameters || []).map(p => `${p.Name}: ${p.Type.Name}${p.Default !== undefined ? '=' + p.Default : ''}`).join(', ');
                text += `- ${r.class}.${m.Name}(${params}): ${m.ReturnType?.Name || 'void'}${tags}\n`;
            }
            else if (m.MemberType === 'Event') {
                const params = (m.Parameters || []).map(p => `${p.Name}: ${p.Type.Name}`).join(', ');
                text += `- ${r.class}.${m.Name}(${params})${tags}\n`;
            }
            else {
                text += `- ${r.class}.${m.Name} (${m.MemberType})${tags}\n`;
            }
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_enum', {
    annotations: ANNOTATIONS,
    title: 'Get Enum',
    description: 'List or inspect Roblox API enums. If name is provided, returns all values for that enum. If omitted, returns list of all enums.',
    inputSchema: z.object({
        name: z.string().optional().describe('Enum name (e.g. "Material", "PartType"). If omitted, lists all enums.'),
        filter: z.string().optional().describe('Filter enum names when listing (ignored if name is provided)')
    })
}, async ({ name, filter }) => {
    try {
        const full = await getApiDumpFull();
        const enums = full.Enums || [];
        if (name) {
            const en = enums.find(e => e.Name.toLowerCase() === name.toLowerCase());
            if (!en) {
                const partials = enums.filter(e => e.Name.toLowerCase().includes(name.toLowerCase())).slice(0, 10);
                if (partials.length)
                    return ok(`Enum "${name}" not found. Did you mean:\n${partials.map(e => `- ${e.Name}`).join('\n')}`);
                return ok(`Enum "${name}" not found. Omit name to list all enums.`);
            }
            const items = en.Items || [];
            let text = `# Enum ${en.Name}\nValues: ${items.length}\n\n`;
            for (const item of items) {
                text += `- ${item.Name}\n`;
            }
            return ok(text.trim());
        }
        const filtered = filter
            ? enums.filter(e => e.Name.toLowerCase().includes(filter.toLowerCase()))
            : enums;
        if (!filtered.length)
            return ok(filter ? `No enums matching "${filter}".` : 'No enums found.');
        const lines = filtered.map(e => `- ${e.Name} (${(e.Items || []).length} values)`).join('\n');
        return ok(`Roblox Enums (${filtered.length}${filter ? ' matching "' + filter + '"' : ' total'}):\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_roblox_status', {
    annotations: ANNOTATIONS,
    title: 'Get Roblox Status',
    description: 'Check the current status of Roblox platform services (website, Studio, API, game servers, etc.)',
    inputSchema: z.object({})
}, async () => {
    try {
        const data = await fetchJSON('https://api.status.io/1.0/status/59db90dbcdeb2f04dadcf16d');
        const result = data.result || {};
        const overall = result.status_overall || {};
        let text = `Roblox Status: ${overall.status || 'unknown'}\n`;
        text += `Updated: ${overall.updated ? formatDate(overall.updated) : 'unknown'}\n\n`;
        const statuses = result.status || [];
        for (const group of statuses) {
            text += `${group.name}: ${group.status}\n`;
            const containers = group.containers || [];
            for (const child of containers) {
                text += `  ${child.name}: ${child.status}\n`;
            }
        }
        const incidents = result.incidents || [];
        if (incidents.length) {
            text += `\nActive Incidents:\n`;
            for (const inc of incidents.slice(0, 5)) {
                text += `- ${inc.name} (${inc.status})\n`;
            }
        }
        const maintenance = result.maintenance || {};
        const activeMaint = maintenance.active || [];
        if (activeMaint.length) {
            text += `\nActive Maintenance:\n`;
            for (const m of activeMaint.slice(0, 5)) {
                text += `- ${m.name} (${m.status})\n`;
            }
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_class_hierarchy', {
    annotations: ANNOTATIONS,
    title: 'Get Class Hierarchy',
    description: 'Get the full inheritance tree for a Roblox class, showing all parent classes and direct subclasses. Useful for understanding what a class inherits from and what extends it.',
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "RemoteEvent")')
    })
}, async ({ class_name }) => {
    try {
        const classes = await getApiDump();
        const cls = findClass(class_name);
        if (!cls) {
            const partials = classes
                .filter(c => c.Name.toLowerCase().includes(class_name.toLowerCase()))
                .slice(0, 10);
            if (partials.length)
                return ok(`Class "${class_name}" not found. Did you mean:\n${partials.map(c => `- ${c.Name}`).join('\n')}`);
            return ok(`Class "${class_name}" not found.`);
        }
        const ancestors = [];
        let current = cls;
        while (current.Superclass && current.Superclass !== '<<<ROOT>>>') {
            ancestors.push(current.Superclass);
            const parent = classes.find(c => c.Name === current.Superclass);
            if (!parent)
                break;
            current = parent;
        }
        const subclasses = classes.filter(c => c.Superclass === cls.Name).map(c => c.Name);
        let output = `# ${cls.Name} Hierarchy\n\n`;
        if (ancestors.length) {
            output += `**Ancestors:** ${ancestors.join(' > ')}\n\n`;
        }
        else {
            output += `**Root class** (no ancestors)\n\n`;
        }
        if (subclasses.length) {
            output += `**Subclasses** (${subclasses.length}):\n`;
            for (const sub of subclasses) {
                output += `- ${sub}\n`;
            }
        }
        else {
            output += `**No subclasses** (leaf class)\n`;
        }
        const memberCount = (cls.Members || []).length;
        const props = (cls.Members || []).filter(m => m.MemberType === 'Property').length;
        const methods = (cls.Members || []).filter(m => m.MemberType === 'Function').length;
        const events = (cls.Members || []).filter(m => m.MemberType === 'Event').length;
        output += `\n**Own members:** ${memberCount} (${props} props, ${methods} methods, ${events} events)\n`;
        output += `\nDocs: ${CREATOR_DOCS}/docs/reference/engine/classes/${cls.Name}\n`;
        return ok(output.trim());
    }
    catch (e) {
        return err(e);
    }
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main().catch(() => {
    process.exit(1);
});
