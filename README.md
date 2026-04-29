# roblox-devforum-mcp

Agent-first MCP server for the Roblox developer workflow. **7 consolidated tools** + Resources with URI templates + Prompts, covering DevForum, Creator Hub Docs, Luau standard library, Full-API-Dump, Creator Store, and Platform Status. No authentication required.

> Built to pair with the official Roblox Studio MCP server: this one supplies the *research context* (forum threads, API definitions, docs, bugs, status) that an AI agent needs while it's building inside Studio.

## Why 7 tools and not 27

LLM agents perform much better when each tool has a clear, orthogonal purpose. The previous version exposed 11 different "search the forum" tools — the new `forum_search` does all of it via parameters (`status`, `category`, `tag`, `period`, `sort`, `user`). Same for the API surface, docs surface, etc.

| Tool              | What it does                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `forum_search`    | Unified DevForum search: free-text + filters (`status:solved`, `category`, `tag`, `period`, `sort`, `user`). |
| `forum_thread`    | Thread metadata + first post + accepted answer + paginated replies (with optional truncation).            |
| `forum_taxonomy`  | List categories or tags, or fetch metadata for one category.                                              |
| `roblox_api`      | Classes / members / hierarchy / enums from the live `Full-API-Dump.json`.                                  |
| `roblox_docs`     | Creator Hub pages, Luau stdlib reference, community DevForum tutorials.                                    |
| `platform_status` | Live Roblox component status + active incidents.                                                          |
| `creator_store`   | Search the Roblox catalog (models, plugins, audio, meshes, decals, animations, badges).                    |

Every tool returns both a human-readable markdown block (in `content`) and a structured payload (in `structuredContent`) validated against an explicit `outputSchema`, so the agent can read structured fields directly instead of parsing prose.

All tools carry MCP annotations: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` — clients can parallelize them safely.

## Resources (URI templates)

Stable URIs the agent (or its host) can dereference, cite, or cache:

```
roblox-api://classes                       # index of every class
roblox-api://enums                         # index of every enum
roblox-api://class/{className}             # full class definition
roblox-api://enum/{enumName}               # enum items + integer values
roblox-luau://stdlib/{module}              # math / string / table / coroutine / bit32 / utf8 / os / debug / buffer / vector
roblox-devforum://thread/{topicId}         # full Discourse thread JSON
roblox-devforum://category/{slug}          # latest topics in a category
roblox-docs://creator/{+path}              # Creator Hub doc page
```

Class- and enum-name templates also support **completions**, so MCP clients can autocomplete names from the live API dump.

## Prompts

Pre-built workflows that an agent can invoke directly:

- `research-feature(feature)` — class lookup → solved threads → known bugs → official guides.
- `explain-error(error_message, context?)` — debug pipeline that prefers `[SOLVED]` evidence.
- `find-implementation-pattern(goal)` — Creator Docs + community tutorials + top forum patterns.
- `audit-deprecated-api(target)` — checks deprecation tags, engine update announcements, and migration guides.

## Engineering

- **Cache** — LRU (configurable size + TTL), ETag-aware (sends `If-None-Match`, treats 304 as a cache hit and extends TTL), stale-while-revalidate fallback when an upstream refresh fails.
- **API Dump** — auto-refreshed with a 24h TTL (configurable), inflight-request deduplication, falls back to stale data on transient errors.
- **HTTP client** — exponential backoff with jitter, configurable retries, per-host **circuit breaker** (5 failures in 60s opens for 30s, all configurable).
- **HTML parsing** — `cheerio` first, regex fallback retained for the Roblox status page when class names change.
- **MCP logging** — uses `notifications/message`; respects the client's `setLoggingLevel`.
- **Type safety** — `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; almost no `any` in user-visible paths.
- **Tests** — `vitest` covering cache, scoring, sanitize, htmlParse, circuit breaker, Discourse helpers, the HTTP client (retry / 304 / fallback), and server bootstrap.
- **Lint + format** — Biome, single config.
- **CI** — GitHub Actions on Node 20 and 22 (`lint → typecheck → test → build`).

## Install

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

## Configure — local (stdio)

Use this for Claude Desktop / Claude Code / opencode on the same machine. Faster than HTTP, no auth needed, no internet round-trip.

### Claude Desktop

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "node",
      "args": ["/path/to/roblox-devforum-mcp/build/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add roblox-devforum -- node /path/to/roblox-devforum-mcp/build/index.js
```

### opencode

```json
{
  "mcp": {
    "roblox-devforum": {
      "type": "local",
      "command": ["node", "/path/to/roblox-devforum-mcp/build/index.js"]
    }
  }
}
```

## Configure — remote (Claude Connector / mobile / web)

Deploy as a Cloudflare Worker so claude.ai (desktop, web, **and mobile**) can use it as a Connector. The Worker is single-tenant and protected by a Bearer token: only requests that present the token reach the MCP server. Source code stays in your private repo and your private Cloudflare account.

### One-time setup

1. **Cloudflare account** + Wrangler login (free):
   ```bash
   npx wrangler login
   ```
2. **Pick a long random token** (e.g. `openssl rand -hex 32`) and store it as a secret on the Worker:
   ```bash
   npm run worker:secret           # prompts for the token, stores it as AUTH_TOKEN
   ```
3. **Deploy**:
   ```bash
   npm run worker:deploy
   ```
   Wrangler prints the Worker URL (e.g. `https://roblox-devforum-mcp.<you>.workers.dev`). Your MCP endpoint is `<URL>/mcp`.

### Add as a Connector in claude.ai

claude.ai → Settings → Connectors → **Add custom connector**:

- **Name**: Roblox DevForum
- **URL**: `https://roblox-devforum-mcp.<you>.workers.dev/mcp`
- **Authentication**: Custom header
  - Header name: `Authorization`
  - Header value: `Bearer <your AUTH_TOKEN>`

Once added, the connector is available across desktop, web, and the mobile apps under the same account. All seven tools, the Resources, and the Prompts are exposed.

### Local Worker development

```bash
cp .dev.vars.example .dev.vars      # set AUTH_TOKEN locally (not committed)
npm run worker:dev                  # runs at http://localhost:8787
npm run worker:tail                 # stream live logs from the deployed Worker
```

### Privacy / scope

- The Worker URL is technically reachable on the public internet, but **every** request to `/mcp` requires the correct Bearer token; everything else returns `401 Unauthorized`.
- The repo stays private — Cloudflare doesn't publish your source.
- The token compares in constant time and is a Wrangler secret (never logged, never in git).

## Configuration (env vars / Wrangler vars)

All optional — sensible defaults. Set them under `env` in the MCP client config (stdio) or via `wrangler secret put` / Wrangler `[vars]` (Worker). The `AUTH_TOKEN` secret is **only** consumed by the Worker entry.

| Variable                   | Default     | Purpose                                                    |
| -------------------------- | ----------- | ---------------------------------------------------------- |
| `AUTH_TOKEN`               | _(unset)_   | Bearer token required by the Worker `/mcp` endpoint.       |
| `RDFM_LOG_LEVEL`           | `info`      | `debug` / `info` / `notice` / `warning` / `error`.         |
| `RDFM_FETCH_TIMEOUT_MS`    | `15000`     | Per-request timeout.                                       |
| `RDFM_CACHE_TTL_MS`        | `300000`    | Default cache TTL (5 minutes).                             |
| `RDFM_CACHE_MAX`           | `200`       | LRU cache size.                                            |
| `RDFM_API_DUMP_TTL_MS`     | `86400000`  | Full-API-Dump refresh interval (24 h).                     |
| `RDFM_MAX_RETRIES`         | `3`         | Retries on transient errors / 429.                         |
| `RDFM_BASE_BACKOFF_MS`     | `1000`      | Backoff base; delay = `base * 2^attempt + jitter`.         |
| `RDFM_USER_AGENT`          | `Mozilla/…` | Outgoing User-Agent.                                       |
| `RDFM_CIRCUIT_THRESHOLD`   | `5`         | Failures-in-window before the breaker trips.               |
| `RDFM_CIRCUIT_WINDOW_MS`   | `60000`     | Failure window.                                            |
| `RDFM_CIRCUIT_COOLDOWN_MS` | `30000`     | Cooldown before the breaker half-opens.                    |

## Development

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # Biome
npm run test            # Vitest
npm run check           # lint + typecheck + test
npm run build           # tsc → build/

# Cloudflare Worker
npm run worker:dev      # wrangler dev (local HTTP at :8787)
npm run worker:deploy   # wrangler deploy
npm run worker:secret   # wrangler secret put AUTH_TOKEN
npm run worker:tail     # wrangler tail (live logs)
```

## Requirements

- Node.js >= 20

## License

UNLICENSED — private use only.
