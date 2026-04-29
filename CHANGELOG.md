# Changelog

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
