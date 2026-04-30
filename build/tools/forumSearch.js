import * as z from "zod";
import { URLS } from "../config.js";
import { buildSearchUserMap, buildUserMap, toForumHit } from "../lib/discourse.js";
import { fail, ok } from "../lib/responses.js";
import { stripHtml } from "../lib/sanitize.js";
import { sortByRelevance } from "../lib/scoring.js";
const Period = z.enum(["daily", "weekly", "monthly", "yearly", "all"]);
const Sort = z.enum(["relevance", "latest", "top", "new", "created"]);
const Status = z.enum(["solved", "action-required", "open"]);
const inputShape = {
    query: z.string().optional().describe("Free-text search query."),
    category: z
        .string()
        .optional()
        .describe("Category slug (e.g. 'help-and-feedback') or numeric id. Combine with sort='latest' to list a category."),
    status: Status.optional().describe("Filter by topic status. 'solved' is preferred for debugging."),
    tag: z
        .string()
        .optional()
        .describe("Filter by Discourse tag (e.g. 'studio-bugs', 'action-required')."),
    period: Period.optional().describe("Time window. Required when sort='top'."),
    sort: Sort.default("relevance").describe("Ordering: 'relevance' (default, scored), 'latest' (recent activity), 'top' (needs period), 'new'/'created' (chronological)."),
    user: z
        .string()
        .optional()
        .describe("Username for activity feed. If set without query, fetches recent activity."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results."),
};
const Hit = z.object({
    id: z.number(),
    title: z.string(),
    url: z.string(),
    author: z.string(),
    category_id: z.number().optional(),
    tags: z.array(z.string()),
    replies: z.number(),
    views: z.number(),
    likes: z.number(),
    createdAt: z.string(),
    lastActivityAt: z.string().optional(),
    isSolved: z.boolean(),
    excerpt: z.string().optional(),
    score: z.number(),
});
const outputShape = {
    results: z.array(Hit),
    total: z.number(),
    source: z.string(),
};
function buildSearchQuery(input) {
    const parts = [];
    if (input.query)
        parts.push(input.query);
    if (input.status === "solved")
        parts.push("status:solved");
    else if (input.status === "open")
        parts.push("status:open");
    else if (input.status === "action-required")
        parts.push('"action required" in:title');
    if (input.tag)
        parts.push(`tags:${input.tag}`);
    if (input.user)
        parts.push(`@${input.user}`);
    if (input.category) {
        const isNumeric = /^\d+$/.test(input.category);
        parts.push(isNumeric ? `#${input.category}` : `category:${input.category}`);
    }
    if (input.sort === "latest" || input.sort === "relevance")
        parts.push("order:latest");
    return parts.join(" ").trim();
}
function categoryUrl(category, _sort) {
    const isNumeric = /^\d+$/.test(category);
    if (isNumeric) {
        return `${URLS.devforum}/c/${category}.json`;
    }
    return `${URLS.devforum}/c/${encodeURIComponent(category)}.json`;
}
function formatList(hits) {
    return hits
        .map((h) => {
        const flags = [];
        if (h.isSolved)
            flags.push("✅ solved");
        const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
        return `• ${h.title}${flagStr}\n  Author: ${h.author} | Date: ${h.createdAt.slice(0, 10) || "unknown"} | Replies: ${h.replies} | Views: ${h.views}\n  ${h.url}`;
    })
        .join("\n\n");
}
export function register(server, ctx) {
    server.registerTool("forum_search", {
        title: "Search Roblox DevForum",
        description: "Unified DevForum search. Supports free-text queries, category/tag/status/user filters, top/latest/new/relevance sort. Replaces 11 legacy 'get_*'/'search_*' tools. Use status='solved' for debugging questions.",
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (raw) => {
        const input = raw;
        try {
            let url;
            let isSearch = false;
            if (input.sort === "top") {
                const period = input.period ?? "weekly";
                url = `${URLS.devforum}/top/${period}.json`;
                if (input.category) {
                    const cs = encodeURIComponent(input.category);
                    url = `${URLS.devforum}/c/${cs}/l/top/${period}.json`;
                }
            }
            else if (input.sort === "new" || input.sort === "created") {
                if (input.query) {
                    url = `${URLS.devforum}/search.json?q=${encodeURIComponent(`${buildSearchQuery(input)} order:latest`)}`;
                    isSearch = true;
                }
                else {
                    url = `${URLS.devforum}/latest.json?order=created`;
                }
            }
            else if (input.user && !input.query) {
                const profileUrl = `${URLS.devforum}/u/${encodeURIComponent(input.user)}/activity.json`;
                ctx.logger.debug("forum_search: user activity", { user: input.user });
                url = profileUrl;
            }
            else if (input.query || input.tag || input.status === "action-required") {
                url = `${URLS.devforum}/search.json?q=${encodeURIComponent(buildSearchQuery(input))}`;
                isSearch = true;
            }
            else if (input.category) {
                url = categoryUrl(input.category, input.sort);
            }
            else {
                url = `${URLS.devforum}/latest.json`;
            }
            ctx.logger.debug("forum_search fetching", {
                url,
                sort: input.sort,
                isSearch,
            });
            const data = await ctx.http.getJson(url);
            let topics = isSearch
                ? (data.topics ?? [])
                : (data.topic_list?.topics ?? []);
            if (Array.isArray(data)) {
                // user activity feed: array of posts
                const posts = data;
                const hits = [];
                const topicIds = new Set();
                for (const p of posts) {
                    const topicId = Number(p.topic_id ?? 0);
                    if (!topicId)
                        continue;
                    if (hits.length >= input.limit)
                        break;
                    if (topicIds.has(topicId))
                        continue;
                    topicIds.add(topicId);
                    const slug = String(p.slug ?? p.topic_slug ?? topicId);
                    let title = String(p.topic_title ?? p.title ?? "");
                    if (!title)
                        title = slug.replace(/-/g, " ").replace(/^\d+\s*/, "");
                    if (!title)
                        title = `Topic #${topicId}`;
                    hits.push({
                        id: topicId,
                        title,
                        url: `${URLS.devforum}/t/${slug}/${topicId}`,
                        author: String(p.username ?? input.user ?? "unknown"),
                        tags: [],
                        replies: 0,
                        views: 0,
                        likes: 0,
                        createdAt: String(p.created_at ?? ""),
                        isSolved: false,
                        excerpt: stripHtml(String(p.excerpt ?? p.cooked ?? "")).slice(0, 200),
                        score: 0,
                    });
                }
                const text = hits.length ? formatList(hits) : `No recent activity for ${input.user}.`;
                return ok(`Activity for ${input.user}:\n\n${text}`, {
                    results: hits,
                    total: hits.length,
                    source: profileUrlSource(input.user ?? ""),
                });
            }
            if (input.sort === "latest") {
                topics = sortByRelevance(topics);
            }
            const limited = topics.slice(0, input.limit);
            const userMap = isSearch
                ? buildSearchUserMap(data)
                : buildUserMap(data.users ?? undefined);
            const hits = limited.map((t) => toForumHit(t, userMap));
            const text = hits.length
                ? formatList(hits)
                : `No results${input.query ? ` for "${input.query}"` : ""}.`;
            return ok(text, {
                results: hits,
                total: topics.length,
                source: url,
            });
        }
        catch (e) {
            return fail(e);
        }
    });
}
function profileUrlSource(user) {
    return `${URLS.devforum}/u/${encodeURIComponent(user)}/activity.json`;
}
//# sourceMappingURL=forumSearch.js.map