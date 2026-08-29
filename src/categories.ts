/**
 * Category slug -> Discourse id resolution.
 *
 * The ids used to be a hand-written table, so a category Roblox renamed, moved or added was
 * wrong until the next release. Discourse publishes the whole tree at /site.json, so that is
 * the source of truth now; the table below is only the offline fallback, used until the first
 * fetch lands and whenever the forum cannot be reached.
 */

import { cachedJson } from "./cache.js";
import { BASE_URL, getJson, TTL } from "./http.js";

export interface Category {
  id: number;
  slug: string;
  name?: string;
  /** Slug of the parent category, for the sub-categories Discourse nests one level deep. */
  parent?: string;
}

/** Known slugs, in forum display order. Also the documented list in the tool schemas. */
const FALLBACK: readonly Category[] = [
  { slug: "updates", id: 45 },
  { slug: "announcements", id: 36, parent: "updates" },
  { slug: "news-alerts", id: 193, parent: "updates" },
  { slug: "release-notes", id: 62, parent: "updates" },
  { slug: "community", id: 90, parent: "updates" },
  { slug: "help-and-feedback", id: 54 },
  { slug: "scripting-support", id: 55, parent: "help-and-feedback" },
  { slug: "building-support", id: 56, parent: "help-and-feedback" },
  { slug: "art-design-support", id: 57, parent: "help-and-feedback" },
  { slug: "game-design-support", id: 103, parent: "help-and-feedback" },
  { slug: "platform-usage-support", id: 261, parent: "help-and-feedback" },
  { slug: "creations-feedback", id: 20, parent: "help-and-feedback" },
  { slug: "code-review", id: 75, parent: "help-and-feedback" },
  { slug: "cloud-apps", id: 379, parent: "help-and-feedback" },
  { slug: "education-support", id: 197, parent: "help-and-feedback" },
  { slug: "bug-reports", id: 10 },
  { slug: "engine-bugs", id: 28, parent: "bug-reports" },
  { slug: "studio-bugs", id: 29, parent: "bug-reports" },
  { slug: "website-bugs", id: 30, parent: "bug-reports" },
  { slug: "mobile-bugs", id: 31, parent: "bug-reports" },
  { slug: "xbox-bugs", id: 52, parent: "bug-reports" },
  { slug: "documentation-issues", id: 72, parent: "bug-reports" },
  { slug: "creator-hub-bugs", id: 341, parent: "bug-reports" },
  { slug: "cloud-services-bugs", id: 342, parent: "bug-reports" },
  { slug: "purchasing-bugs", id: 344, parent: "bug-reports" },
  { slug: "other-bugs", id: 345, parent: "bug-reports" },
  { slug: "talent-hub-bugs", id: 184, parent: "bug-reports" },
  { slug: "education-bugs", id: 209, parent: "bug-reports" },
  { slug: "catalog-asset-bugs", id: 228, parent: "bug-reports" },
  { slug: "roblox-application-and-website-bugs", id: 343, parent: "bug-reports" },
  { slug: "feature-requests", id: 170 },
  { slug: "engine-features", id: 23, parent: "feature-requests" },
  { slug: "studio-features", id: 24, parent: "feature-requests" },
  { slug: "website-features", id: 25, parent: "feature-requests" },
  { slug: "mobile-features", id: 26, parent: "feature-requests" },
  { slug: "xbox-features", id: 53, parent: "feature-requests" },
  { slug: "talent-hub-features", id: 185, parent: "feature-requests" },
  { slug: "education-features", id: 198, parent: "feature-requests" },
  { slug: "documentation-features", id: 247, parent: "feature-requests" },
  { slug: "resources", id: 71 },
  { slug: "community-resources", id: 74, parent: "resources" },
  { slug: "community-tutorials", id: 46, parent: "resources" },
  { slug: "community-events", id: 196, parent: "resources" },
  { slug: "roblox-staff", id: 278, parent: "resources" },
  { slug: "collaboration", id: 81 },
  { slug: "recruitment", id: 82, parent: "collaboration" },
  { slug: "portfolios", id: 83, parent: "collaboration" },
  { slug: "forum-help", id: 12 },
  { slug: "forum-bugs", id: 146, parent: "forum-help" },
  { slug: "forum-features", id: 147, parent: "forum-help" },
  { slug: "bulletin-board", id: 63 },
];

/** Baked-in slug -> id map, i.e. the tree as it stood when this version shipped. */
export const CATEGORIES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(FALLBACK.map((c) => [c.slug, c.id])),
);

/** The slugs the tool descriptions advertise, whatever the live forum adds on top. */
export const DEFAULT_SLUGS: readonly string[] = FALLBACK.map((c) => c.slug);

/**
 * Slugs are plain strings, not a closed union: a category Roblox adds tomorrow has to work
 * without a release, so the tools validate against the resolved tree instead of a fixed enum.
 */
export type CategorySlug = string;

/* ------------------------------- resolved tree ------------------------------ */

interface Index {
  bySlug: Map<string, Category>;
  byId: Map<number, Category>;
}

function index(categories: Iterable<Category>): Index {
  const bySlug = new Map<string, Category>();
  const byId = new Map<number, Category>();
  for (const category of categories) {
    bySlug.set(category.slug, category);
    byId.set(category.id, category);
  }
  return { bySlug, byId };
}

const fallbackIndex = index(FALLBACK);
let current = fallbackIndex;

/* --------------------------------- loading -------------------------------- */

interface SiteCategory {
  id: number;
  slug: string;
  name?: string;
  parent_category_id?: number | null;
}

const SITE_TTL = 86_400_000;
/** After a failed fetch, keep serving the fallback rather than retrying on every tool call. */
const RETRY_AFTER = 300_000;

let inflight: Promise<void> | undefined;
let loadedAt = 0;
let failedAt = 0;

/** One cache file per forum, so a DEVFORUM_BASE_URL override never reads the wrong tree. */
function cacheKey(): string {
  return `categories-${BASE_URL.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-")}`;
}

async function fetchCategories(): Promise<Category[]> {
  return cachedJson(cacheKey(), SITE_TTL, async () => {
    const data = await getJson<{ categories?: SiteCategory[] }>(`${BASE_URL}/site.json`, TTL.static);
    const raw = (data.categories ?? []).filter((c) => typeof c.id === "number" && Boolean(c.slug));
    if (raw.length === 0) throw new Error("site.json listed no categories");
    const slugOf = new Map(raw.map((c) => [c.id, c.slug]));
    return raw.map<Category>((c) => {
      const parent = c.parent_category_id != null ? slugOf.get(c.parent_category_id) : undefined;
      return { id: c.id, slug: c.slug, name: c.name, ...(parent ? { parent } : {}) };
    });
  });
}

/**
 * Make sure the live tree has been fetched once. Never throws: a forum that is down or slow
 * just leaves the shipped fallback in place, which is what every earlier version used anyway.
 */
export async function ensureCategories(): Promise<void> {
  if (Date.now() - loadedAt < SITE_TTL && loadedAt > 0) return;
  if (Date.now() - failedAt < RETRY_AFTER && failedAt > 0) return;
  inflight ??= (async () => {
    try {
      const live = await fetchCategories();
      // The live tree wins on ids and parents but never removes a slug the tools advertise:
      // a category hidden from an anonymous reader must not become an "unknown category".
      current = index([...FALLBACK, ...live]);
      loadedAt = Date.now();
      failedAt = 0;
    } catch {
      failedAt = Date.now();
    } finally {
      inflight = undefined;
    }
  })();
  await inflight;
}

/** Kick the fetch off without waiting, so category names are live by the first result. */
export function warmCategories(): void {
  void ensureCategories();
}

/** Forget the live tree and go back to the shipped table. Tests only. */
export function resetCategories(): void {
  current = fallbackIndex;
  loadedAt = 0;
  failedAt = 0;
}

/* -------------------------------- accessors ------------------------------- */

export function resolveCategory(slug: string): Category | undefined {
  return current.bySlug.get(slug.trim().toLowerCase());
}

export function knownSlugs(): string[] {
  return [...current.bySlug.keys()];
}

/** Discourse's catch-all: it holds nothing on the DevForum and only clutters a listing. */
const HIDDEN = new Set(["uncategorized"]);

/**
 * The tree as list_categories reports it, parents in forum order with their children under
 * them. Built from the same resolved map the filters use, so it can never advertise a slug
 * the tools would then reject.
 */
export function categoryTree(): Array<Category & { subcategories: Category[] }> {
  const children = new Map<string, Category[]>();
  const roots: Category[] = [];
  for (const category of current.bySlug.values()) {
    if (HIDDEN.has(category.slug)) continue;
    if (category.parent && current.bySlug.has(category.parent)) {
      const siblings = children.get(category.parent) ?? [];
      siblings.push(category);
      children.set(category.parent, siblings);
    } else {
      roots.push(category);
    }
  }
  return roots.map((root) => ({ ...root, subcategories: children.get(root.slug) ?? [] }));
}

export function categoryName(id: number | undefined): string {
  if (id === undefined) return "unknown";
  return current.byId.get(id)?.slug ?? `category-${id}`;
}

/** Canonical Discourse listing path, e.g. "updates/release-notes/62". */
export function categoryPath(slug: string): string {
  const category = resolveCategory(slug);
  // An unresolved slug still builds a usable path: Discourse 301s /c/<slug> to the real one.
  if (!category) return slug.trim().toLowerCase();
  return `${category.parent ? `${category.parent}/` : ""}${category.slug}/${category.id}`;
}

/**
 * Slugs close enough to be what the caller meant. Discourse slugs are dash-joined words, so
 * a shared whole word ("scripting", "bugs") is the signal worth reporting back.
 *
 * Only the best-scoring tier is returned: "studio bugs" matches studio-bugs on both words
 * and xbox-bugs on one, and offering the near-misses alongside the obvious answer only
 * makes the correction harder to read.
 */
export function suggestCategories(slug: string, limit = 3): string[] {
  const asked = slug.trim().toLowerCase();
  const words = asked.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored = knownSlugs()
    .map((known) => {
      const parts = known.split("-");
      let score = words.filter((w) => parts.includes(w)).length * 2;
      if (score === 0 && (known.includes(asked) || asked.includes(known))) score = 1;
      return { known, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.known.length - b.known.length);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((s) => s.score === best)
    .slice(0, limit)
    .map((s) => s.known);
}
