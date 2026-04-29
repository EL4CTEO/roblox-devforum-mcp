import { describe, expect, it, vi } from "vitest";
import { LruCache, normalizeCacheKey } from "../../src/lib/cache.js";

describe("LruCache", () => {
  it("stores and retrieves values within ttl", () => {
    const c = new LruCache<string>({ ttlMs: 1000, max: 10 });
    c.set("k", "v");
    expect(c.get("k")?.value).toBe("v");
  });

  it("returns undefined past ttl", () => {
    vi.useFakeTimers();
    const c = new LruCache<string>({ ttlMs: 100, max: 10 });
    c.set("k", "v");
    vi.advanceTimersByTime(150);
    expect(c.get("k")).toBeUndefined();
    vi.useRealTimers();
  });

  it("peek returns stale entries", () => {
    vi.useFakeTimers();
    const c = new LruCache<string>({ ttlMs: 100, max: 10 });
    c.set("k", "v");
    vi.advanceTimersByTime(150);
    const stale = c.peek("k");
    expect(stale?.value).toBe("v");
    if (!stale) throw new Error("expected entry");
    expect(c.isStale(stale)).toBe(true);
    vi.useRealTimers();
  });

  it("evicts oldest when reaching max", () => {
    const c = new LruCache<string>({ ttlMs: 1000, max: 2 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")?.value).toBe("2");
    expect(c.get("c")?.value).toBe("3");
  });

  it("re-inserts existing key updating recency", () => {
    const c = new LruCache<string>({ ttlMs: 1000, max: 2 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("a", "1b"); // bump 'a'
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")?.value).toBe("1b");
  });

  it("touch extends ttl", () => {
    vi.useFakeTimers();
    const c = new LruCache<string>({ ttlMs: 100, max: 10 });
    c.set("k", "v");
    vi.advanceTimersByTime(80);
    c.touch("k");
    vi.advanceTimersByTime(50);
    expect(c.get("k")?.value).toBe("v");
    vi.useRealTimers();
  });
});

describe("normalizeCacheKey", () => {
  it("sorts query params", () => {
    expect(normalizeCacheKey("https://x.test/p?b=2&a=1")).toBe(
      normalizeCacheKey("https://x.test/p?a=1&b=2")
    );
  });

  it("preserves path and host", () => {
    expect(normalizeCacheKey("https://x.test/foo?z=1")).toBe("x.test/foo?z=1");
  });

  it("falls back to raw url on parse failure", () => {
    expect(normalizeCacheKey("not a url")).toBe("not a url");
  });
});
