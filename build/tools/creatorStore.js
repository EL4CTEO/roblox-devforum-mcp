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
const ASSET_TYPE_IDS = {
    Models: 10,
    Audio: 3,
    Meshes: 34,
    Plugins: 12,
    Decals: 13,
    Animations: 24,
    Badges: 21,
};
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
            const assetTypeId = ASSET_TYPE_IDS[input.asset_type];
            const mustFilter = assetTypeId !== 10;
            const searchLimit = mustFilter ? 50 : norm.value;
            const searchUrl = `${URLS.creatorStore}/v1/search/items?SortType=Relevance&Limit=${searchLimit}&Keyword=${encodeURIComponent(input.query)}`;
            const search = await ctx.http.getJson(searchUrl);
            const allItems = search.data ?? [];
            const ids = allItems
                .filter((i) => i.itemType === "Asset")
                .map((i) => i.id);
            const needDetails = input.include_details || mustFilter;
            let assets = [];
            if (needDetails && ids.length > 0) {
                const overfetch = mustFilter ? Math.min(ids.length + 10, 50) : ids.length;
                const detailIds = ids.slice(0, overfetch);
                const fetched = await Promise.all(detailIds.map(async (id) => {
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
                let filtered = fetched.filter((a) => a !== null);
                if (mustFilter) {
                    filtered = filtered.filter((a) => a.AssetTypeId === assetTypeId);
                }
                assets = filtered.slice(0, input.limit);
            }
            else {
                assets = ids.slice(0, input.limit).map((id) => ({ AssetId: id }));
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