export class LruCache {
    store = new Map();
    keys = [];
    ttlMs;
    max;
    constructor(opts) {
        this.ttlMs = opts.ttlMs;
        this.max = opts.max;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() - entry.ts > this.ttlMs) {
            this.delete(key);
            return undefined;
        }
        return entry;
    }
    /** Returns the entry even if expired (for stale-while-revalidate). */
    peek(key) {
        return this.store.get(key);
    }
    isStale(entry) {
        return Date.now() - entry.ts > this.ttlMs;
    }
    set(key, value, etag) {
        if (this.store.has(key)) {
            const idx = this.keys.indexOf(key);
            if (idx >= 0)
                this.keys.splice(idx, 1);
        }
        else if (this.keys.length >= this.max) {
            const oldest = this.keys.shift();
            if (oldest !== undefined)
                this.store.delete(oldest);
        }
        const entry = { value, ts: Date.now() };
        if (etag !== undefined)
            entry.etag = etag;
        this.store.set(key, entry);
        this.keys.push(key);
    }
    /** Update timestamp without changing value (used for 304 hits). */
    touch(key) {
        const entry = this.store.get(key);
        if (!entry)
            return;
        entry.ts = Date.now();
    }
    delete(key) {
        this.store.delete(key);
        const idx = this.keys.indexOf(key);
        if (idx >= 0)
            this.keys.splice(idx, 1);
    }
    clear() {
        this.store.clear();
        this.keys.length = 0;
    }
    size() {
        return this.store.size;
    }
}
/** Stable cache key: host + pathname + sorted query string. */
export function normalizeCacheKey(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
        const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
        return `${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
    }
    catch {
        return rawUrl;
    }
}
//# sourceMappingURL=cache.js.map