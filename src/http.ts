/** Shared HTTP layer: browser-like UA, timeouts, retry/backoff, TTL cache, concurrency cap. */

const UA =
  process.env.DEVFORUM_USER_AGENT ??
  "Mozilla/5.0 (compatible; roblox-devforum-mcp/1.0; +https://github.com/EL4CTEO/roblox-devforum-mcp)";

/** Lives here rather than in discourse.ts so the category loader can use it without a cycle. */
export const BASE_URL = (process.env.DEVFORUM_BASE_URL ?? "https://devforum.roblox.com").replace(/\/+$/, "");

/**
 * Read a numeric setting, falling back when the value is not a usable number.
 *
 * A bare Number() turned a typo into NaN and every comparison against it into false:
 * DEVFORUM_CONCURRENCY=abc (or 0) left `active < limit` permanently false, so requests
 * queued forever and the tool call never returned at all; a bad DEVFORUM_MAX_RETRIES
 * failed every request with a generic "Request failed" that blamed the network. These are
 * documented, user-set variables, so a mistyped one has to degrade to the default.
 */
export function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    process.stderr.write(`[roblox-devforum-mcp] ignoring ${name}="${raw}", using ${fallback}\n`);
    return fallback;
  }
  return Math.floor(value);
}

const TIMEOUT_MS = envInt("DEVFORUM_TIMEOUT_MS", 12_000, 100);
const MAX_RETRIES = envInt("DEVFORUM_MAX_RETRIES", 3, 0);
const MAX_CONCURRENCY = envInt("DEVFORUM_CONCURRENCY", 4, 1);
const CDN_CONCURRENCY = envInt("DEVFORUM_CDN_CONCURRENCY", 8, 1);

export const TTL = {
  search: envInt("DEVFORUM_CACHE_TTL", 300, 0) * 1000,
  thread: 900_000,
  static: 86_400_000,
} as const;

/**
 * The upstream did not answer in time.
 *
 * Worth its own type because a timeout is the one failure a caller can do something about.
 * A search for `status:solved` alongside a tag filter takes the DevForum's index over thirty
 * seconds; with three retries stacked on a 12-second timeout the tool sat for 51 seconds and
 * then returned "This operation was aborted", which names neither the cause nor a way out.
 */
export class TimeoutError extends Error {
  constructor(readonly url: string, readonly elapsedMs: number) {
    super(`the request timed out after ${Math.round(elapsedMs / 1000)}s: ${url}`);
    this.name = "TimeoutError";
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof TimeoutError;
}

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

/**
 * Concurrency is limited per host, not globally. The DevForum is a live Discourse instance
 * that deserves a polite ceiling; raw.githubusercontent.com is a static CDN, and docs search
 * fans out to a dozen files at once, so throttling it to the same number wastes whole waves.
 */
const CDN_HOSTS = new Set(["raw.githubusercontent.com", "api.github.com"]);

function limitFor(host: string): number {
  return CDN_HOSTS.has(host) ? CDN_CONCURRENCY : MAX_CONCURRENCY;
}

interface Gate {
  active: number;
  queue: Array<() => void>;
}

const gates = new Map<string, Gate>();

function gateFor(host: string): Gate {
  let gate = gates.get(host);
  if (!gate) {
    gate = { active: 0, queue: [] };
    gates.set(host, gate);
  }
  return gate;
}

async function acquire(host: string): Promise<void> {
  const gate = gateFor(host);
  if (gate.active < limitFor(host)) {
    gate.active += 1;
    return;
  }
  await new Promise<void>((resolve) => gate.queue.push(resolve));
  gate.active += 1;
}

function release(host: string): void {
  const gate = gateFor(host);
  gate.active -= 1;
  gate.queue.shift()?.();
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/* -------------------------------- fetching -------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchOnce(
  url: string,
  headers: Record<string, string>,
  budgetMs = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, budgetMs));
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

/**
 * Retries are for a service that is briefly unwell, not one that is simply slow. A query the
 * index cannot answer inside the timeout will not answer inside the next three either, so a
 * whole call gets one overall deadline rather than MAX_RETRIES × TIMEOUT_MS of patience.
 */
const DEADLINE_MS = envInt("DEVFORUM_DEADLINE_MS", TIMEOUT_MS * 2, 100);

async function request(url: string, headers: Record<string, string>): Promise<Response> {
  const host = safeHost(url);
  const started = Date.now();
  await acquire(host);
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const elapsed = Date.now() - started;
      if (attempt > 0 && elapsed >= DEADLINE_MS) break;
      try {
        const res = await fetchOnce(url, headers, Math.max(DEADLINE_MS - elapsed, 500));
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
        // An abort is our own timer firing, not a transient network fault: the query was
        // too expensive for the index, and asking again changes nothing but the wait.
        if (isAbort(err)) {
          lastError = new TimeoutError(url, Date.now() - started);
          break;
        }
        if (attempt === MAX_RETRIES) break;
        await sleep(400 * 2 ** attempt + Math.random() * 250);
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new TimeoutError(url, Date.now() - started);
  } finally {
    release(host);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
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

/**
 * Cached JSON GET against the GitHub API.
 *
 * Deliberately unauthenticated. The only call that lands here is the creator-docs file tree,
 * fetched once and then kept on disk for a day, so it never approaches the anonymous rate
 * limit — and a server that reads public forums has no business asking anyone for a token.
 */
export async function getGithubJson<T>(url: string, ttl: number = TTL.static): Promise<T> {
  const key = `gh:${url}`;
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const res = await request(url, {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  });
  const data = (await res.json()) as T;
  cacheSet(key, data, ttl);
  return data;
}
