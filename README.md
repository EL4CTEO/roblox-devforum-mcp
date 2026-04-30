# roblox-devforum-mcp

MCP server that gives AI agents full context on the Roblox developer ecosystem — DevForum, API reference, Creator Hub docs, Luau stdlib, Creator Store, and platform status. **7 tools, 8 resources, 4 prompts.** No API keys needed.

## Quick start

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

## Configuration

Pick your client — copy the block into your config file.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "node",
      "args": ["C:/Users/YOU/roblox-devforum-mcp/build/index.js"]
    }
  }
}
```

### opencode

`opencode.json`:

```json
{
  "mcp": {
    "roblox-devforum": {
      "type": "local",
      "command": ["node", "C:/Users/YOU/roblox-devforum-mcp/build/index.js"]
    }
  }
}
```

Windows note: use `cmd.exe /c` wrapper if Windows does not recognise `node` directly (uncomment the `"windows"` variant in `config-template.json`).

### Cloudflare Worker (desktop / web / mobile)

Deploy once, use everywhere. Same tools available via your own Worker URL.

```bash
npx wrangler login
npm run worker:secret              # set AUTH_TOKEN
npm run worker:deploy              # prints your Worker URL
```

Then in claude.ai → Settings → Connectors → Add custom connector:
- URL: `https://roblox-devforum-mcp.YOURNAME.workers.dev/mcp`
- Header: `Authorization: Bearer YOUR_AUTH_TOKEN`

## Tools

| Tool | Use when |
|------|----------|
| `forum_search` | Find DevForum threads — solved, bugs, announcements, or anything with filters |
| `forum_thread` | Read a thread, its accepted answer, and replies |
| `forum_taxonomy` | Browse categories, tags, or get a category's metadata |
| `roblox_api` | Look up any class, member, enum, or inheritance chain from the live API dump |
| `roblox_docs` | Read Creator Hub guides, Luau stdlib, or community tutorials |
| `platform_status` | Check if Roblox services are operational |
| `creator_store` | Search models, audio, plugins, meshes, decals, animations, badges |

Every tool returns both readable markdown and a structured JSON payload that agents can consume directly.

## Resources

Stable URIs for dereferencing or caching:

| URI | Returns |
|-----|---------|
| `roblox-api://classes` | All class names |
| `roblox-api://class/{Name}` | Full class definition |
| `roblox-api://enums` | All enum names |
| `roblox-api://enum/{Name}` | Enum items + values |
| `roblox-luau://stdlib/{module}` | Luau library reference |
| `roblox-devforum://thread/{id}` | Thread JSON |
| `roblox-docs://creator/{path}` | Creator Hub page |

## Prompts

Pre-built workflows agents can invoke:

- **`research-feature`** — class lookup → solved threads → known bugs → guides
- **`explain-error`** — debug pipeline using solved DevForum evidence
- **`find-implementation-pattern`** — docs + tutorials + proven patterns
- **`audit-deprecated-api`** — deprecation status + migration guides + announcements

## Engineering

- **Cache**: LRU with ETag (If-None-Match → 304 handling), stale-while-revalidate
- **HTTP**: exponential backoff + jitter, retries, per-host circuit breaker
- **API dump**: auto-refreshed (24h TTL), inflight dedup, stale fallback
- **Logging**: MCP protocol (`notifications/message`), respects client log level
- **Type safety**: strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- **Tests**: vitest (45 tests), CI on Node 20/22, Biome lint + format

## Environment variables

All optional. Set via MCP client `env` field (stdio) or Wrangler secrets/vars (Worker).

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTH_TOKEN` | — | Worker Bearer token |
| `RDFM_LOG_LEVEL` | `info` | `debug` / `info` / `warning` / `error` |
| `RDFM_FETCH_TIMEOUT_MS` | `15000` | Request timeout |
| `RDFM_CACHE_TTL_MS` | `300000` | Cache TTL (5 min) |
| `RDFM_CACHE_MAX` | `200` | Cache entries |
| `RDFM_API_DUMP_TTL_MS` | `86400000` | API dump refresh (24 h) |

## Requirements

Node.js >= 20

## License

UNLICENSED — private use
