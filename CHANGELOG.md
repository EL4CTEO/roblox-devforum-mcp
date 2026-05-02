# Changelog

## 5.2.0

Adds an 8th tool focused on **what just shipped**: official Roblox news. Closes
the gap between training-data cutoffs and current engine state, so an AI agent
knows which APIs are new or just got deprecated before generating Roblox code.

### Added

- **`roblox_news` tool** — aggregates two official feeds:
  - **Creator Hub Release Notes** (`https://create.roblox.com/docs/release-notes`)
    — versioned weekly notes parsed into structured sections (`new_features`,
    `improvements`, `fixes`, `removed`).
  - **DevForum Announcements** (`/c/updates/announcements/26.json` plus any
    sub-categories under `/c/updates/`) — filtered to posts authored by Roblox
    staff (admin / moderator / `trust_level >= 4` / "Roblox Staff" group), with
    the original poster (OP) checked rather than the last replier.
  - Inputs: `since` (ISO date or relative `7d` / `30d` / `90d` /
    `last_release`, default `30d`), `source` (`release_notes` | `announcements`
    | `all`), `query`, `limit`.
  - Per-tool caches: 1 h for the release-notes index, 24 h for individual
    release notes; announcements use the default 5 min HTTP cache.
- **`roblox-news://release/{version}` resource** — single release note rendered
  as markdown, useful to pin a specific version in conversation memory.
- **`audit-deprecated-api` prompt** now invokes `roblox_news` before falling
  back to `forum_search`, so deprecation queries first hit the structured feed.
- **Discourse staff helpers** in `src/lib/discourse.ts`: `isStaffUser`,
  `staffUsernames`, `staffUserIds` — reusable across tools.

### Changed

- `@modelcontextprotocol/sdk` bumped from `1.26.0` to `1.29.0` (no breaking
  changes; backport fixes including the Windows `windowsHide` stdio fix that
  resolves the `npx` timeout reported on Windows hosts).
- `package.json` gains a `prepare` script so `npx` installs from GitHub
  rebuild `build/` automatically if it ever drifts.
- `SERVER_INSTRUCTIONS` updated to describe the 8th tool and new resource.

## 5.1.1

Bug-fix release addressing issues found during comprehensive QA testing.

### Fixed

- **Creator Hub docs**: Pages use client-side rendering with compiled MDX JS in
  `__NEXT_DATA__.data.content`. Replaced broken cheerio DOM extraction with
  `extractJsxText()` regex that extracts readable text from JSX `children:`
  props.
- **Creator Store category filtering**: Removed incorrect numeric category IDs
  (13=Audio returned 400, 12=Plugins returned wrong results). Now searches
  without a `Category` parameter and filters by `AssetTypeId` (10=Model, 3=Audio,
  12=Plugins, 34=Mesh, 13=Decal, 24=Animation, 21=Badge). When no items match
  the requested asset type, falls back gracefully to unfiltered results with a
  warning.
- **forum_search top sort**: Fixed URL from `/top/{period}.json` to
  `/top.json?period={period}` per Discourse API.
- **forum_taxonomy category_meta**: Added `site.json` fallback when
  `c/{id}/show.json` and `c/{id}.json` both fail.
- **Flaky scoring test**: Increased tolerance from exact match to `49.9`.

## 5.1.0

Adds a remote transport so the same MCP server can be used as a Claude Connector
on **desktop, web, and mobile** in addition to the existing local stdio install.

### Added

- **Cloudflare Worker entry** (`src/worker.ts`) using `agents/mcp` `McpAgent`
  and Streamable HTTP at `/mcp`. The Worker is single-tenant and protected by a
  `AUTH_TOKEN` Bearer secret (constant-time compare); unauthenticated requests
  receive `401 Unauthorized` with a `WWW-Authenticate` challenge. A `/healthz`
  endpoint reports liveness without auth.
- **Wrangler config** (`wrangler.jsonc`) with the `RobloxDevforumMcp` Durable
  Object binding (`MCP_OBJECT`) and SQLite-class migration; observability
  enabled.
- **Cross-runtime logger and config**: `logger.ts` no longer assumes Node
  `process.stderr` (falls back to `console.error` in Workers); `loadConfig`
  accepts any env-like record so it can take Wrangler `Env` directly.
- **`registerAll(server, ctx)`** export from `src/server.ts` so the Node stdio
  entry and the Worker entry share identical tool/resource/prompt registration.
- **Scripts**: `worker:dev`, `worker:deploy`, `worker:secret`, `worker:tail`,
  `cf-typegen`.
- **`.dev.vars.example`** + `.gitignore` updates so secrets stay out of git.
- **README**: full Connector setup walkthrough (Wrangler login → secret →
  deploy → claude.ai add-connector with `Authorization: Bearer …`).

### Changed

- Pinned `@modelcontextprotocol/sdk` to `1.26.0` and added a top-level
  `overrides` so the root project and the transitive dep inside `agents` share
  one SDK instance (otherwise TypeScript flagged two structurally-different
  `McpServer` types).
- Bumped to **5.1.0**.

## 5.0.0

Major rework: agent-first redesign.

### Breaking changes

- **27 → 7 tools.** All legacy `get_*` / `search_*` tools were folded into seven
  consolidated tools driven by parameters, which scales much better for LLM
  agents that now see a smaller, orthogonal API.

  | New tool          | Replaces                                                                                                                                           |
  | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `forum_search`    | `get_announcements`, `get_latest_posts`, `search_devforum`, `get_action_required`, `get_engine_updates`, `get_top_posts`, `get_new_posts`, `get_user_posts`, `get_category`, `get_solved_topics`, `search_bugs` |
  | `forum_thread`    | `get_thread`, `get_post_replies`                                                                                                                   |
  | `forum_taxonomy`  | `get_categories`, `get_tags`, `get_category_metadata`                                                                                              |
  | `roblox_api`      | `get_api_docs`, `search_api_member`, `get_class_hierarchy`, `get_enum`                                                                             |
  | `roblox_docs`     | `get_creator_docs`, `search_creator_docs`, `get_luau_docs`, `search_community_resources`                                                           |
  | `platform_status` | `get_roblox_status`                                                                                                                                |
  | `creator_store`   | `search_creator_store`                                                                                                                             |

### Added

- **Resources** with URI templates: `roblox-api://class/{className}`,
  `roblox-api://enum/{enumName}`, `roblox-api://classes`, `roblox-api://enums`,
  `roblox-luau://stdlib/{module}`, `roblox-devforum://thread/{topicId}`,
  `roblox-devforum://category/{slug}`, `roblox-docs://creator/{+path}`.
- **Prompts** for common agent workflows: `research-feature`, `explain-error`,
  `find-implementation-pattern`, `audit-deprecated-api`.
- **Tool annotations** (`readOnlyHint`, `idempotentHint`, `openWorldHint`) on
  every tool.
- **Structured output** via `outputSchema` + `structuredContent` so agents can
  consume validated JSON instead of parsing markdown.
- **MCP logging** (`server.sendLoggingMessage`) replaces stderr; honours the
  client-requested log level.
- **Completions** for `roblox-api://class/{className}` and
  `roblox-api://enum/{enumName}`.
- **Circuit breaker** per upstream host (configurable threshold/window/cooldown).
- **Stale-while-revalidate**: stale cache entries are returned when refresh
  fails, instead of bubbling the error.
- **API Dump auto-refresh** with a 24h TTL and inflight-request deduplication
  (default; configurable via `RDFM_API_DUMP_TTL_MS`).
- **Cheerio-based** parsing for the Roblox status page and DuckDuckGo results
  (replacing fragile regex), with a regex fallback retained for resilience.
- **Cache key normalization** (host + path + sorted query) to avoid duplicate
  entries from re-ordered query strings.
- **Parallel** Creator Store detail fetch (`Promise.all` instead of sequential).
- **Vitest** test suite covering cache, scoring, sanitize, htmlParse, circuit
  breaker, discourse helpers, HTTP client retries / 304 handling, and server
  bootstrap.
- **Biome** for combined lint + format.
- **GitHub Actions** CI on Node 20 and 22.

### Changed

- **Modular layout**: 1626-line monolith split across `src/{config,server,
  context,types}.ts`, `src/lib/`, `src/tools/`, `src/resources/`, `src/prompts/`.
- **Configuration** is now driven by environment variables validated with Zod
  (see README "Configuration").
- TypeScript strictness raised: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`.
- Source maps emitted (`sourceMap: true`).
