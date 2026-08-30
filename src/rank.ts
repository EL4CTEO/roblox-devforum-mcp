/** Relevance re-ranking tuned for "is this thread going to fix my bug?". */

import type { RawTopic, RawPost } from "./discourse.js";

export interface Ranked {
  topic: RawTopic;
  post?: RawPost;
  score: number;
}

const SOLVED_TAGS = new Set(["solved", "fixed", "confirmed", "resolved"]);
const DEAD_TAGS = new Set(["cannot-reproduce", "duplicate", "not-a-bug", "invalid", "by-design"]);

/**
 * Likes for a topic. Discourse omits `like_count` from search results entirely — it is only
 * present on category listings — so the matched post's own count is the fallback.
 */
export function likesOf(topic: RawTopic, post?: RawPost): number {
  return topic.like_count ?? post?.like_count ?? post?.actions_summary?.find((a) => a.id === 2)?.count ?? 0;
}

/** Triage status taken only from the topic's own tags — no inference. */
function tagStatus(topic: RawTopic): string | undefined {
  return (topic.tags ?? [])
    .map((t) => t.toLowerCase())
    .find((t) => SOLVED_TAGS.has(t) || DEAD_TAGS.has(t));
}

/** Status tags Roblox staff apply to bug reports, surfaced verbatim to the model. */
export function bugStatus(topic: RawTopic): string | undefined {
  return tagStatus(topic) ?? (topic.has_accepted_answer ? "solved" : undefined);
}

/** Words that carry no weight in a Discourse index but still narrow an AND-ed query. */
export const FILLER = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "not", "no", "on", "in", "at", "to",
  "of", "for", "and", "or", "but", "my", "me", "i", "it", "its", "this", "that", "when", "why",
  "how", "does", "doesnt", "dont", "cant", "with", "without", "after", "before", "from", "any",
  "some", "get", "getting", "still", "keep", "keeps", "randomly", "sometimes", "issue", "problem",
]);

/** The words in a query that actually say what it is about. */
export function distinctiveTerms(queries: string[]): string[] {
  const terms = new Set<string>();
  for (const query of queries) {
    for (const word of query.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !FILLER.has(word)) terms.add(word);
    }
  }
  return [...terms];
}

/**
 * How much of the query the title itself carries. Titles are compared with the separators
 * removed, so "ProximityPrompt" matches a title written "proximity prompt" either way.
 */
function titleMatch(title: string | undefined, terms: string[]): number {
  if (!title || terms.length === 0) return 0;
  const compact = title.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Weighted by length: "tweenservice" says what a thread is about, "server" barely narrows
  // anything, and counting them equally lets a title carrying only the vague word score half.
  const total = terms.reduce((sum, t) => sum + t.length, 0);
  const hit = terms.filter((t) => compact.includes(t)).reduce((sum, t) => sum + t.length, 0);
  return hit / total;
}

function ageYears(iso: string | undefined): number {
  if (!iso) return 5;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 5 : (Date.now() - t) / (365 * 86_400_000);
}

/**
 * Merge several independent result sets into one, de-duplicated by topic.
 *
 * A topic keeps its best position across the queries that found it, and topics matched by
 * more than one query are promoted — agreement between phrasings is a strong signal that a
 * thread is really about the problem.
 */
export function mergeResults(
  sets: Array<{ query: string; topics: RawTopic[]; posts: RawPost[] }>,
): { topics: RawTopic[]; posts: RawPost[]; matchedBy: Map<number, string[]> } {
  const best = new Map<number, { topic: RawTopic; position: number }>();
  const matchedBy = new Map<number, string[]>();
  const posts: RawPost[] = [];
  const seenPosts = new Set<number>();

  for (const set of sets) {
    set.topics.forEach((topic, index) => {
      const previous = best.get(topic.id);
      if (!previous || index < previous.position) best.set(topic.id, { topic, position: index });
      const queries = matchedBy.get(topic.id) ?? [];
      if (!queries.includes(set.query)) queries.push(set.query);
      matchedBy.set(topic.id, queries);
    });
    for (const post of set.posts) {
      if (seenPosts.has(post.id)) continue;
      seenPosts.add(post.id);
      posts.push(post);
    }
  }

  const topics = [...best.values()]
    .sort((a, b) => {
      const agreement = (matchedBy.get(b.topic.id)?.length ?? 1) - (matchedBy.get(a.topic.id)?.length ?? 1);
      return agreement || a.position - b.position;
    })
    .map((entry) => entry.topic);

  return { topics, posts, matchedBy };
}

/**
 * Search hits arrive in Discourse relevance order; blend in signals that matter for
 * debugging so a solved 2025 thread outranks an unanswered 2018 one.
 */
export function rank(
  topics: RawTopic[],
  posts: RawPost[],
  originalOrder = false,
  matchedBy?: Map<number, string[]>,
  queries: string[] = [],
): Ranked[] {
  const terms = distinctiveTerms(queries);
  const byTopic = new Map<number, RawPost>();
  for (const post of posts) {
    const key = post.topic_id;
    if (key === undefined) continue;
    const existing = byTopic.get(key);
    if (!existing || (post.post_number ?? 99) < (existing.post_number ?? 99)) byTopic.set(key, post);
  }

  const ranked = topics.map((topic, index) => {
    const post = byTopic.get(topic.id);
    if (originalOrder) return { topic, post, score: -index };

    // Discourse relevance and the staleness of the thread are the frame; everything else
    // is thread quality, which only earns its weight once the thread looks on topic.
    let score = 100 - index * 3;

    // Whether the title is about the thing asked about used to be missing entirely, and a
    // search for "ProximityPrompt not triggering" answered with four solved, recent,
    // well-liked threads about audio, dialogue and DataStores — while the ProximityPrompt
    // thread Discourse ranked second lost to them on age and likes and never appeared.
    const onTopic = titleMatch(topic.title, terms);
    score += onTopic * 70;

    const bumpedAge = ageYears(topic.bumped_at ?? topic.last_posted_at ?? topic.created_at);
    // Roblox changes fast, so age is weighted hard: a 3-year-old thread loses more than an
    // accepted answer is worth, and past ~6 years nothing outranks a current thread.
    score -= Math.min(bumpedAge * 15, 85);

    // Independent phrasings agreeing on a thread is itself evidence it is on topic, and the
    // result line advertises the count, so it moves the ranking at full weight.
    const agreement = matchedBy?.get(topic.id)?.length ?? 1;
    score += (agreement - 1) * 22;

    // A well-run thread about something else is still about something else: quality counts
    // in full only for a thread the query actually points at, and a third otherwise.
    let quality = 0;
    if (topic.has_accepted_answer) quality += 45;
    // Read tags directly: bugStatus() infers "solved" from has_accepted_answer, so scoring
    // off it would count the same signal twice.
    const status = tagStatus(topic);
    if (status && SOLVED_TAGS.has(status)) quality += 25;
    if (status && DEAD_TAGS.has(status)) quality -= 20;
    quality += Math.min(likesOf(topic, post) * 1.5, 25);
    quality += Math.min((topic.reply_count ?? 0) * 0.8, 15);
    if ((topic.posts_count ?? 0) <= 1) quality -= 8; // nobody ever replied
    score += quality * (terms.length === 0 ? 1 : 0.3 + 0.7 * onTopic);

    return { topic, post, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
