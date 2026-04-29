export interface CacheEntry<V> {
  value: V;
  ts: number;
  etag?: string;
}

export interface CacheOptions {
  ttlMs: number;
  max: number;
}

export class LruCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly keys: string[] = [];
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(opts: CacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.max = opts.max;
  }

  get(key: string): CacheEntry<V> | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Returns the entry even if expired (for stale-while-revalidate). */
  peek(key: string): CacheEntry<V> | undefined {
    return this.store.get(key);
  }

  isStale(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.ts > this.ttlMs;
  }

  set(key: string, value: V, etag?: string): void {
    if (this.store.has(key)) {
      const idx = this.keys.indexOf(key);
      if (idx >= 0) this.keys.splice(idx, 1);
    } else if (this.keys.length >= this.max) {
      const oldest = this.keys.shift();
      if (oldest !== undefined) this.store.delete(oldest);
    }
    const entry: CacheEntry<V> = { value, ts: Date.now() };
    if (etag !== undefined) entry.etag = etag;
    this.store.set(key, entry);
    this.keys.push(key);
  }

  /** Update timestamp without changing value (used for 304 hits). */
  touch(key: string): void {
    const entry = this.store.get(key);
    if (!entry) return;
    entry.ts = Date.now();
  }

  delete(key: string): void {
    this.store.delete(key);
    const idx = this.keys.indexOf(key);
    if (idx >= 0) this.keys.splice(idx, 1);
  }

  clear(): void {
    this.store.clear();
    this.keys.length = 0;
  }

  size(): number {
    return this.store.size;
  }
}

/** Stable cache key: host + pathname + sorted query string. */
export function normalizeCacheKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
    return `${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return rawUrl;
  }
}
