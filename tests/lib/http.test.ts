import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { LruCache } from "../../src/lib/cache.js";
import { HttpClient, HttpError } from "../../src/lib/http.js";
import { createLogger } from "../../src/lib/logger.js";
import { createMockFetch, jsonResponse } from "../helpers/mockFetch.js";

function makeClient() {
  const config = loadConfig({
    RDFM_BASE_BACKOFF_MS: "1",
    RDFM_FETCH_TIMEOUT_MS: "2000",
    RDFM_MAX_RETRIES: "1",
  } as NodeJS.ProcessEnv);
  const logger = createLogger("error");
  const cache = new LruCache<string>({ ttlMs: 1000, max: 50 });
  const mock = createMockFetch();
  const http = new HttpClient({ config, logger, textCache: cache, fetchImpl: mock.fn });
  return { http, mock, cache };
}

describe("HttpClient", () => {
  it("caches successful JSON responses", async () => {
    const { http, mock } = makeClient();
    mock.on("/api", () => jsonResponse({ ok: 1 }));
    const a = await http.getJson<{ ok: number }>("https://x.test/api");
    const b = await http.getJson<{ ok: number }>("https://x.test/api");
    expect(a.ok).toBe(1);
    expect(b.ok).toBe(1);
    expect(mock.calls.length).toBe(1);
  });

  it("throws HttpError on 404", async () => {
    const { http, mock } = makeClient();
    mock.on("/missing", () => new Response("nope", { status: 404 }));
    await expect(http.getJson("https://x.test/missing")).rejects.toBeInstanceOf(HttpError);
  });

  it("retries transient errors", async () => {
    const { http, mock } = makeClient();
    let n = 0;
    mock.on("/flaky", () => {
      n += 1;
      if (n === 1) throw new Error("fetch failed");
      return jsonResponse({ ok: 1 });
    });
    const data = await http.getJson<{ ok: number }>("https://x.test/flaky");
    expect(data.ok).toBe(1);
    expect(n).toBe(2);
  });

  it("falls back to next URL on failure", async () => {
    const { http, mock } = makeClient();
    mock.on("/a", () => new Response("err", { status: 500 }));
    mock.on("/b", () => jsonResponse({ ok: 1 }));
    const data = await http.getJsonWithFallback<{ ok: number }>([
      "https://x.test/a",
      "https://x.test/b",
    ]);
    expect(data.ok).toBe(1);
  });

  it("treats 304 as cached hit", async () => {
    const { http, mock } = makeClient();
    let etagSeen: string | undefined;
    mock.on("/etag", (_url, init) => {
      const ifMatch = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
      if (ifMatch) {
        etagSeen = ifMatch;
        return new Response(null, { status: 304 });
      }
      return jsonResponse({ v: 1 }, { headers: { ETag: 'W/"1"' } });
    });
    const a = await http.getJson<{ v: number }>("https://x.test/etag", { etag: true });
    expect(a.v).toBe(1);
    // Force expiry of cache entry
    vi.useFakeTimers();
    vi.advanceTimersByTime(2000);
    const b = await http.getJson<{ v: number }>("https://x.test/etag", { etag: true });
    expect(b.v).toBe(1);
    expect(etagSeen).toBe('W/"1"');
    vi.useRealTimers();
  });
});
