/** Relevance re-ranking tuned for "is this thread going to fix my bug?". */

import type { RawTopic, RawPost } from "./discourse.js";

export interface Ranked {
  topic: RawTopic;
  post?: RawPost;
  score: number;
}

const SOLVED_TAGS = new Set(["solved", "fixed", "confirmed", "resolved"]);
const DEAD_TAGS = new Set(["cannot-reproduce", "duplicate", "not-a-bug", "invalid", "by-design"]);

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
): Ranked[] {
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

    let score = 100 - index * 3; // Discourse relevance stays the backbone
    if (topic.has_accepted_answer) score += 45;

    // Independent phrasings agreeing on a thread is strong evidence it is on-topic, and the
    // result line advertises the count, so it has to actually move the ranking.
    const agreement = matchedBy?.get(topic.id)?.length ?? 1;
    score += (agreement - 1) * 22;

    // Read tags directly: bugStatus() infers "solved" from has_accepted_answer, so scoring
    // off it would count the same signal twice.
    const status = tagStatus(topic);
    if (status && SOLVED_TAGS.has(status)) score += 25;
    if (status && DEAD_TAGS.has(status)) score -= 20;

    // Roblox changes fast, so age is weighted hard: a 3-year-old thread loses more than an
    // accepted answer is worth (+45), and past ~6 years nothing outranks a current thread.
    const bumpedAge = ageYears(topic.bumped_at ?? topic.last_posted_at ?? topic.created_at);
    score -= Math.min(bumpedAge * 15, 85);
    score += Math.min((topic.like_count ?? 0) * 1.5, 25);
    score += Math.min((topic.reply_count ?? 0) * 0.8, 15);
    if ((topic.posts_count ?? 0) <= 1) score -= 8; // nobody ever replied

    return { topic, post, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
