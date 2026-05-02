import * as z from "zod";
import { URLS } from "../config.js";
import { LruCache, normalizeCacheKey } from "../lib/cache.js";
import { buildUserMap, isStaffUser } from "../lib/discourse.js";
import { extractReleaseNoteFromHtml, extractReleaseNoteIndex, renderReleaseNoteMarkdown, } from "../lib/releaseNotes.js";
import { fail, ok } from "../lib/responses.js";
import { stripHtml } from "../lib/sanitize.js";
const Source = z.enum(["release_notes", "announcements", "all"]);
const inputShape = {
    since: z
        .string()
        .optional()
        .describe("Lower bound: ISO date (e.g. 2026-04-01) or relative ('7d', '30d', '90d', 'last_release'). Default '30d'."),
    source: Source.default("all").describe("Which feed to query: 'release_notes' (Creator Hub), 'announcements' (DevForum staff posts), 'all'."),
    query: z.string().optional().describe("Free-text filter on title + summary."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max items returned."),
};
const SectionsSchema = z
    .object({
    new_features: z.array(z.string()).optional(),
    improvements: z.array(z.string()).optional(),
    fixes: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
})
    .optional();
const ItemSchema = z.object({
    type: z.enum(["release_note", "announcement"]),
    title: z.string(),
    url: z.string(),
    date: z.string(),
    summary: z.string(),
    version: z.string().optional(),
    sections: SectionsSchema,
    author: z.string().optional(),
    category: z.string().optional(),
});
const outputShape = {
    items: z.array(ItemSchema),
    total: z.number(),
    source: z.string(),
};
const DAY = 24 * 60 * 60 * 1000;
function fallbackSince() {
    return new Date(Date.now() - 30 * DAY);
}
function relativeOffset(s) {
    const m = /^(\d+)d$/.exec(s);
    if (!m?.[1])
        return null;
    const days = Number(m[1]);
    if (!Number.isFinite(days) || days <= 0)
        return null;
    return new Date(Date.now() - days * DAY);
}
async function resolveSince(raw, fetchLatestReleaseDate) {
    if (!raw)
        return fallbackSince();
    const rel = relativeOffset(raw);
    if (rel)
        return rel;
    if (raw === "last_release") {
        const iso = await fetchLatestReleaseDate();
        if (iso) {
            const d = new Date(iso);
            if (!Number.isNaN(d.getTime()))
                return d;
        }
        return fallbackSince();
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime()))
        return d;
    return fallbackSince();
}
function matchesQuery(item, query) {
    if (!query)
        return true;
    const q = query.toLowerCase();
    return item.title.toLowerCase().includes(q) || item.summary.toLowerCase().includes(q);
}
function withinSince(item, since) {
    if (!item.date)
        return false;
    const d = new Date(item.date);
    if (Number.isNaN(d.getTime()))
        return false;
    return d.getTime() >= since.getTime();
}
function topicToNewsItem(t, userMap, category) {
    if (!t.created_at)
        return null;
    const firstPosterUserId = t.posters?.[0]?.user_id;
    const author = (firstPosterUserId !== undefined ? userMap.get(firstPosterUserId) : undefined) ??
        t.last_poster_username ??
        "Roblox";
    const slug = t.slug ?? String(t.id);
    const item = {
        type: "announcement",
        title: t.title ?? t.fancy_title ?? `Topic ${t.id}`,
        url: `${URLS.devforum}/t/${slug}/${t.id}`,
        date: t.created_at,
        summary: stripHtml(t.excerpt ?? "").slice(0, 400),
        author,
    };
    if (category)
        item.category = category;
    return item;
}
function dedupeNewsItems(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = item.url;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
function formatNewsList(items) {
    if (items.length === 0)
        return "No news items found for the selected window.";
    return items
        .map((item) => {
        const date = item.date ? item.date.slice(0, 10) : "unknown";
        if (item.type === "release_note") {
            const sectionLines = [];
            const labels = [
                ["new_features", "New"],
                ["improvements", "Improved"],
                ["fixes", "Fixed"],
                ["removed", "Removed"],
            ];
            for (const [key, label] of labels) {
                const arr = item.sections?.[key];
                if (arr && arr.length > 0)
                    sectionLines.push(`  ${label}: ${arr.length}`);
            }
            return [
                `• [Release ${item.version ?? "?"}] ${item.title} (${date})`,
                ...sectionLines,
                `  ${item.url}`,
            ].join("\n");
        }
        const author = item.author ? ` by ${item.author}` : "";
        const cat = item.category ? ` [${item.category}]` : "";
        return `• ${item.title}${cat} (${date})${author}\n  ${item.url}`;
    })
        .join("\n\n");
}
export function register(server, ctx) {
    const indexCache = new LruCache({ ttlMs: 60 * 60 * 1000, max: 4 });
    const noteCache = new LruCache({ ttlMs: 24 * 60 * 60 * 1000, max: 60 });
    async function getCachedHtml(cache, url) {
        const key = `html::${normalizeCacheKey(url)}`;
        const hit = cache.get(key);
        if (hit)
            return hit.value;
        const html = await ctx.http.getHtml(url, { cache: false });
        cache.set(key, html);
        return html;
    }
    async function fetchReleaseNotes(limit) {
        const indexHtml = await getCachedHtml(indexCache, URLS.releaseNotesIndex);
        const entries = extractReleaseNoteIndex(indexHtml);
        if (entries.length === 0)
            return [];
        const top = entries.slice(0, Math.min(limit + 4, 12));
        const items = await Promise.all(top.map(async (entry) => {
            try {
                const html = await getCachedHtml(noteCache, entry.url);
                return extractReleaseNoteFromHtml(html, entry.version, entry.url);
            }
            catch (e) {
                ctx.logger.debug("release note fetch failed", {
                    version: entry.version,
                    error: e instanceof Error ? e.message : String(e),
                });
                return null;
            }
        }));
        return items.filter((i) => i !== null);
    }
    async function latestReleaseDate() {
        try {
            const items = await fetchReleaseNotes(1);
            const dated = items.filter((i) => i.date).sort((a, b) => b.date.localeCompare(a.date));
            return dated[0]?.date ?? null;
        }
        catch {
            return null;
        }
    }
    async function fetchAnnouncements(limit) {
        const items = [];
        const seenCategoryUrls = new Set();
        async function fetchCategoryFeed(url, label) {
            if (seenCategoryUrls.has(url))
                return;
            seenCategoryUrls.add(url);
            try {
                const data = await ctx.http.getJson(url);
                const topics = data.topic_list?.topics ?? [];
                const userMap = buildUserMap(data.users);
                const staffIds = new Set();
                for (const u of data.users ?? [])
                    if (isStaffUser(u))
                        staffIds.add(u.id);
                for (const t of topics) {
                    const opUserId = t.posters?.[0]?.user_id;
                    if (opUserId !== undefined && !staffIds.has(opUserId))
                        continue;
                    const item = topicToNewsItem(t, userMap, label);
                    if (item)
                        items.push(item);
                }
            }
            catch (e) {
                ctx.logger.debug("announcement feed fetch failed", {
                    url,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
        await fetchCategoryFeed(URLS.announcementsCategory, "Announcements");
        try {
            const parent = await ctx.http.getJson(URLS.updatesCategory);
            const subs = parent.category_list?.categories ?? [];
            for (const sub of subs) {
                if (sub.id === 26)
                    continue;
                const url = `${URLS.devforum}/c/updates/${sub.slug}/${sub.id}.json`;
                await fetchCategoryFeed(url, sub.slug);
                if (items.length >= limit * 3)
                    break;
            }
        }
        catch (e) {
            ctx.logger.debug("updates parent listing failed", {
                error: e instanceof Error ? e.message : String(e),
            });
        }
        return items;
    }
    server.registerTool("roblox_news", {
        title: "Roblox News & Release Notes",
        description: "Aggregates official Roblox news: Creator Hub Release Notes (versioned, structured into New Features / Improvements / Fixes / Removed) and DevForum Announcements posted by Roblox staff. Filterable by date window, source, and query. Use this to know what changed recently before generating Roblox code.",
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
            const since = await resolveSince(input.since, latestReleaseDate);
            const wantReleases = input.source === "release_notes" || input.source === "all";
            const wantAnnouncements = input.source === "announcements" || input.source === "all";
            const collected = [];
            const sources = [];
            if (wantReleases) {
                const releases = await fetchReleaseNotes(input.limit);
                collected.push(...releases);
                sources.push(URLS.releaseNotesIndex);
            }
            if (wantAnnouncements) {
                const announcements = await fetchAnnouncements(input.limit);
                collected.push(...announcements);
                sources.push(URLS.announcementsCategory);
            }
            const filtered = dedupeNewsItems(collected)
                .filter((i) => withinSince(i, since))
                .filter((i) => matchesQuery(i, input.query))
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, input.limit);
            const text = [
                `# Roblox News (since ${since.toISOString().slice(0, 10)})`,
                "",
                formatNewsList(filtered),
            ].join("\n");
            return ok(text, {
                items: filtered,
                total: filtered.length,
                source: sources.join(", "),
            });
        }
        catch (e) {
            return fail(e);
        }
    });
}
export { renderReleaseNoteMarkdown };
//# sourceMappingURL=news.js.map