/** DevForum tools: search, bug lookup, thread reading, category listings. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUG_PARENT,
  bugAreas,
  DEFAULT_SLUGS,
  categoryName,
  ensureCategories,
  getPostsByIds,
  getTopic,
  listCategories,
  listTags,
  listTopics,
  resolveCategory,
  search,
  suggestCategories,
  topicUrl,
  type CategorySlug,
  type SearchOptions,
  type RawPost,
  type RawTopic,
} from "../discourse.js";
import { decodeEntities, htmlToMarkdown, relativeDate, truncate } from "../format.js";
import { bugStatus, FILLER, likesOf, mergeResults, rank } from "../rank.js";
import { ok, fail, toToolError, parseTopicId } from "./util.js";

/**
 * A plain string, not an enum: the ids and the tree come from the forum at runtime, so a
 * category Roblox adds has to be usable the day it appears rather than the next release.
 * The slug is checked against the resolved tree instead, which gives a better error too.
 */
const categorySchema = z.string().min(2);
const SLUG_LIST = DEFAULT_SLUGS.join(", ");

/** Validate a caller-supplied slug against the live tree; returns the canonical slug. */
async function resolveSlug(
  slug: string | undefined,
): Promise<{ slug?: string; error?: string }> {
  if (!slug) return {};
  await ensureCategories();
  const found = resolveCategory(slug);
  if (found) return { slug: found.slug };
  const near = suggestCategories(slug);
  return {
    error: `Unknown category "${slug}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} Call list_categories for the current list.`,
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

/**
 * Every search result line ends with "(topic_id: 3665478)", so a model reading one reaches
 * for `topic_id` — and used to get a validation error from the tool that printed it. Both
 * spellings are accepted; `topic` stays the documented one.
 */
const topicSchema = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe("Topic id (e.g. 3665478) or DevForum URL. Also accepted as topic_id.");
const topicAlias = z.union([z.number().int(), z.string()]).optional().describe("Alias for topic.");

/** The topic a call names, under either spelling. */
function topicArg(args: { topic?: number | string; topic_id?: number | string }): number | string | undefined {
  return args.topic ?? args.topic_id;
}

function topicLine(index: number, topic: RawTopic, post?: RawPost, matchedBy?: string[]): string {
  const status = bugStatus(topic);
  const badge = status ? `[${status}] ` : "";
  // Search payloads carry no topic like_count, so the number is the matched post's and
  // changes with whichever post matched. Say which it is rather than letting the same
  // thread report "1 likes" in one search and "0 likes" in the next.
  const likes =
    topic.like_count === undefined && post
      ? `${likesOf(topic, post)} likes on the matched post`
      : `${likesOf(topic, post)} likes`;
  const meta = [
    `#${categoryName(topic.category_id)}`,
    likes,
    `${topic.reply_count ?? Math.max((topic.posts_count ?? 1) - 1, 0)} replies`,
    relativeDate(topic.bumped_at ?? topic.last_posted_at ?? topic.created_at),
  ];
  if (topic.tags?.length) meta.push(topic.tags.slice(0, 4).join(", "));
  if (matchedBy && matchedBy.length > 1) meta.push(`matched ${matchedBy.length} phrasings`);

  // Discourse returns whichever post matched, often a reply deep in the thread. Saying so
  // stops the excerpt reading as a summary of the topic — "Github link is broken, is this
  // defunct?" is a reply, not what the resource thread is about.
  const from = post && post.post_number > 1 ? `reply #${post.post_number}: ` : "";
  const blurb = post?.blurb
    ? `\n   ${from}${decodeEntities(post.blurb).replace(/\s+/g, " ").slice(0, 260)}`
    : "";
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

/** Smallest slice that still leaves a post worth reading. */
const PER_POST_FLOOR = 120;

/**
 * Render posts inside a token budget.
 *
 * Only the per-post slice used to be budgeted, and it had this floor, so the assembled
 * output was the floor times the post count: get_thread with max_posts 30 and max_tokens
 * 300 returned about 1,700 tokens, near six times what was asked for. Fewer whole posts
 * are worth more to a reader than many shredded ones, so the budget now decides how many
 * are rendered, and the joined result is truncated as a hard guarantee.
 */
export function renderWithin(
  posts: RawPost[],
  topic: RawTopic,
  budget: number,
  hint: string,
): { body: string; shown: number } {
  const kept = posts.slice(0, Math.max(Math.floor(budget / PER_POST_FLOOR), 1));
  const perPost = Math.max(Math.floor(budget / Math.max(kept.length, 1)), PER_POST_FLOOR);
  const body = truncate(kept.map((p) => renderPost(p, topic, perPost)).join("\n\n"), budget, hint);
  return { body, shown: kept.length };
}

function renderPost(post: RawPost, topic: RawTopic, budget: number): string {
  const author = post.username ?? post.name ?? "unknown";
  const role = post.staff || post.admin || post.moderator ? " (Roblox staff)" : "";
  const accepted = post.accepted_answer ? " ✅ ACCEPTED ANSWER" : "";
  const likes = post.actions_summary?.find((a) => a.id === 2)?.count ?? 0;
  const header = `--- #${post.post_number} by ${author}${role}${accepted} · ${relativeDate(post.created_at)}${likes ? ` · ${likes} likes` : ""}`;
  const body = htmlToMarkdown(post.cooked ?? "", { keepQuotes: post.post_number === 1 });
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

/**
 * Discourse ANDs every term, so a natural symptom sentence can match nothing at all while
 * its two distinctive words find the report you wanted: "ProximityPrompt not triggering on
 * mobile" returned zero bug reports, "ProximityPrompt mobile" returned the staff-answered
 * OnePerButton one. Used only after a search comes back empty.
 */
/**
 * The filters a call actually set, named. An empty result has to say which filter to loosen:
 * "drop the filters" leaves the caller guessing which of four it was.
 */
export function activeFilters(args: {
  category?: string;
  tags?: string[];
  solved_only?: boolean;
  after?: string;
  area?: string;
}): string[] {
  return [
    args.category === undefined ? "" : `category ${args.category}`,
    args.area === undefined ? "" : `in ${args.area}`,
    args.tags?.length ? `tags ${args.tags.join(",")}` : "",
    args.solved_only === true ? "solved_only" : "",
    args.after === undefined ? "" : `active after ${args.after}`,
  ].filter(Boolean);
}

export function broaden(query: string): string | undefined {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\w'-]/g, ""))
    .filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase()));
  if (kept.length < 3) return undefined;
  const distinctive = new Set([...kept].sort((a, b) => b.length - a.length).slice(0, 2));
  const trimmed = kept.filter((w) => distinctive.has(w)).join(" ");
  return trimmed && trimmed !== query.trim() ? trimmed : undefined;
}

/**
 * Discourse accepts `min_post_likes:` but does not actually enforce it — a search for
 * min_post_likes:100 still returns posts with three likes — so the floor is applied here.
 */
function applyMinLikes(topics: RawTopic[], posts: RawPost[], minLikes: number | undefined): RawTopic[] {
  if (!minLikes || minLikes <= 0) return topics;
  const best = new Map<number, number>();
  for (const post of posts) {
    if (post.topic_id === undefined) continue;
    const likes = post.like_count ?? post.actions_summary?.find((a) => a.id === 2)?.count ?? 0;
    best.set(post.topic_id, Math.max(best.get(post.topic_id) ?? 0, likes));
  }
  return topics.filter((t) => Math.max(t.like_count ?? 0, best.get(t.id) ?? 0) >= minLikes);
}

export function registerForumTools(server: McpServer): void {
  server.registerTool(
    "search_devforum",
    {
      title: "Search the Roblox DevForum",
      description:
        "Full-text search across the Roblox Developer Forum. Use this first when a Roblox bug, error message, or engine behaviour needs community context: paste the literal error string (e.g. \"502: API Services rejected request\") or a symptom description. Results are re-ranked to favour solved and recent threads. Follow up with get_thread on the topic_id you want to read.",
      inputSchema: {
        query: querySchema,
        category: categorySchema.optional().describe(`Restrict to one category slug, e.g. scripting-support, engine-bugs, release-notes. Known slugs: ${SLUG_LIST}. Any slug list_categories reports also works.`),
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
        const category = await resolveSlug(args.category);
        if (category.error) return fail(category.error);
        const queries = asList(args.query);
        const { topics: found, posts, matchedBy } = await runQueries(queries, {
          category: category.slug,
          tags: args.tags,
          solvedOnly: args.solved_only,
          minLikes: args.min_likes,
          after: args.after,
          order: args.order,
        });
        const topics = applyMinLikes(found, posts, args.min_likes);
        const label = queries.map((q) => `"${q}"`).join(" / ");
        if (topics.length === 0) {
          const active = activeFilters(args);
          const floor = args.min_likes
            ? ` ${found.length > 0 ? `${found.length} threads matched the text but none reached` : "Nothing reached"} ${args.min_likes}+ likes — lower min_likes.`
            : active.length > 0
              ? ` Active filters: ${active.join(", ")} — try dropping one, or use the raw error text.`
              : " Try fewer words or the raw error text.";
          return ok(`No DevForum threads matched ${label}.${floor}`);
        }
        const ranked = rank(topics, posts, args.order !== "relevance", matchedBy, queries).slice(0, args.limit);
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
        area: categorySchema.optional().describe("Narrow to a single bug category slug, e.g. engine-bugs, studio-bugs, cloud-services-bugs, mobile-bugs, website-bugs, creator-hub-bugs, purchasing-bugs, documentation-issues. Defaults to every bug category."),
        after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only reports active after this date (YYYY-MM-DD)."),
        limit: z.number().int().min(1).max(25).default(8),
        max_tokens: z.number().int().min(200).max(8000).default(2500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const area = await resolveSlug(args.area);
        if (area.error) return fail(area.error);
        // area:"scripting-support" was accepted and searched, and the results came back under
        // a header promising staff triage with [solved] beside each one — but in a support
        // category that tag only means somebody replied. Presenting community Q&A as
        // confirmed Roblox bugs is the one answer this tool must never give.
        if (area.slug !== undefined && !bugAreas().includes(area.slug)) {
          return fail(
            `"${area.slug}" is not a bug category, and only bug categories carry Roblox's triage status. Use one of: ${bugAreas().join(", ")}. For "${area.slug}" use search_devforum with category "${area.slug}".`,
          );
        }
        const queries = asList(args.query);
        const base = { category: area.slug ?? BUG_PARENT, after: args.after };
        let { topics, posts, matchedBy } = await runQueries(queries, base);
        const label = queries.map((q) => `"${q}"`).join(" / ");

        // A sentence-shaped symptom can match nothing while its keywords match a triaged
        // report, and answering "not a known engine bug" to that is worse than no answer.
        // Broadening is per phrasing: one phrasing matching something weakly must not
        // suppress the retry for a phrasing that matched nothing, or adding a phrasing
        // makes the results worse than asking with one.
        const matched = new Set([...matchedBy.values()].flat());
        const pairs = queries
          .filter((q) => !matched.has(q))
          .map((q) => [q, broaden(q)] as const)
          .filter((pair): pair is readonly [string, string] => Boolean(pair[1]));
        const alts = [...new Set(pairs.map(([, trimmed]) => trimmed))];
        let broadened: string[] | undefined;
        if (alts.length > 0) {
          // The original phrasings are re-run from cache, so the merge keeps agreement counts.
          const retry = await runQueries([...queries, ...alts], base);
          if (retry.topics.length > topics.length) {
            ({ topics, posts, matchedBy } = retry);
            broadened = alts;
          }
        }

        if (topics.length === 0) {
          const tried = alts.length > 0 ? ", with or without its less distinctive words" : "";
          // "Not a known engine bug" is the strongest claim this tool makes, and a filter
          // that excluded everything must never be reported as one: after:2030-01-01
          // answered exactly that for "datastore", which has hundreds of reports. Say what
          // the filter cost before saying Roblox has nothing.
          const filters = activeFilters({ after: args.after, area: area.slug });
          if (filters.length > 0) {
            const wider = await runQueries(queries, { category: BUG_PARENT });
            if (wider.topics.length > 0) {
              return ok(
                `No bug reports matched ${label} ${filters.join(" and ")} — but ${wider.topics.length} matched without that filter, so this is the filter and not the absence of a report. Widen or drop it.`,
              );
            }
          }
          return ok(
            `No bug reports matched ${label}${tried}. That often means it is not a known engine bug — try search_devforum for scripting-support threads, or search_creator_docs for expected behaviour.`,
          );
        }
        const ranked = rank(topics, posts, false, matchedBy, [...queries, ...(broadened ?? [])]).slice(0, args.limit);
        const phrasings = broadened ? queries.length + broadened.length : queries.length;
        const body = ranked
          .map((r, i) => topicLine(i + 1, r.topic, r.post, phrasings > 1 ? matchedBy.get(r.topic.id) : undefined))
          .join("\n\n");
        const widened = broadened
          ? ` ${pairs.map(([asked, trimmed]) => `"${asked}" matched nothing as written, so "${trimmed}" was searched too`).join("; ")}.`
          : "";
        const header = `${ranked.length} bug reports for ${label} (status tag shown in brackets when Roblox staff triaged it).${widened}`;
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
        topic: topicSchema,
        topic_id: topicAlias,
        max_posts: z.number().int().min(1).max(30).default(8).describe("How many posts to include."),
        max_tokens: z.number().int().min(300).max(12000).default(3500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const asked = topicArg(args);
      const topicId = parseTopicId(asked);
      if (topicId === undefined) {
        return fail(
          asked === undefined
            ? "Pass the thread as topic (a topic id or a DevForum URL); topic_id is accepted too."
            : `Could not read a topic id from "${asked}".`,
        );
      }
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

        const status = bugStatus(topic);
        const head = [
          `# ${topic.title}`,
          [
            `#${categoryName(topic.category_id)}`,
            status ? `status: ${status}` : undefined,
            `${topic.like_count ?? 0} likes`, // the topic endpoint does return like_count
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
        // The head and footer come out of the same budget the caller asked for.
        const { body, shown } = renderWithin(
          chosen,
          topic,
          Math.max(args.max_tokens - 60, PER_POST_FLOOR),
          `use get_replies with topic_id ${topicId}`,
        );
        const footer =
          stream.length > shown
            ? `\n\n(${stream.length - shown} more replies — use get_replies with topic_id ${topicId}.)`
            : "";
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
        topic: topicSchema,
        topic_id: topicAlias,
        page: z.number().int().min(1).default(1).describe("1-based page of replies."),
        limit: z.number().int().min(1).max(20).default(10),
        max_tokens: z.number().int().min(300).max(12000).default(3000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const asked = topicArg(args);
      const topicId = parseTopicId(asked);
      if (topicId === undefined) {
        return fail(
          asked === undefined
            ? "Pass the thread as topic (a topic id or a DevForum URL); topic_id is accepted too."
            : `Could not read a topic id from "${asked}".`,
        );
      }
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

        const { body, shown } = renderWithin(
          posts,
          topic,
          Math.max(args.max_tokens - 30, PER_POST_FLOOR),
          "raise max_tokens or lower limit",
        );
        const total = Math.ceil(stream.length / args.limit);
        const short = shown < posts.length ? ` — ${shown} of ${posts.length} posts, raise max_tokens for the rest` : "";
        return ok(`${topic.title} — replies page ${args.page}/${total}${short}\n\n${body}`);
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
        category: categorySchema.optional().describe(`Category slug, e.g. release-notes, announcements, engine-bugs. Known slugs: ${SLUG_LIST}. Any slug list_categories reports also works.`),
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
        const category = await resolveSlug(args.category);
        if (category.error) return fail(category.error);
        const topics = await listTopics(args.listing, category.slug as CategorySlug | undefined, args.tag, args.period);
        if (topics.length === 0) return ok("No topics found for that category or tag.");
        const chosen = topics.slice(0, args.limit);
        const scope =
          [category.slug ? `#${category.slug}` : "", args.tag ? `tag:${args.tag}` : ""].filter(Boolean).join(" ") ||
          "the whole forum";
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
