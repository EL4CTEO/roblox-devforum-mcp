import * as z from "zod";
import { URLS } from "../config.js";
import { buildSearchUserMap, toForumHit } from "../lib/discourse.js";
import { LUAU_LIBRARY_NAMES, extractNextData, findLuauSection, flattenDocBody, parseDuckDuckGoSiteResults, } from "../lib/htmlParse.js";
import { fail, ok } from "../lib/responses.js";
import { stripHtml } from "../lib/sanitize.js";
import { sortByRelevance } from "../lib/scoring.js";
const Source = z.enum(["creator", "luau", "community", "auto"]);
const inputShape = {
    source: Source.default("auto").describe("Where to look: 'creator' (Creator Hub docs page), 'luau' (Luau stdlib library), 'community' (DevForum tutorials/resources), 'auto' (creator + community)."),
    query: z
        .string()
        .optional()
        .describe("Search keywords. Required for 'community'/'auto', optional for 'creator' (when path not provided)."),
    path: z
        .string()
        .optional()
        .describe("Creator Hub doc path (e.g. 'docs/reference/engine/classes/BasePart'). Required for source='creator' direct fetch."),
    module: z
        .string()
        .optional()
        .describe("Luau stdlib module name (math, string, table, coroutine, bit32, utf8, os, debug, buffer, vector). Required for source='luau'."),
    limit: z.number().int().min(1).max(20).default(10).describe("Max results."),
};
const outputShape = {
    source: z.string(),
    url: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    results: z
        .array(z.object({
        title: z.string(),
        url: z.string(),
        author: z.string().optional(),
        excerpt: z.string().optional(),
    }))
        .optional(),
};
function extractJsxText(code) {
    const parts = [];
    const re = /children:(?:\[)?\s*["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const text = (m[1] ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').trim();
        if (text && text.length > 1)
            parts.push(text);
    }
    return parts.join("\n");
}
async function fetchCreatorPage(ctx, path) {
    let cleanPath = path.replace(/^\/+/, "");
    if (!cleanPath.startsWith("docs/"))
        cleanPath = `docs/${cleanPath}`;
    const url = `${URLS.creatorDocs.replace(/\/docs$/, "")}/${cleanPath}`;
    const html = await ctx.http.getHtml(url);
    const next = extractNextData(html);
    if (next) {
        const pageProps = next.props?.pageProps;
        const doc = pageProps?.doc ??
            pageProps?.data;
        if (doc) {
            const title = String(doc.title ?? doc.name ?? cleanPath);
            let content = "";
            if (doc.description)
                content += `${doc.description}\n\n`;
            if (doc.body) {
                content += flattenDocBody(doc.body);
            }
            else if (doc.content) {
                const c = doc.content;
                if (typeof c === "string") {
                    if (c.startsWith("var Component=") || c.includes("_jsx_runtime")) {
                        content += extractJsxText(c);
                    }
                    else {
                        content += stripHtml(c);
                    }
                }
                else {
                    content += flattenDocBody(c);
                }
            }
            if (content.trim())
                return { url, title, content: content.trim().slice(0, 8000) };
        }
    }
    return {
        url,
        title: cleanPath,
        content: stripHtml(html).slice(0, 4000),
    };
}
async function searchCreatorViaForum(ctx, query, limit) {
    const data = await ctx.http.getJson(`${URLS.devforum}/search.json?q=${encodeURIComponent(`${query} category:resources order:latest`)}`);
    const topics = sortByRelevance(data.topics ?? []);
    const userMap = buildSearchUserMap(data);
    return topics.slice(0, limit).map((t) => {
        const hit = toForumHit(t, userMap);
        const out = {
            title: hit.title,
            url: hit.url,
        };
        if (hit.author)
            out.author = hit.author;
        if (hit.excerpt)
            out.excerpt = hit.excerpt;
        return out;
    });
}
async function searchCreatorViaDuckDuckGo(ctx, query, limit) {
    const url = `${URLS.searchEngine}/?q=${encodeURIComponent(query)}+site%3Acreate.roblox.com%2Fdocs`;
    try {
        const html = await ctx.http.getHtml(url);
        return parseDuckDuckGoSiteResults(html).slice(0, limit);
    }
    catch {
        return [];
    }
}
async function searchCommunity(ctx, query, limit) {
    const data = await ctx.http.getJson(`${URLS.devforum}/search.json?q=${encodeURIComponent(`${query} #resources order:latest`)}`);
    const topics = sortByRelevance(data.topics ?? []);
    const userMap = buildSearchUserMap(data);
    return topics.slice(0, limit).map((t) => {
        const hit = toForumHit(t, userMap);
        const out = {
            title: hit.title,
            url: hit.url,
        };
        if (hit.author)
            out.author = hit.author;
        if (hit.excerpt)
            out.excerpt = hit.excerpt;
        return out;
    });
}
function renderLuau(library, html) {
    const section = findLuauSection(html, library);
    if (!section.found) {
        return `Library "${library}" not found. Available: ${section.available.join(", ")}.`;
    }
    const text = stripHtml(section.text);
    const matches = [
        ...text.matchAll(/function\s+([\w.]+)\(([^)]*)\)\s*(?::\s*([^\s,][^\n]*?))?\s*$/gim),
    ];
    let out = `# Luau ${library} library\n\n`;
    for (const m of matches) {
        const sig = m[3]?.trim() ?? "";
        out += `- **${m[1]}**(${m[2]})${sig ? `: ${sig}` : ""}\n`;
    }
    if (matches.length === 0)
        out += text.slice(0, 3000);
    return out;
}
export function register(server, ctx) {
    server.registerTool("roblox_docs", {
        title: "Roblox Documentation",
        description: "Fetch or search Roblox docs across Creator Hub, Luau standard library, and community DevForum tutorials. Replaces 'get_creator_docs' + 'search_creator_docs' + 'get_luau_docs' + 'search_community_resources'.",
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
            if (input.source === "luau") {
                const lib = input.module ?? input.query;
                if (!lib)
                    return fail(new Error(`module is required for source='luau'. Available: ${LUAU_LIBRARY_NAMES.join(", ")}`));
                const html = await ctx.http.getHtml(`${URLS.luauLang}/library`);
                const text = renderLuau(lib, html);
                return ok(text, {
                    source: "luau",
                    url: `${URLS.luauLang}/library`,
                    title: `Luau ${lib} library`,
                    content: text,
                });
            }
            if (input.source === "creator" && input.path) {
                const { url, title, content } = await fetchCreatorPage(ctx, input.path);
                return ok(`# ${title}\n\n${content}`, {
                    source: "creator",
                    url,
                    title,
                    content,
                });
            }
            if (!input.query) {
                return fail(new Error("query is required (or path/module for direct lookup)."));
            }
            const results = [];
            if (input.source === "creator" || input.source === "auto") {
                const fromForum = await searchCreatorViaForum(ctx, input.query, input.limit);
                results.push(...fromForum);
                const ddg = await searchCreatorViaDuckDuckGo(ctx, input.query, input.limit);
                for (const r of ddg) {
                    if (!results.some((x) => x.url === r.url))
                        results.push(r);
                }
            }
            if (input.source === "community" ||
                (input.source === "auto" && results.length < input.limit)) {
                const community = await searchCommunity(ctx, input.query, input.limit);
                for (const r of community) {
                    if (!results.some((x) => x.url === r.url))
                        results.push(r);
                }
            }
            const limited = results.slice(0, input.limit);
            if (limited.length === 0) {
                return ok(`No results for "${input.query}".`, {
                    source: input.source,
                    results: [],
                });
            }
            const text = limited
                .map((r) => `• ${r.title}${r.author ? ` (by ${r.author})` : ""}\n  ${r.url}${r.excerpt ? `\n  ${r.excerpt}` : ""}`)
                .join("\n\n");
            return ok(`Roblox docs for "${input.query}":\n\n${text}`, {
                source: input.source,
                results: limited,
            });
        }
        catch (e) {
            return fail(e);
        }
    });
}
//# sourceMappingURL=robloxDocs.js.map