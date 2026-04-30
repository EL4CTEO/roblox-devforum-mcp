import * as z from "zod";
import { URLS } from "../config.js";
import { fail, ok } from "../lib/responses.js";
const AssetType = z.enum([
    "Models",
    "Audio",
    "Meshes",
    "Plugins",
    "Decals",
    "Animations",
    "Badges",
]);
const CATEGORY_MAP = {
    Models: "Models",
    Audio: "Audio",
    Meshes: "Meshes",
    Plugins: "Plugins",
    Decals: "Decals",
    Animations: "Animations",
    Badges: "Badges",
};
function toCatalogCategory(assetType) {
    const map = {
        Models: 11,
        Audio: 13,
        Meshes: 40,
        Plugins: 12,
        Decals: 4,
        Animations: 24,
        Badges: 21,
    };
    return map[assetType] ?? 11;
}
const inputShape = {
    query: z.string().describe("Asset name or keyword."),
    asset_type: AssetType.default("Models").describe("Asset category."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results."),
    include_details: z
        .boolean()
        .default(true)
        .describe("Fetch per-asset economy details (price, creator). Slower."),
};
const Asset = z.object({
    id: z.number(),
    name: z.string(),
    creator: z.string(),
    price: z.string(),
    url: z.string(),
    description: z.string().optional(),
    thumbnailUrl: z.string().optional(),
});
const outputShape = {
    query: z.string(),
    assetType: z.string(),
    results: z.array(Asset),
    warning: z.string().optional(),
};
const VALID_LIMITS = [10, 28, 30, 50, 60, 100, 120];
function normalizeLimit(n) {
    const exact = VALID_LIMITS.includes(n);
    const value = VALID_LIMITS.find((v) => v >= n) ?? 10;
    return { value, normalized: !exact };
}
function formatPrice(p) {
    if (p === undefined)
        return "N/A";
    if (p === null)
        return "N/A";
    if (p === 0)
        return "Free";
    return `R$${p}`;
}
export function register(server, ctx) {
    server.registerTool("creator_store", {
        title: "Search Roblox Creator Store",
        description: "Search Roblox catalog (models, plugins, audio, meshes, decals, animations, badges). Returns asset id, name, creator, price.",
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
            const norm = normalizeLimit(Math.min(input.limit, 30));
            const categoryId = toCatalogCategory(input.asset_type);
            const searchUrl = `${URLS.creatorStore}/v1/search/items?Category=${categoryId}&SortType=Relevance&Limit=${norm.value}&Keyword=${encodeURIComponent(input.query)}`;
            const search = await ctx.http.getJson(searchUrl);
            const ids = (search.data ?? [])
                .filter((i) => i.itemType === "Asset")
                .slice(0, input.limit)
                .map((i) => i.id);
            let assets = [];
            if (input.include_details && ids.length > 0) {
                const fetched = await Promise.all(ids.map(async (id) => {
                    try {
                        return await ctx.http.getJson(`https://economy.roblox.com/v2/assets/${id}/details`);
                    }
                    catch (e) {
                        ctx.logger.debug("creator_store: asset details failed", {
                            id,
                            error: e instanceof Error ? e.message : String(e),
                        });
                        return null;
                    }
                }));
                assets = fetched.filter((a) => a !== null);
            }
            else {
                assets = ids.map((id) => ({ AssetId: id }));
            }
            const results = assets.map((a) => ({
                id: a.AssetId,
                name: a.Name ?? "Untitled",
                creator: a.Creator?.Name ?? "unknown",
                price: formatPrice(a.PriceInRobux),
                url: `https://www.roblox.com/library/${a.AssetId}`,
                description: a.Description ?? undefined,
                thumbnailUrl: a.ThumbnailUrl ?? undefined,
            }));
            if (results.length === 0) {
                return ok(`No results for "${input.query}" in ${input.asset_type}.`, {
                    query: input.query,
                    assetType: input.asset_type,
                    results: [],
                });
            }
            const text = results
                .map((r) => `• ${r.name}${r.description ? `\n  ${r.description.slice(0, 120)}` : ""}\n  ID: ${r.id} | Creator: ${r.creator} | Price: ${r.price}${r.thumbnailUrl ? `\n  ${r.thumbnailUrl}` : ""}\n  ${r.url}`)
                .join("\n\n");
            const structured = {
                query: input.query,
                assetType: input.asset_type,
                results,
            };
            if (norm.normalized) {
                structured.warning = `limit normalized from ${input.limit} to ${norm.value} (Roblox catalog only accepts ${VALID_LIMITS.join(", ")})`;
            }
            return ok(`Creator Store results for "${input.query}":\n\n${text}`, structured);
        }
        catch (e) {
            return fail(e);
        }
    });
}
//# sourceMappingURL=creatorStore.js.map