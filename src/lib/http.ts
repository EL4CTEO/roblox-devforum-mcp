import type { Config } from "../config.js";
import { COMMON_HEADERS } from "../config.js";
import { type LruCache, normalizeCacheKey } from "./cache.js";
import { CircuitBreaker, hostOf } from "./circuit.js";
import type { Logger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class CircuitOpenError extends Error {
  constructor(host: string) {
    super(`Circuit breaker open for ${host}; failing fast`);
    this.name = "CircuitOpenError";
  }
}

export interface FetchOptions {
  json?: boolean;
  etag?: string | undefined;
  retries?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface HttpClientDeps {
  config: Config;
  logger: Logger;
  textCache: LruCache<string>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_FETCH: typeof fetch = (...args) => fetch(...args);

export class HttpClient {
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly cache: LruCache<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;

  constructor(deps: HttpClientDeps) {
    this.cfg = deps.config;
    this.logger = deps.logger;
    this.cache = deps.textCache;
    this.fetchImpl = deps.fetchImpl ?? DEFAULT_FETCH;
    this.breaker = new CircuitBreaker(
      deps.config.RDFM_CIRCUIT_THRESHOLD,
      deps.config.RDFM_CIRCUIT_WINDOW_MS,
      deps.config.RDFM_CIRCUIT_COOLDOWN_MS
    );
  }

  private buildHeaders(json: boolean, etag?: string): Record<string, string> {
    const headers: Record<string, string> = json
      ? { ...COMMON_HEADERS, "User-Agent": this.cfg.RDFM_USER_AGENT }
      : { "User-Agent": this.cfg.RDFM_USER_AGENT };
    if (etag) headers["If-None-Match"] = etag;
    return headers;
  }

  async raw(url: string, opts: FetchOptions = {}): Promise<Response> {
    const host = hostOf(url);
    if (this.breaker.isOpen(host)) throw new CircuitOpenError(host);

    const json = opts.json ?? false;
    const retries = opts.retries ?? this.cfg.RDFM_MAX_RETRIES;
    const headers = this.buildHeaders(json, opts.etag);

    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.RDFM_FETCH_TIMEOUT_MS);

      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort);

      try {
        const res = await this.fetchImpl(url, {
          headers,
          signal: controller.signal,
        });

        if (res.status === 429) {
          this.logger.warning("Rate limited", { url, attempt });
          if (attempt === retries) {
            this.breaker.recordFailure(host);
            throw new HttpError("Rate limited", 429, url);
          }
          await this.backoff(attempt);
          continue;
        }

        if (res.status === 304) {
          this.breaker.recordSuccess(host);
          return res;
        }

        if (!res.ok) {
          if (res.status === 404) {
            throw new HttpError(`Not found: ${url}`, 404, url);
          }
          throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
        }

        this.breaker.recordSuccess(host);
        return res;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const transient =
          lastErr.name === "AbortError" ||
          lastErr.message.includes("fetch failed") ||
          lastErr.message.includes("network");
        if (transient && attempt < retries) {
          this.logger.debug("Retrying transient error", {
            url,
            attempt,
            error: lastErr.message,
          });
          await this.backoff(attempt);
          continue;
        }
        if (lastErr instanceof HttpError && lastErr.status === 404) {
          throw lastErr;
        }
        if (lastErr instanceof CircuitOpenError) throw lastErr;
        this.breaker.recordFailure(host);
        throw lastErr;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }

    if (lastErr) throw lastErr;
    throw new Error(`Too many retries: ${url}`);
  }

  private async backoff(attempt: number): Promise<void> {
    const base = this.cfg.RDFM_BASE_BACKOFF_MS;
    const jitter = Math.random() * base;
    const delay = base * 2 ** attempt + jitter;
    await new Promise((r) => setTimeout(r, delay));
  }

  async getJson<T>(url: string, opts: { etag?: boolean; cache?: boolean } = {}): Promise<T> {
    const useCache = opts.cache ?? true;
    const key = useCache ? `json::${normalizeCacheKey(url)}` : "";
    const cached = useCache ? this.cache.peek(key) : undefined;

    if (useCache && cached && !this.cache.isStale(cached)) {
      return JSON.parse(cached.value) as T;
    }

    try {
      const res = await this.raw(url, {
        json: true,
        etag: opts.etag && cached ? cached.etag : undefined,
      });

      if (res.status === 304 && cached) {
        this.cache.touch(key);
        return JSON.parse(cached.value) as T;
      }

      const text = await res.text();
      if (useCache) {
        this.cache.set(key, text, res.headers.get("ETag") ?? undefined);
      }
      return JSON.parse(text) as T;
    } catch (e) {
      if (useCache && cached) {
        this.logger.warning("Serving stale cache after fetch error", {
          url,
          error: e instanceof Error ? e.message : String(e),
        });
        return JSON.parse(cached.value) as T;
      }
      throw e;
    }
  }

  async getJsonWithFallback<T>(urls: string[]): Promise<T> {
    let lastErr: Error | undefined;
    for (const url of urls) {
      try {
        return await this.getJson<T>(url);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (lastErr instanceof HttpError && lastErr.status === 429) {
          throw lastErr;
        }
      }
    }
    throw lastErr ?? new Error(`All endpoints failed: ${urls.join(", ")}`);
  }

  async getHtml(url: string, opts: { cache?: boolean } = {}): Promise<string> {
    const useCache = opts.cache ?? true;
    const key = useCache ? `html::${normalizeCacheKey(url)}` : "";
    if (useCache) {
      const cached = this.cache.get(key);
      if (cached) return cached.value;
    }
    const res = await this.raw(url, { json: false });
    const text = await res.text();
    if (useCache) this.cache.set(key, text);
    return text;
  }
}
