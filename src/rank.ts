/** Relevance re-ranking tuned for "is this thread going to fix my bug?". */

import type { RawTopic, RawPost } from "./discourse.js";

export interface Ranked {
  topic: RawTopic;
  post?: RawPost;
  score: number;
}

const SOLVED_TAGS = new Set(["solved", "fixed", "confirmed", "resolved"]);
const DEAD_TAGS = new Set(["cannot-reproduce", "duplicate", "not-a-bug", "invalid", "by-design"]);

/** Status tags Roblox staff apply to bug reports, surfaced verbatim to the model. */
export function bugStatus(topic: RawTopic): string | undefined {
  const tags = (topic.tags ?? []).map((t) => t.toLowerCase());
  const status = tags.find((t) => SOLVED_TAGS.has(t) || DEAD_TAGS.has(t));
  if (status) return status;
  if (topic.has_accepted_answer) return "solved";
  return undefined;
}

function ageYears(iso: string | undefined): number {
  if (!iso) return 5;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 5 : (Date.now() - t) / (365 * 86_400_000);
}

/**
 * Search hits arrive in Discourse relevance order; blend in signals that matter for
 * debugging so a solved 2025 thread outranks an unanswered 2018 one.
 */
export function rank(topics: RawTopic[], posts: RawPost[], originalOrder = false): Ranked[] {
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
    const status = bugStatus(topic);
    if (topic.has_accepted_answer) score += 45;
    if (status && SOLVED_TAGS.has(status)) score += 25;
    if (status && DEAD_TAGS.has(status)) score -= 20;

    const bumpedAge = ageYears(topic.bumped_at ?? topic.last_posted_at ?? topic.created_at);
    score -= Math.min(bumpedAge * 7, 45); // stale threads decay, but never to zero
    score += Math.min((topic.like_count ?? 0) * 1.5, 25);
    score += Math.min((topic.reply_count ?? 0) * 0.8, 15);
    if ((topic.posts_count ?? 0) <= 1) score -= 8; // nobody ever replied

    return { topic, post, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
