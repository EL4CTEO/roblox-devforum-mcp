export interface CacheEntry<V> {
    value: V;
    ts: number;
    etag?: string;
}
export interface CacheOptions {
    ttlMs: number;
    max: number;
}
export declare class LruCache<V> {
    private readonly store;
    private readonly keys;
    private readonly ttlMs;
    private readonly max;
    constructor(opts: CacheOptions);
    get(key: string): CacheEntry<V> | undefined;
    /** Returns the entry even if expired (for stale-while-revalidate). */
    peek(key: string): CacheEntry<V> | undefined;
    isStale(entry: CacheEntry<V>): boolean;
    set(key: string, value: V, etag?: string): void;
    /** Update timestamp without changing value (used for 304 hits). */
    touch(key: string): void;
    delete(key: string): void;
    clear(): void;
    size(): number;
}
/** Stable cache key: host + pathname + sorted query string. */
export declare function normalizeCacheKey(rawUrl: string): string;
