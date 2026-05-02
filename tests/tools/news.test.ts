import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { ApiDumpStore } from "../../src/lib/apiDump.js";
import { LruCache } from "../../src/lib/cache.js";
import { HttpClient } from "../../src/lib/http.js";
import { createLogger } from "../../src/lib/logger.js";
import { register as registerNews } from "../../src/tools/news.js";
import { createMockFetch, jsonResponse, textResponse } from "../helpers/mockFetch.js";

function makeCtx(fetchImpl: typeof fetch): AppContext {
  const config = loadConfig({
    RDFM_BASE_BACKOFF_MS: "1",
    RDFM_FETCH_TIMEOUT_MS: "2000",
    RDFM_MAX_RETRIES: "0",
    RDFM_LOG_LEVEL: "error",
  } as NodeJS.ProcessEnv);
  const logger = createLogger("error");
  const textCache = new LruCache<string>({ ttlMs: 1000, max: 50 });
  const http = new HttpClient({ config, logger, textCache, fetchImpl });
  const apiDump = new ApiDumpStore(http, config, logger);
  return { config, logger, http, apiDump, textCache };
}

interface CapturedTool {
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function captureTool(): {
  server: McpServer;
  captured: CapturedTool;
} {
  const captured: CapturedTool = {
    handler: async () => ({ content: [] }),
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const original = server.registerTool.bind(server);
  // Wrap registerTool to capture the handler reference for direct invocation in tests.
  server.registerTool = ((name, schema, handler) => {
    captured.handler = handler as typeof captured.handler;
    return original(name, schema, handler);
  }) as typeof server.registerTool;
  return { server, captured };
}

function makeReleaseHtml(version: string, date: string, title: string): string {
  const doc = {
    title,
    description: `Weekly update for release ${version}.`,
    body: [
      { text: "## New Features\n- Added FooService\n- Added BarService" },
      { text: "## Improvements\n- Faster startup" },
      { text: "## Fixes\n- Fixed Workspace crash" },
      { text: "## Removed / Deprecated\n- BodyVelocity removed" },
    ],
    metadata: { date },
  };
  const next = { props: { pageProps: { doc } } };
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></head></html>`;
}

const RECENT_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return d.toISOString().slice(0, 10);
})();

describe("roblox_news tool", () => {
  it("returns release notes + staff announcements, filters non-staff", async () => {
    const mock = createMockFetch();
    const ctx = makeCtx(mock.fn);
    const { server, captured } = captureTool();
    registerNews(server, ctx);

    mock.on("/docs/release-notes", (url) => {
      if (url.includes("release-notes-674")) {
        return textResponse(makeReleaseHtml("674", RECENT_DATE, "Release 674"));
      }
      return textResponse(`
        <a href="/docs/release-notes/release-notes-674">Release 674</a>
      `);
    });

    mock.on("/c/updates/announcements/26.json", () =>
      jsonResponse({
        users: [
          { id: 1, username: "Roblox", admin: true },
          { id: 2, username: "RandomDev" },
        ],
        topic_list: {
          topics: [
            {
              id: 100,
              slug: "important-update",
              title: "Important platform update",
              created_at: RECENT_DATE,
              posters: [{ user_id: 1 }],
              excerpt: "Big news today.",
            },
            {
              id: 101,
              slug: "user-question",
              title: "Random user post",
              created_at: RECENT_DATE,
              posters: [{ user_id: 2 }],
              excerpt: "Asking a question.",
            },
          ],
        },
      })
    );

    mock.on("/c/updates.json", () =>
      jsonResponse({
        category_list: { categories: [] },
      })
    );

    const result = await captured.handler({
      since: "30d",
      source: "all",
      limit: 10,
    });

    const structured = result.structuredContent as {
      items: { type: string; title: string; version?: string }[];
      total: number;
    };
    expect(structured.items.length).toBe(2);
    const titles = structured.items.map((i) => i.title);
    expect(titles).toContain("Important platform update");
    expect(titles).not.toContain("Random user post");
    const release = structured.items.find((i) => i.type === "release_note");
    expect(release?.version).toBe("674");
  });

  it("filters out items older than `since`", async () => {
    const mock = createMockFetch();
    const ctx = makeCtx(mock.fn);
    const { server, captured } = captureTool();
    registerNews(server, ctx);

    mock.on("/docs/release-notes", (url) => {
      if (url.includes("release-notes-")) {
        const m = url.match(/release-notes-(\d+)/);
        const v = m?.[1] ?? "0";
        // Old release: 365 days ago
        return textResponse(makeReleaseHtml(v, "2024-01-15", `Release ${v}`));
      }
      return textResponse(`<a href="/docs/release-notes/release-notes-500">500</a>`);
    });

    mock.on("/c/updates/announcements/26.json", () =>
      jsonResponse({ users: [], topic_list: { topics: [] } })
    );
    mock.on("/c/updates.json", () => jsonResponse({ category_list: { categories: [] } }));

    const result = await captured.handler({
      since: "7d",
      source: "release_notes",
      limit: 10,
    });
    const structured = result.structuredContent as { items: unknown[]; total: number };
    expect(structured.items.length).toBe(0);
    expect(structured.total).toBe(0);
  });

  it("applies query filter on title and summary", async () => {
    const mock = createMockFetch();
    const ctx = makeCtx(mock.fn);
    const { server, captured } = captureTool();
    registerNews(server, ctx);

    mock.on("/docs/release-notes", () => textResponse("<html></html>"));
    mock.on("/c/updates/announcements/26.json", () =>
      jsonResponse({
        users: [{ id: 1, username: "Roblox", admin: true }],
        topic_list: {
          topics: [
            {
              id: 200,
              slug: "open-cloud-news",
              title: "Open Cloud now supports XYZ",
              created_at: RECENT_DATE,
              posters: [{ user_id: 1 }],
              excerpt: "Open Cloud expansion.",
            },
            {
              id: 201,
              slug: "studio-news",
              title: "Studio plugin update",
              created_at: RECENT_DATE,
              posters: [{ user_id: 1 }],
              excerpt: "New plugin features.",
            },
          ],
        },
      })
    );
    mock.on("/c/updates.json", () => jsonResponse({ category_list: { categories: [] } }));

    const result = await captured.handler({
      since: "30d",
      source: "announcements",
      query: "open cloud",
      limit: 10,
    });
    const structured = result.structuredContent as { items: { title: string }[] };
    expect(structured.items.length).toBe(1);
    expect(structured.items[0]?.title).toContain("Open Cloud");
  });
});
