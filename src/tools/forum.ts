/** DevForum tools: search, bug lookup, thread reading, category listings. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUG_PARENT,
  CATEGORIES,
  categoryName,
  getPostsByIds,
  getTopic,
  listCategories,
  listTags,
  listTopics,
  search,
  topicUrl,
  type CategorySlug,
  type SearchOptions,
  type RawPost,
  type RawTopic,
} from "../discourse.js";
import { decodeEntities, htmlToMarkdown, relativeDate, truncate } from "../format.js";
import { bugStatus, mergeResults, rank } from "../rank.js";
import { ok, fail, toToolError, parseTopicId } from "./util.js";

const CATEGORY_SLUGS = Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>;
const categoryEnum = z.enum(CATEGORY_SLUGS as [string, ...string[]]);

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

function topicLine(index: number, topic: RawTopic, post?: RawPost, matchedBy?: string[]): string {
  const status = bugStatus(topic);
  const badge = status ? `[${status}] ` : "";
  const meta = [
    `#${categoryName(topic.category_id)}`,
    `${topic.like_count ?? 0} likes`,
    `${topic.reply_count ?? Math.max((topic.posts_count ?? 1) - 1, 0)} replies`,
    relativeDate(topic.bumped_at ?? topic.last_posted_at ?? topic.created_at),
  ];
  if (topic.tags?.length) meta.push(topic.tags.slice(0, 4).join(", "));
  if (matchedBy && matchedBy.length > 1) meta.push(`matched ${matchedBy.length} phrasings`);

  const blurb = post?.blurb ? `\n   ${decodeEntities(post.blurb).replace(/\s+/g, " ").slice(0, 260)}` : "";
  return [
    `${index}. ${badge}${topic.title}`,
    `   ${meta.join(" · ")}`,
    `   ${topicUrl(topic.id, topic.slug)}  (topic_id: ${topic.id})`,
    blurb,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Discourse's bot posts ("This topic was automatically closed…") never help a debugging agent. */
export function isAutomated(post: RawPost): boolean {
  if (post.username !== "system") return false;
  return /automatically closed|automatically deleted/i.test(post.cooked ?? "");
}

function renderPost(post: RawPost, topic: RawTopic, budget: number): string {
  const author = post.username ?? post.name ?? "unknown";
  const role = post.staff || post.admin || post.moderator ? " (Roblox staff)" : "";
  const accepted = post.accepted_answer ? " ✅ ACCEPTED ANSWER" : "";
  const likes = post.actions_summary?.find((a) => a.id === 2)?.count ?? 0;
  const header = `--- #${post.post_number} by ${author}${role}${accepted} · ${relativeDate(post.created_at)}${likes ? ` · ${likes} likes` : ""}`;
  const body = htmlToMarkdown(post.cooked ?? "");
  const url = topicUrl(topic.id, topic.slug, post.post_number);
  return `${header}\n${truncate(body, budget, `open ${url}`)}`;
}

const querySchema = z
  .union([z.string().min(2), z.array(z.string().min(2)).min(1).max(5)])
  .describe(
    "Search text, or an array of up to 5 phrasings run in parallel and merged. Multiple phrasings are the fast way to cover a problem: [\"DataStore 502\", \"API Services rejected request\", \"datastore timeout\"]. Topics found by more than one phrasing rank highest.",
  );

/** Run every phrasing at once and merge, so one tool call covers a whole line of enquiry. */
async function runQueries(
  queries: string[],
  base: Omit<SearchOptions, "query">,
): Promise<{ topics: RawTopic[]; posts: RawPost[]; matchedBy: Map<number, string[]> }> {
  const sets = await Promise.all(
    queries.map(async (query) => ({ query, ...(await search({ ...base, query })) })),
  );
  return mergeResults(sets);
}

const asList = (q: string | string[]): string[] => (Array.isArray(q) ? [...new Set(q)] : [q]);

export function registerForumTools(server: McpServer): void {
  server.registerTool(
    "search_devforum",
    {
      title: "Search the Roblox DevForum",
      description:
        "Full-text search across the Roblox Developer Forum. Use this first when a Roblox bug, error message, or engine behaviour needs community context: paste the literal error string (e.g. \"502: API Services rejected request\") or a symptom description. Results are re-ranked to favour solved and recent threads. Follow up with get_thread on the topic_id you want to read.",
      inputSchema: {
        query: querySchema,
        category: categoryEnum.optional().describe("Restrict to one category slug, e.g. scripting-support, engine-bugs, release-notes."),
        tags: z.array(z.string()).max(5).optional().describe("Restrict to DevForum tags, e.g. [\"datastore\"]."),
        solved_only: z.boolean().default(false).describe("Only threads with an accepted answer."),
        min_likes: z.number().int().min(0).max(500).optional().describe("Minimum likes on a matching post."),
        after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only threads active after this date (YYYY-MM-DD)."),
        order: z.enum(["relevance", "latest", "likes", "views"]).default("relevance"),
        limit: z.number().int().min(1).max(25).default(8),
        max_tokens: z.number().int().min(200).max(8000).default(2500).describe("Approximate output budget."),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const queries = asList(args.query);
        const { topics, posts, matchedBy } = await runQueries(queries, {
          category: args.category,
          tags: args.tags,
          solvedOnly: args.solved_only,
          minLikes: args.min_likes,
          after: args.after,
          order: args.order,
        });
        const label = queries.map((q) => `"${q}"`).join(" / ");
        if (topics.length === 0) {
          return ok(`No DevForum threads matched ${label}. Try fewer words, the raw error text, or drop the filters.`);
        }
        const ranked = rank(topics, posts, args.order !== "relevance").slice(0, args.limit);
        const body = ranked
          .map((r, i) => topicLine(i + 1, r.topic, r.post, queries.length > 1 ? matchedBy.get(r.topic.id) : undefined))
          .join("\n\n");
        const head = `${ranked.length} DevForum threads for ${label}${queries.length > 1 ? ` (${queries.length} phrasings merged)` : ""}:`;
        return ok(truncate(`${head}\n\n${body}`, args.max_tokens, "narrow the query"));
      } catch (err) {
        return toToolError("search_devforum failed", err);
      }
    },
  );

  server.registerTool(
    "search_bugs",
    {
      title: "Search Roblox bug reports",
      description:
        "Search only the DevForum bug-report categories (engine, Studio, cloud services, mobile, website, Creator Hub, purchasing). Use this to answer \"is this a known Roblox bug or is it my code?\" — results carry the staff status tag (confirmed / fixed / cannot-reproduce) and last-activity date.",
      inputSchema: {
        query: querySchema,
        area: categoryEnum.optional().describe("Narrow to a single bug category, e.g. engine-bugs or studio-bugs."),
        after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only reports active after this date (YYYY-MM-DD)."),
        limit: z.number().int().min(1).max(25).default(8),
        max_tokens: z.number().int().min(200).max(8000).default(2500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const queries = asList(args.query);
        const { topics, posts, matchedBy } = await runQueries(queries, {
          category: args.area ?? BUG_PARENT,
          after: args.after,
        });
        const label = queries.map((q) => `"${q}"`).join(" / ");
        if (topics.length === 0) {
          return ok(
            `No bug reports matched ${label}. That often means it is not a known engine bug — try search_devforum for scripting-support threads, or search_creator_docs for expected behaviour.`,
          );
        }
        const ranked = rank(topics, posts).slice(0, args.limit);
        const body = ranked
          .map((r, i) => topicLine(i + 1, r.topic, r.post, queries.length > 1 ? matchedBy.get(r.topic.id) : undefined))
          .join("\n\n");
        const header = `${ranked.length} bug reports for ${label} (status tag shown in brackets when Roblox staff triaged it):`;
        return ok(truncate(`${header}\n\n${body}`, args.max_tokens, "narrow the query"));
      } catch (err) {
        return toToolError("search_bugs failed", err);
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a DevForum thread",
      description:
        "Read a DevForum topic as Markdown: the original post plus the most useful replies, with the accepted answer hoisted to the top. Accepts a topic id or a full DevForum URL. Code blocks are preserved. Use get_replies to page through the rest.",
      inputSchema: {
        topic: z.union([z.number().int(), z.string()]).describe("Topic id (e.g. 3665478) or DevForum URL."),
        max_posts: z.number().int().min(1).max(30).default(8).describe("How many posts to include."),
        max_tokens: z.number().int().min(300).max(12000).default(3500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const topicId = parseTopicId(args.topic);
      if (topicId === undefined) return fail(`Could not read a topic id from "${args.topic}".`);
      try {
        const topic = await getTopic(topicId);
        const all = topic.post_stream?.posts ?? [];
        if (all.length === 0) return fail(`Topic ${topicId} has no readable posts (it may be private).`);

        const first = all[0];
        const accepted = all.find((p) => p.accepted_answer && p.post_number !== first?.post_number);
        const rest = all
          .filter((p) => p !== first && p !== accepted && !isAutomated(p))
          .sort((a, b) => {
            const likes = (p: RawPost) => p.actions_summary?.find((x) => x.id === 2)?.count ?? 0;
            const staff = (p: RawPost) => (p.staff || p.admin || p.moderator ? 1 : 0);
            return staff(b) - staff(a) || likes(b) - likes(a) || a.post_number - b.post_number;
          });

        const chosen = [first, accepted, ...rest].filter((p): p is RawPost => Boolean(p)).slice(0, args.max_posts);
        const perPost = Math.max(Math.floor(args.max_tokens / Math.max(chosen.length, 1)), 120);

        const status = bugStatus(topic);
        const head = [
          `# ${topic.title}`,
          [
            `#${categoryName(topic.category_id)}`,
            status ? `status: ${status}` : undefined,
            `${topic.like_count ?? 0} likes`,
            `${topic.posts_count ?? all.length} posts`,
            `${topic.views ?? 0} views`,
            `created ${relativeDate(topic.created_at)}`,
            `last reply ${relativeDate(topic.last_posted_at ?? topic.bumped_at)}`,
          ]
            .filter(Boolean)
            .join(" · "),
          topic.tags?.length ? `tags: ${topic.tags.join(", ")}` : undefined,
          topicUrl(topicId, topic.slug),
        ]
          .filter(Boolean)
          .join("\n");

        const stream = topic.post_stream?.stream ?? [];
        const footer =
          stream.length > chosen.length
            ? `\n\n(${stream.length - chosen.length} more replies — use get_replies with topic_id ${topicId}.)`
            : "";

        const body = chosen.map((p) => renderPost(p, topic, perPost)).join("\n\n");
        return ok(`${head}\n\n${body}${footer}`);
      } catch (err) {
        return toToolError(`get_thread(${topicId}) failed`, err);
      }
    },
  );

  server.registerTool(
    "get_replies",
    {
      title: "Page through thread replies",
      description:
        "Fetch a page of replies from a DevForum topic in post order. Use after get_thread when the answer is buried further down a long thread.",
      inputSchema: {
        topic: z.union([z.number().int(), z.string()]).describe("Topic id or DevForum URL."),
        page: z.number().int().min(1).default(1).describe("1-based page of replies."),
        limit: z.number().int().min(1).max(20).default(10),
        max_tokens: z.number().int().min(300).max(12000).default(3000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const topicId = parseTopicId(args.topic);
      if (topicId === undefined) return fail(`Could not read a topic id from "${args.topic}".`);
      try {
        const topic = await getTopic(topicId);
        const stream = topic.post_stream?.stream ?? [];
        if (stream.length === 0) return fail(`Topic ${topicId} exposes no post stream.`);

        const start = (args.page - 1) * args.limit;
        const ids = stream.slice(start, start + args.limit);
        if (ids.length === 0) {
          return ok(`Page ${args.page} is past the end of topic ${topicId} (${stream.length} posts total).`);
        }

        const cached = topic.post_stream?.posts ?? [];
        const missing = ids.filter((id) => !cached.some((p) => p.id === id));
        const fetched = missing.length ? await getPostsByIds(topicId, missing) : [];
        const byId = new Map([...cached, ...fetched].map((p) => [p.id, p]));
        const posts = ids.map((id) => byId.get(id)).filter((p): p is RawPost => Boolean(p));

        const perPost = Math.max(Math.floor(args.max_tokens / Math.max(posts.length, 1)), 120);
        const body = posts.map((p) => renderPost(p, topic, perPost)).join("\n\n");
        const total = Math.ceil(stream.length / args.limit);
        return ok(`${topic.title} — replies page ${args.page}/${total}\n\n${body}`);
      } catch (err) {
        return toToolError(`get_replies(${topicId}) failed`, err);
      }
    },
  );

  server.registerTool(
    "list_recent",
    {
      title: "List recent or top DevForum topics",
      description:
        "Browse a category or tag without a search query. Use release-notes / announcements to check whether a recent Roblox update explains a regression, or scripting-support to see what is breaking for others right now.",
      inputSchema: {
        category: categoryEnum.optional().describe("Category slug, e.g. release-notes, announcements, engine-bugs."),
        tag: z.string().optional().describe("Tag name instead of a category, e.g. datastore."),
        listing: z.enum(["latest", "top"]).default("latest"),
        period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly", "all"]).default("monthly").describe("Only used when listing is \"top\"."),
        limit: z.number().int().min(1).max(30).default(10),
        max_tokens: z.number().int().min(200).max(8000).default(2000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const topics = await listTopics(args.listing, args.category as CategorySlug | undefined, args.tag, args.period);
        if (topics.length === 0) return ok("No topics found for that category or tag.");
        const chosen = topics.slice(0, args.limit);
        const scope = args.tag ? `tag:${args.tag}` : args.category ? `#${args.category}` : "the whole forum";
        const body = chosen.map((t, i) => topicLine(i + 1, t)).join("\n\n");
        return ok(truncate(`${args.listing} topics in ${scope}:\n\n${body}`, args.max_tokens, "lower limit"));
      } catch (err) {
        return toToolError("list_recent failed", err);
      }
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List DevForum categories and tags",
      description:
        "List the DevForum category tree and the most-used tags. Call this when you are unsure which category or tag slug to pass to search_devforum, search_bugs, or list_recent.",
      inputSchema: {
        include_tags: z.boolean().default(true),
        tag_limit: z.number().int().min(5).max(100).default(40),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const categories = await listCategories();
        const tree = categories
          .map((c) => {
            const subs = c.subcategories.map((s) => `    - ${s.slug} (${s.id})`).join("\n");
            return `- ${c.slug} (${c.id})${subs ? `\n${subs}` : ""}`;
          })
          .join("\n");
        let out = `DevForum categories (slug and id):\n${tree}`;
        if (args.include_tags) {
          const tags = await listTags();
          out += `\n\nMost-used tags:\n${tags.slice(0, args.tag_limit).map((t) => `${t.name} (${t.count})`).join(", ")}`;
        }
        return ok(out);
      } catch (err) {
        return toToolError("list_categories failed", err);
      }
    },
  );
}
