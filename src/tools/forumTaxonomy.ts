import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { URLS } from "../config.js";
import type { AppContext } from "../context.js";
import { fail, ok } from "../lib/responses.js";
import { stripHtml } from "../lib/sanitize.js";

const Kind = z.enum(["categories", "tags", "category_meta"]);

const inputShape = {
  kind: Kind.describe(
    "What to list: 'categories' (all forum categories), 'tags' (top tags by use), 'category_meta' (one category's metadata)."
  ),
  category_id: z.number().int().optional().describe("Required when kind='category_meta'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Max items returned (for 'tags' and 'categories')."),
};

const outputShape = {
  kind: z.string(),
  items: z.array(
    z.object({
      id: z.number().optional(),
      slug: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      topicCount: z.number().optional(),
      postCount: z.number().optional(),
      subcategories: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            topicCount: z.number().optional(),
          })
        )
        .optional(),
      moderators: z.array(z.string()).optional(),
    })
  ),
};

interface Input {
  kind: z.infer<typeof Kind>;
  category_id?: number;
  limit: number;
}

interface CategoryRaw {
  id: number;
  slug?: string;
  name: string;
  description_text?: string;
  description?: string;
  topic_count?: number;
  post_count?: number;
  parent_category_id?: number | null;
  subcategory_ids?: number[];
  moderators?: { username: string }[];
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "forum_taxonomy",
    {
      title: "DevForum Taxonomy",
      description:
        "List DevForum categories or tags, or fetch metadata for a single category. Replaces 'get_categories' + 'get_tags' + 'get_category_metadata'.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (raw): Promise<ReturnType<typeof ok>> => {
      const input = raw as Input;
      try {
        if (input.kind === "categories") {
          const data = await ctx.http.getJson<{
            category_list?: { categories: CategoryRaw[] };
          }>(`${URLS.devforum}/categories.json`);
          const cats = data.category_list?.categories ?? [];
          let siteCats: Map<number, CategoryRaw> | undefined;
          try {
            const site = await ctx.http.getJson<{ categories: CategoryRaw[] }>(
              `${URLS.devforum}/site.json`
            );
            siteCats = new Map(site.categories.map((c) => [c.id, c]));
          } catch {
            // optional
          }
          const items = cats.slice(0, input.limit).map((c) => {
            let topicCount = c.topic_count ?? 0;
            if ((!topicCount || topicCount === 0) && siteCats) {
              const subs = [...siteCats.values()].filter((s) => s.parent_category_id === c.id);
              topicCount = subs.reduce((sum, s) => sum + (s.topic_count ?? 0), 0);
            }
            const item: Record<string, unknown> = {
              id: c.id,
              slug: c.slug ?? "",
              name: c.name,
              topicCount,
            };
            if (c.description_text) {
              item.description = c.description_text.slice(0, 200);
            }
            return item;
          });
          const text = items
            .map(
              (c) =>
                `• ${c.name} (ID: ${c.id}, slug: ${c.slug}) — ${c.topicCount} topics${c.description ? `\n  ${c.description}` : ""}`
            )
            .join("\n");
          return ok(`DevForum Categories:\n\n${text}`, {
            kind: "categories",
            items,
          });
        }

        if (input.kind === "tags") {
          const data = await ctx.http.getJson<{
            tags: { name: string; count: number }[];
          }>(`${URLS.devforum}/tags.json`);
          const sorted = [...(data.tags ?? [])]
            .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
            .slice(0, input.limit);
          const items = sorted.map((t) => ({
            name: t.name,
            topicCount: t.count,
          }));
          const text = items.map((t) => `• ${t.name} (${t.topicCount} topics)`).join("\n");
          return ok(`DevForum Tags (top ${items.length}):\n\n${text}`, {
            kind: "tags",
            items,
          });
        }

        // category_meta
        if (input.category_id === undefined) {
          return fail(new Error("category_id is required when kind='category_meta'"));
        }
        const id = input.category_id;
        let categoryData: {
          category: CategoryRaw;
          subcategory_list?: { categories: CategoryRaw[] } | undefined;
        } | null = null;

        const endpoints = [`${URLS.devforum}/c/${id}/show.json`, `${URLS.devforum}/c/${id}.json`];

        for (const url of endpoints) {
          try {
            const raw = await ctx.http.getJson<
              | CategoryRaw
              | {
                  category: CategoryRaw;
                  subcategory_list?: { categories: CategoryRaw[] };
                  topic_list?: { topics: unknown[] };
                }
            >(url);
            if (!raw) continue;

            const cat = (raw as { category?: CategoryRaw }).category ?? (raw as CategoryRaw);
            if (cat && typeof cat.id === "number" && typeof cat.name === "string") {
              categoryData = {
                category: cat as CategoryRaw,
                subcategory_list: (raw as { subcategory_list?: { categories: CategoryRaw[] } })
                  .subcategory_list,
              };
              break;
            }
          } catch {
            // try next endpoint
          }
        }

        if (!categoryData?.category) {
          return fail(
            new Error(
              `Category ${id} not found. Try listing categories first with kind='categories' to find valid IDs.`
            )
          );
        }

        const data = categoryData;
        const c = data.category;
        let subs = data.subcategory_list?.categories ?? [];
        let topicCount = c.topic_count ?? 0;
        let postCount = c.post_count ?? 0;
        if (!topicCount || (subs.length === 0 && (c.subcategory_ids?.length ?? 0) > 0)) {
          try {
            const site = await ctx.http.getJson<{ categories: CategoryRaw[] }>(
              `${URLS.devforum}/site.json`
            );
            const all = site.categories;
            if (subs.length === 0) {
              subs = all.filter((s) => s.parent_category_id === c.id);
            }
            if (!topicCount && subs.length > 0) {
              topicCount = subs.reduce((s, x) => s + (x.topic_count ?? 0), 0);
              postCount = subs.reduce((s, x) => s + (x.post_count ?? 0), 0);
            }
          } catch {
            // optional
          }
        }

        const item: Record<string, unknown> = {
          id: c.id,
          slug: c.slug ?? "",
          name: c.name,
          description: c.description ? stripHtml(c.description) : undefined,
          topicCount,
          postCount,
          subcategories: subs.map((s) => {
            const sub: Record<string, unknown> = { id: s.id, name: s.name };
            if (typeof s.topic_count === "number") sub.topicCount = s.topic_count;
            return sub;
          }),
          moderators: (c.moderators ?? []).map((m) => m.username),
        };

        let text = `Category: ${c.name} (ID: ${c.id})\n`;
        text += `Slug: ${c.slug ?? ""}\n`;
        if (c.description) text += `Description: ${stripHtml(c.description)}\n`;
        text += `Topics: ${topicCount}\n`;
        text += `Posts: ${postCount}\n`;
        if (subs.length > 0) {
          text += `Subcategories: ${subs.map((s) => `${s.name} (ID: ${s.id}, ${s.topic_count ?? 0} topics)`).join(", ")}\n`;
        }
        if (c.moderators?.length) {
          text += `Moderators: ${c.moderators.map((m) => m.username).join(", ")}\n`;
        }

        return ok(text.trim(), { kind: "category_meta", items: [item] });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
