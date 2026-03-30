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
const server = new mcp_js_1.McpServer({ name: 'roblox-devforum-mcp', version: '1.3.0' });
const COMMON_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'roblox-devforum-mcp/1.3.0'
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
    const res = await fetch(url, { headers: { 'User-Agent': 'roblox-devforum-mcp/1.3.0' } });
    if (res.status === 429)
        throw new Error('Rate limited by server. Please wait and try again.');
    if (res.status === 404)
        throw new Error(`Not found: ${url}`);
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.text();
}
function strip(html) {
    return html
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
    let author = t.last_poster_username || 'unknown';
    if (author === 'unknown' && users && t.posters?.length) {
        const poster = t.posters[0];
        author = users.get(poster.user_id) || 'unknown';
    }
    return `\u2022 ${title}\n  Author: ${author} | Date: ${date} | Replies: ${replies} | Views: ${views}\n  ${url}`;
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
function ok(text) {
    return { content: [{ type: 'text', text }] };
}
function err(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}
let apiDumpCache = null;
async function getApiDump() {
    if (apiDumpCache)
        return apiDumpCache;
    const data = await fetchJSON('https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json');
    apiDumpCache = data.Classes;
    return apiDumpCache;
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
    description: 'Get latest posts from the Roblox Developer Forum, optionally filtered by category',
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
    description: 'Search the Roblox Developer Forum for topics matching a query',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(30).default(10).describe('Max results')
    })
}, async ({ query, limit }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(query)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No results found for "${query}".`);
        const userMap = buildUserMap(data.users);
        const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
        return ok(`Search results for "${query}":\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_thread', {
    title: 'Get Thread',
    description: 'Get a specific DevForum thread with its first page of posts. Never auto-paginates.',
    inputSchema: z.object({
        thread_id: z.string().describe('Thread ID or slug')
    })
}, async ({ thread_id }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json`);
        const posts = (data.post_stream?.posts || []).slice(0, 20);
        let text = `Title: ${data.title}\n`;
        text += `Author: ${posts[0]?.username || 'unknown'} | Date: ${formatDate(data.created_at)}\n`;
        text += `Tags: ${(data.tags || []).join(', ') || 'none'}\n`;
        text += `Replies: ${data.posts_count - 1} | Views: ${data.views}\n`;
        text += `URL: ${DEVFORUM}/t/${data.slug}/${data.id}\n\n`;
        for (const p of posts) {
            text += `--- Post by ${p.username} (${formatDate(p.created_at)}) ---\n`;
            text += strip(p.cooked) + '\n\n';
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
        const userMap = buildUserMap(data.users);
        const lines = topics.slice(0, 20).map((t) => topicLine(t, userMap)).join('\n\n');
        return ok(`Topics requiring action:\n\n${lines}`);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('get_engine_updates', {
    title: 'Get Engine Updates',
    description: 'Get the latest Roblox engine and Studio updates from the DevForum',
    inputSchema: z.object({})
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
    description: 'Get replies for a DevForum thread at a specific page. Fetches one page only \u2014 never auto-paginates.',
    inputSchema: z.object({
        thread_id: z.string().describe('Thread ID'),
        page: z.number().min(1).default(1).describe('Page number (1-indexed)')
    })
}, async ({ thread_id, page }) => {
    try {
        const data = await fetchJSON(`${DEVFORUM}/t/${thread_id}.json?page=${page}`);
        const posts = data.post_stream?.posts || [];
        if (!posts.length)
            return ok(`No posts found on page ${page}.`);
        let text = `Thread: ${data.title} \u2014 Page ${page}\n\n`;
        for (const p of posts) {
            text += `--- ${p.username} (${formatDate(p.created_at)}) ---\n`;
            text += strip(p.cooked) + '\n\n';
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
            const lines = posts.map((p) => {
                const excerpt = (p.excerpt || strip(p.cooked || '')).slice(0, 150);
                const topicSlug = p.slug || p.topic_id;
                const topicUrl = `${DEVFORUM}/t/${topicSlug}/${p.topic_id}`;
                return `\u2022 Post in topic #${p.topic_id} | Date: ${formatDate(p.created_at)}\n  ${topicUrl}\n  ${excerpt}`;
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
    description: 'Get Roblox Creator documentation for an engine class (properties, methods, events)',
    inputSchema: z.object({
        class_name: z.string().describe('Engine class name (e.g. "BasePart", "Workspace")')
    })
}, async ({ class_name }) => {
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
            output += `\n_Inherited from ${chain.slice(1).join(', ')} \u2014 use get_api_docs with the parent class name for those members._\n`;
        }
        return ok(output);
    }
    catch (e) {
        return err(e);
    }
});
server.registerTool('search_creator_docs', {
    title: 'Search Creator Docs',
    description: 'Search the official Roblox Creator documentation',
    inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().min(1).max(20).default(10).describe('Max results')
    })
}, async ({ query, limit }) => {
    try {
        try {
            const algoliaRes = await fetch('https://85zn6ifj4h-dsn.algolia.net/1/indexes/*/queries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'roblox-devforum-mcp/1.3.0',
                    'X-Algolia-Api-Key': '7b33628bc17a987d6e3e2590db6c0e5d',
                    'X-Algolia-Application-Id': '85ZN6IFJ4H'
                },
                body: JSON.stringify({
                    requests: [{
                            indexName: 'creator_hub',
                            params: `query=${encodeURIComponent(query)}&hitsPerPage=${limit}`
                        }]
                })
            });
            if (algoliaRes.ok) {
                const data = await algoliaRes.json();
                const results = data.results?.[0]?.hits || [];
                if (results.length) {
                    const lines = results.map((h) => {
                        const title = h.title || h.hierarchy?.lvl1 || h.name || 'Untitled';
                        const url = h.url || `${CREATOR_DOCS}/docs/${h.slug || ''}`;
                        const snippet = (h._highlightResult?.content?.value || h.content || h.description || '').replace(/<[^>]+>/g, '');
                        const cleanSnippet = snippet.slice(0, 200);
                        return `\u2022 ${title}\n  ${url}\n  ${cleanSnippet}`;
                    }).join('\n\n');
                    return ok(`Creator Docs search for "${query}":\n\n${lines}`);
                }
            }
        }
        catch { }
        const devforumData = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(`${query} category:resources`)}`);
        const topics = devforumData.topics || [];
        if (topics.length) {
            const userMap = buildUserMap(devforumData.users);
            const lines = topics.slice(0, limit).map((t) => topicLine(t, userMap)).join('\n\n');
            return ok(`Creator Docs search for "${query}" (via DevForum):\n\n${lines}`);
        }
        return ok(`No results found for "${query}" in Creator Docs.`);
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
        const lines = cats.map((c) => {
            const desc = c.description_text ? ` \u2014 ${c.description_text.slice(0, 100)}` : '';
            return `\u2022 ${c.name} (ID: ${c.id}, slug: ${c.slug})${desc}\n  Topics: ${c.topic_count}`;
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
        const lines = tags.map((t) => `\u2022 ${t.name} (${t.count} topics)`).join('\n');
        return ok(`DevForum Tags:\n\n${lines}`);
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
        const c = data.category;
        let text = `Category: ${c.name} (ID: ${c.id})\n`;
        text += `Slug: ${c.slug}\n`;
        text += `Description: ${strip(c.description || 'none')}\n`;
        text += `Topics: ${c.topic_count}\n`;
        text += `Posts: ${c.post_count}\n`;
        if (c.subcategory_ids?.length) {
            const subcategories = data.subcategory_list?.categories || [];
            const subMap = new Map(subcategories.map((sc) => [sc.id, sc]));
            const subLines = c.subcategory_ids.map((id) => {
                const sub = subMap.get(id);
                return sub ? `${sub.name} (ID: ${sub.id}, ${sub.topic_count} topics)` : `ID: ${id}`;
            });
            text += `Subcategories: ${subLines.join(', ')}\n`;
        }
        if (c.moderators?.length) {
            text += `Moderators: ${c.moderators.map((m) => m.username).join(', ')}\n`;
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
        const q = `${query} category:${category}`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No bug reports found for "${query}" in ${category}.`);
        const userMap = buildUserMap(data.users);
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
        const q = `${query} status:solved`;
        const data = await fetchJSON(`${DEVFORUM}/search.json?q=${encodeURIComponent(q)}`);
        const topics = data.topics || [];
        if (!topics.length)
            return ok(`No solved topics found for "${query}".`);
        const userMap = buildUserMap(data.users);
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
    description: 'Get the newest topics on the DevForum. Falls back to latest if new topics endpoint requires authentication.',
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
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main().catch(() => {
    process.exit(1);
});
