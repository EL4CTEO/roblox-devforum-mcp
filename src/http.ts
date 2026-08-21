/** Shared HTTP layer: browser-like UA, timeouts, retry/backoff, TTL cache, concurrency cap. */

const UA =
  process.env.DEVFORUM_USER_AGENT ??
  "Mozilla/5.0 (compatible; roblox-devforum-mcp/1.0; +https://github.com/EL4CTEO/roblox-devforum-mcp)";

const TIMEOUT_MS = Number(process.env.DEVFORUM_TIMEOUT_MS ?? 12_000);
const MAX_RETRIES = Number(process.env.DEVFORUM_MAX_RETRIES ?? 3);
const MAX_CONCURRENCY = Number(process.env.DEVFORUM_CONCURRENCY ?? 4);

export const TTL = {
  search: Number(process.env.DEVFORUM_CACHE_TTL ?? 300) * 1000,
  thread: 900_000,
  static: 86_400_000,
} as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

/* ------------------------------- TTL cache ------------------------------- */

type Entry = { value: unknown; expires: number };
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 400;

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // refresh LRU position
  cache.delete(key);
  cache.set(key, hit);
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttl: number): void {
  if (ttl <= 0) return;
  cache.set(key, { value, expires: Date.now() + ttl });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearCache(): void {
  cache.clear();
}

/* ---------------------------- concurrency gate ---------------------------- */

let active = 0;
const queue: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  queue.shift()?.();
}

/* -------------------------------- fetching -------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchOnce(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json, text/plain, */*", ...headers },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function request(url: string, headers: Record<string, string>): Promise<Response> {
  await acquire();
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const res = await fetchOnce(url, headers);
        if (res.ok) return res;
        if (!retryable(res.status) || attempt === MAX_RETRIES) {
          throw new HttpError(res.status, url);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10_000)
            : 400 * 2 ** attempt + Math.random() * 250,
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        await sleep(400 * 2 ** attempt + Math.random() * 250);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
  } finally {
    release();
  }
}

/** Cached JSON GET. */
export async function getJson<T>(url: string, ttl: number = TTL.search): Promise<T> {
  const cached = cacheGet<T>(url);
  if (cached !== undefined) return cached;
  const res = await request(url, {});
  const data = (await res.json()) as T;
  cacheSet(url, data, ttl);
  return data;
}

/** Cached text GET. */
export async function getText(url: string, ttl: number = TTL.static): Promise<string> {
  const key = `text:${url}`;
  const cached = cacheGet<string>(key);
  if (cached !== undefined) return cached;
  const res = await request(url, { accept: "text/plain, text/markdown, */*" });
  const text = await res.text();
  cacheSet(key, text, ttl);
  return text;
}

/** Cached JSON GET against the GitHub API (token optional, raises rate limit). */
export async function getGithubJson<T>(url: string, ttl: number = TTL.static): Promise<T> {
  const key = `gh:${url}`;
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request(url, headers);
  const data = (await res.json()) as T;
  cacheSet(key, data, ttl);
  return data;
}
