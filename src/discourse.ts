/** Roblox DevForum (Discourse) API client. */

import {
  categoryPath,
  categoryTree,
  ensureCategories,
  type Category,
  type CategorySlug,
} from "./categories.js";
import { BASE_URL, getJson, TTL } from "./http.js";

export { BASE_URL } from "./http.js";
export {
  bugAreas,
  CATEGORIES,
  categoryTree,
  DEFAULT_SLUGS,
  categoryName,
  categoryPath,
  ensureCategories,
  knownSlugs,
  resolveCategory,
  suggestCategories,
  warmCategories,
  type Category,
  type CategorySlug,
} from "./categories.js";

/**
 * Discourse ANDs multiple `#category` terms, so a multi-category search always returns
 * nothing. Searching the parent category covers every bug sub-category instead.
 */
export const BUG_PARENT = "bug-reports";

export function topicUrl(id: number, slug?: string, postNumber?: number): string {
  const base = `${BASE_URL}/t/${slug ? `${slug}/` : ""}${id}`;
  return postNumber && postNumber > 1 ? `${base}/${postNumber}` : base;
}

/* ------------------------------- raw shapes ------------------------------- */

export interface RawTopic {
  id: number;
  title: string;
  slug?: string;
  category_id?: number;
  tags?: string[];
  posts_count?: number;
  reply_count?: number;
  like_count?: number;
  views?: number;
  created_at?: string;
  last_posted_at?: string;
  bumped_at?: string;
  has_accepted_answer?: boolean;
  closed?: boolean;
  pinned?: boolean;
  pinned_globally?: boolean;
}

export interface RawPost {
  id: number;
  post_number: number;
  topic_id?: number;
  username?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  cooked?: string;
  blurb?: string;
  score?: number;
  reply_count?: number;
  accepted_answer?: boolean;
  like_count?: number;
  staff?: boolean;
  admin?: boolean;
  moderator?: boolean;
  user_title?: string | null;
  actions_summary?: Array<{ id: number; count?: number }>;
}

interface SearchResponse {
  topics?: RawTopic[];
  posts?: RawPost[];
  grouped_search_result?: { more_full_page_results?: boolean };
}

interface TopicResponse extends RawTopic {
  post_stream?: { posts?: RawPost[]; stream?: number[] };
  details?: { created_by?: { username?: string } };
}

/* --------------------------------- queries -------------------------------- */

export interface SearchOptions {
  query: string;
  category?: string;
  tags?: string[];
  solvedOnly?: boolean;
  minLikes?: number;
  after?: string;
  order?: "relevance" | "latest" | "likes" | "views";
  page?: number;
}

/** Build a Discourse advanced-search string. Exported for unit tests. */
export function buildSearchQuery(opts: SearchOptions): string {
  const parts = [opts.query.trim()];
  if (opts.category) parts.push(`#${opts.category}`);
  if (opts.tags?.length) parts.push(`tags:${opts.tags.join(",")}`);
  if (opts.solvedOnly) parts.push("status:solved");
  if (opts.minLikes && opts.minLikes > 0) parts.push(`min_post_likes:${opts.minLikes}`);
  if (opts.after) parts.push(`after:${opts.after}`);
  if (opts.order && opts.order !== "relevance") parts.push(`order:${opts.order}`);
  return parts.filter(Boolean).join(" ");
}

export async function search(opts: SearchOptions): Promise<{ topics: RawTopic[]; posts: RawPost[] }> {
  const url = new URL(`${BASE_URL}/search.json`);
  url.searchParams.set("q", buildSearchQuery(opts));
  if (opts.page && opts.page > 1) url.searchParams.set("page", String(opts.page));
  const data = await getJson<SearchResponse>(url.toString(), TTL.search);
  return { topics: data.topics ?? [], posts: data.posts ?? [] };
}

export async function getTopic(topicId: number): Promise<TopicResponse> {
  return getJson<TopicResponse>(`${BASE_URL}/t/${topicId}.json`, TTL.thread);
}

/** Fetch posts of a topic by their ids (Discourse caps this at ~20 per call). */
export async function getPostsByIds(topicId: number, ids: number[]): Promise<RawPost[]> {
  if (ids.length === 0) return [];
  const url = new URL(`${BASE_URL}/t/${topicId}/posts.json`);
  for (const id of ids) url.searchParams.append("post_ids[]", String(id));
  const data = await getJson<{ post_stream?: { posts?: RawPost[] } }>(url.toString(), TTL.thread);
  return data.post_stream?.posts ?? [];
}

export type Listing = "latest" | "top";

export async function listTopics(
  listing: Listing,
  category?: CategorySlug | undefined,
  tag?: string,
  period?: string,
  page = 0,
): Promise<RawTopic[]> {
  let path: string;
  // The id in a category path has to be the live one, or Discourse serves another category.
  if (category) await ensureCategories();
  if (tag && category) {
    // Both used to mean "tag wins": asking for release-notes tagged datastore silently
    // dropped the category and answered with community-resources threads.
    path = `/tags/c/${categoryPath(category)}/${encodeURIComponent(tag)}/l/${listing}.json`;
  } else if (tag) path = `/tag/${encodeURIComponent(tag)}/l/${listing}.json`;
  else if (category) path = `/c/${categoryPath(category)}/l/${listing}.json`;
  else path = `/${listing}.json`;
  const url = new URL(`${BASE_URL}${path}`);
  if (listing === "top" && period) url.searchParams.set("period", period);
  if (page > 0) url.searchParams.set("page", String(page));
  const data = await getJson<{ topic_list?: { topics?: RawTopic[] } }>(url.toString(), TTL.search);
  // "About the … category" topics are pinned to every listing and never carry real content.
  return (data.topic_list?.topics ?? []).filter((t) => !t.pinned && !t.pinned_globally);
}

/** The Announcements tag Roblox puts on its weekly "what shipped" digest. */
export const WEEKLY_RECAP_TAG = "weekly-recap";

export type CategoryInfo = Category & { subcategories: Category[] };

/**
 * The category tree, from the same site.json the filters resolve against. It used to come
 * from categories.json, which meant list_categories could advertise a slug the filters then
 * rejected; one source for both makes that impossible.
 */
export async function listCategories(): Promise<CategoryInfo[]> {
  await ensureCategories();
  return categoryTree();
}

export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const data = await getJson<{ tags?: Array<{ name: string; count: number }> }>(
    `${BASE_URL}/tags.json`,
    TTL.static,
  );
  return (data.tags ?? []).sort((a, b) => b.count - a.count);
}
