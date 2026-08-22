/** Roblox DevForum (Discourse) API client. */

import { getJson, TTL } from "./http.js";

export const BASE_URL = (process.env.DEVFORUM_BASE_URL ?? "https://devforum.roblox.com").replace(/\/+$/, "");

/** Slugs the model may pass as `category`, mapped to Discourse ids. */
export const CATEGORIES = {
  "updates": 45,
  "announcements": 36,
  "news-alerts": 193,
  "release-notes": 62,
  "community": 90,
  "help-and-feedback": 54,
  "scripting-support": 55,
  "building-support": 56,
  "art-design-support": 57,
  "game-design-support": 103,
  "platform-usage-support": 261,
  "creations-feedback": 20,
  "code-review": 75,
  "cloud-apps": 379,
  "education-support": 197,
  "bug-reports": 10,
  "engine-bugs": 28,
  "studio-bugs": 29,
  "website-bugs": 30,
  "mobile-bugs": 31,
  "xbox-bugs": 52,
  "documentation-issues": 72,
  "creator-hub-bugs": 341,
  "cloud-services-bugs": 342,
  "purchasing-bugs": 344,
  "other-bugs": 345,
  "talent-hub-bugs": 184,
  "education-bugs": 209,
  "catalog-asset-bugs": 228,
  "roblox-application-and-website-bugs": 343,
  "feature-requests": 170,
  "engine-features": 23,
  "studio-features": 24,
  "website-features": 25,
  "mobile-features": 26,
  "xbox-features": 53,
  "talent-hub-features": 185,
  "education-features": 198,
  "documentation-features": 247,
  "resources": 71,
  "community-resources": 74,
  "community-tutorials": 46,
  "community-events": 196,
  "roblox-staff": 278,
  "collaboration": 81,
  "recruitment": 82,
  "portfolios": 83,
  "forum-help": 12,
  "forum-bugs": 146,
  "forum-features": 147,
  "bulletin-board": 63,
} as const;

export type CategorySlug = keyof typeof CATEGORIES;

/**
 * Discourse ANDs multiple `#category` terms, so a multi-category search always returns
 * nothing. Searching the parent category covers every bug sub-category instead.
 */
export const BUG_PARENT: CategorySlug = "bug-reports";

const ID_TO_SLUG = new Map<number, string>(Object.entries(CATEGORIES).map(([slug, id]) => [id, slug]));

export function categoryName(id: number | undefined): string {
  if (id === undefined) return "unknown";
  return ID_TO_SLUG.get(id) ?? `category-${id}`;
}

/** Sub-category slug -> parent slug. Discourse 301-redirects the short form, costing a round-trip. */
const CATEGORY_PARENTS: Partial<Record<CategorySlug, CategorySlug>> = {
  "announcements": "updates",
  "news-alerts": "updates",
  "release-notes": "updates",
  "community": "updates",
  "scripting-support": "help-and-feedback",
  "building-support": "help-and-feedback",
  "art-design-support": "help-and-feedback",
  "game-design-support": "help-and-feedback",
  "platform-usage-support": "help-and-feedback",
  "creations-feedback": "help-and-feedback",
  "code-review": "help-and-feedback",
  "cloud-apps": "help-and-feedback",
  "education-support": "help-and-feedback",
  "engine-bugs": "bug-reports",
  "studio-bugs": "bug-reports",
  "website-bugs": "bug-reports",
  "mobile-bugs": "bug-reports",
  "xbox-bugs": "bug-reports",
  "documentation-issues": "bug-reports",
  "creator-hub-bugs": "bug-reports",
  "cloud-services-bugs": "bug-reports",
  "purchasing-bugs": "bug-reports",
  "other-bugs": "bug-reports",
  "talent-hub-bugs": "bug-reports",
  "education-bugs": "bug-reports",
  "catalog-asset-bugs": "bug-reports",
  "roblox-application-and-website-bugs": "bug-reports",
  "engine-features": "feature-requests",
  "studio-features": "feature-requests",
  "website-features": "feature-requests",
  "mobile-features": "feature-requests",
  "xbox-features": "feature-requests",
  "talent-hub-features": "feature-requests",
  "education-features": "feature-requests",
  "documentation-features": "feature-requests",
  "community-resources": "resources",
  "community-tutorials": "resources",
  "community-events": "resources",
  "roblox-staff": "resources",
  "recruitment": "collaboration",
  "portfolios": "collaboration",
  "forum-bugs": "forum-help",
  "forum-features": "forum-help",
};

/** Canonical Discourse listing path, e.g. "updates/release-notes/62". */
export function categoryPath(slug: CategorySlug): string {
  const parent = CATEGORY_PARENTS[slug];
  return `${parent ? `${parent}/` : ""}${slug}/${CATEGORIES[slug]}`;
}

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
  if (tag) path = `/tag/${encodeURIComponent(tag)}/l/${listing}.json`;
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

export interface CategoryInfo {
  id: number;
  slug: string;
  name: string;
  description?: string;
  subcategories: Array<{ id: number; slug: string; name: string }>;
}

export async function listCategories(): Promise<CategoryInfo[]> {
  const data = await getJson<{
    category_list?: {
      categories?: Array<{
        id: number;
        slug: string;
        name: string;
        description_text?: string;
        subcategory_list?: Array<{ id: number; slug: string; name: string }>;
      }>;
    };
  }>(`${BASE_URL}/categories.json?include_subcategories=true`, TTL.static);

  return (data.category_list?.categories ?? []).map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description_text,
    subcategories: (c.subcategory_list ?? []).map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
  }));
}

export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const data = await getJson<{ tags?: Array<{ name: string; count: number }> }>(
    `${BASE_URL}/tags.json`,
    TTL.static,
  );
  return (data.tags ?? []).sort((a, b) => b.count - a.count);
}
