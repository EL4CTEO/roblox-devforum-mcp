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
const VERSION = '2.2.0';
const server = new mcp_js_1.McpServer({ name: 'roblox-devforum-mcp', version: VERSION });
const COMMON_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': `roblox-devforum-mcp/${VERSION}`
};
async function fetchJSON(url) {
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (res.status === 429)
        throw new Error('Rate limited by server. Please wait and try again.');
    if (res.status === 404)
        throw new Error(`Not found: ${url}`);
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}
async function fetchJSONWithFallback(urls) {
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: COMMON_HEADERS });
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
    const res = await fetch(url, { headers: { 'User-Agent': `roblox-devforum-mcp/${VERSION}` } });
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
    const views = t.views ?? 0;
    const replies = t.posts_count ? t.posts_count - 1 : (t.reply_count ?? 0);
    let author = t.last_poster_username || '';
    if (!author && users && t.posters?.length) {
        const poster = t.posters[0];
        author = users.get(poster.user_id) || '';
    }
    if (!author && users && t.id) {
        author = users.get(t.id) || '';
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
const API_DUMP_TTL = 6 * 60 * 60 * 1000;
async function getApiDumpFull() {
    const now = Date.now();
    if (apiDumpFullCache && (now - apiDumpCacheTime) < API_DUMP_TTL)
        return apiDumpFullCache;
    try {
        const data = await fetchJSON('https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json');
        apiDumpFullCache = data;
        apiDumpCacheTime = now;
        return apiDumpFullCache;
    }
    catch (e) {
        if (apiDumpFullCache)
            return apiDumpFullCache;
        throw e;
    }
}
async function getApiDump() {
    const full = await getApiDumpFull();
    return full.Classes;
}
// ─── Tools ─────────────────────────────────────────────────────────
server.registerTool('get_announcements', {
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
    title: 'Get Thread',
    description: 'Get a specific DevForum thread. Returns the first post (title + content), reply count, accepted answer info, and if solved, the accepted answer excerpt. Use get_post_replies to read full replies.',
    inputSchema: z.object({
        thread_id: z.string().describe('Thread ID or slug')
    })
}, async ({ thread_id }) => {
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
            text += strip(firstPost.cooked);
        }
        if (acceptedAnswer && acceptedAnswer.excerpt) {
            text += `\n\n--- Accepted Answer by ${acceptedUser || 'unknown'} (Post #${acceptedPostId}) ---\n`;
            let excerpt = acceptedAnswer.excerpt;
            if (excerpt.length > 1500) {
                excerpt = excerpt.slice(0, 1500) + '...';
            }
            text += excerpt;
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_action_required', {
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
    title: 'Get Engine Updates',
    description: 'Get the latest Roblox engine and Studio release notes, changelogs, and technical updates. Returns topics tagged with release notes from the Updates category. Covers engine changes, API additions/removals, deprecations, and new features. Use get_announcements for general announcements.',
    inputSchema: z.object({
        limit: z.number().min(1).max(20).default(10).describe('Number of updates to return')
    })
}, async ({ limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent('category:updates tag:release order:latest')}`);
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
    title: 'Get Category',
    description: 'Get topics from a specific DevForum category by slug and ID',
    inputSchema: z.object({
        slug: z.string().describe('Category slug (e.g. "help-and-feedback")'),
        category_id: z.number().describe('Category ID number'),
        limit: z.number().min(1).max(30).default(10).describe('Max topics to return')
    })
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
server.registerTool('get_top_posts', {
    title: 'Get Top Posts',
    description: 'Get top DevForum posts for a given time period',
    inputSchema: z.object({
        period: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'all']).describe('Time period')
    })
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
server.registerTool('get_post_replies', {
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
            text += `--- ${p.username} (${formatDate(p.created_at)}) ---\n`;
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
    title: 'Get API Docs',
    description: 'Get Roblox Creator documentation for an engine class (properties, methods, events, callbacks, inheritance). This is the go-to for any API reference question. Do NOT use search_creator_docs for class reference.',
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "Workspace")'),
        include_inherited: z.boolean().default(false).describe('Include key inherited members from parent classes')
    })
}, async ({ class_name, include_inherited }) => {
    try {
        const classes = await getApiDump();
        const cls = classes.find(c => c.Name.toLowerCase() === class_name.toLowerCase());
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
server.registerTool('search_creator_docs', {
    title: 'Search Creator Docs',
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
server.registerTool('get_categories', {
    title: 'Get Categories',
    description: 'List all DevForum categories with ID, slug, name, description, and topic count',
    inputSchema: z.object({})
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
        catch { }
        const lines = cats.map((c) => {
            const desc = c.description_text ? ` \u2014 ${c.description_text.slice(0, 100)}` : '';
            let topicCount = c.topic_count;
            if (!topicCount && siteCats) {
                const subs = [...siteCats.values()].filter((s) => s.parent_category_id === c.id);
                topicCount = subs.reduce((sum, s) => sum + (s.topic_count || 0), 0);
            }
            return `\u2022 ${c.name} (ID: ${c.id}, slug: ${c.slug})${desc}\n  Topics: ${topicCount || 0}`;
        }).join('\n\n');
        return ok(`DevForum Categories:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_tags', {
    title: 'Get Tags',
    description: 'List all available DevForum tags with topic counts',
    inputSchema: z.object({})
}, async () => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/tags.json`);
        const tags = data.tags || [];
        const sorted = tags.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 100);
        const lines = sorted.map((t) => `\u2022 ${t.name} (${t.count} topics)`).join('\n');
        return ok(`DevForum Tags (top 100 by topic count):\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_category_metadata', {
    title: 'Get Category Metadata',
    description: 'Get metadata for a specific DevForum category (name, description, subcategories, moderators, topic count). Returns metadata only, not topics.',
    inputSchema: z.object({
        category_id: z.number().describe('Category ID number')
    })
}, async ({ category_id }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/c/${category_id}/show.json`);
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
    title: 'Search Bugs',
    description: 'Search for bug reports on the DevForum. One category at a time \u2014 Discourse does not support multiple category filters.',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        category: z.enum(['studio-bugs', 'engine-bugs']).default('studio-bugs').describe('Bug category'),
        limit: z.number().min(1).max(30).default(10).describe('Max results')
    })
}, async ({ query, category, limit }) => {
    try {
        const q = `${query} category:${category} order:latest`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No bug reports found for "${query}" in ${category}.`);
        const userMap = searchUserMap(data);
        const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
        return ok(`Bug reports for "${query}" in ${category}:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_solved_topics', {
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
server.registerTool('get_enums', {
    title: 'Get Enums',
    description: 'List all Roblox API enums (e.g. Material, PartType, ActionType). Returns enum names and item counts.',
    inputSchema: z.object({
        filter: z.string().optional().describe('Optional filter to narrow enum names')
    })
}, async ({ filter }) => {
    try {
        const full = await getApiDumpFull();
        const enums = full.Enums || [];
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
server.registerTool('get_enum_values', {
    title: 'Get Enum Values',
    description: 'Get all values for a specific Roblox API enum (e.g. "Material" returns Plastic, Wood, Slate, etc.)',
    inputSchema: z.object({
        enum_name: z.string().describe('Enum name (e.g. "Material", "PartType", "AccessType")')
    })
}, async ({ enum_name }) => {
    try {
        const full = await getApiDumpFull();
        const enums = full.Enums || [];
        const en = enums.find(e => e.Name.toLowerCase() === enum_name.toLowerCase());
        if (!en) {
            const partials = enums.filter(e => e.Name.toLowerCase().includes(enum_name.toLowerCase())).slice(0, 10);
            if (partials.length)
                return ok(`Enum "${enum_name}" not found. Did you mean:\n${partials.map(e => `- ${e.Name}`).join('\n')}`);
            return ok(`Enum "${enum_name}" not found. Use get_enums to list all available enums.`);
        }
        const items = en.Items || [];
        let text = `# Enum ${en.Name}\nValues: ${items.length}\n\n`;
        for (const item of items) {
            text += `- ${item.Name}\n`;
        }
        return ok(text.trim());
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_roblox_status', {
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
    title: 'Get Class Hierarchy',
    description: 'Get the full inheritance tree for a Roblox class, showing all parent classes and direct subclasses. Useful for understanding what a class inherits from and what extends it.',
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "RemoteEvent")')
    })
}, async ({ class_name }) => {
    try {
        const classes = await getApiDump();
        const cls = classes.find(c => c.Name.toLowerCase() === class_name.toLowerCase());
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
