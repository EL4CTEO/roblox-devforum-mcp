# roblox-devforum-mcp

MCP server that gives AI agents full context on the Roblox developer ecosystem — DevForum, API reference, Creator Hub docs, Luau stdlib, Creator Store, and platform status. **7 tools, 8 resources, 4 prompts.** No API keys needed.

## Quick start

No clone required. For most users, just paste a block into your MCP client config.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "npx",
      "args": ["-y", "github:EL4CTEO/roblox-devforum-mcp"]
    }
  }
}
```

First launch takes ~30s to download and build. Subsequent launches are instant.

### opencode

`opencode.json`:

```json
{
  "mcp": {
    "roblox-devforum": {
      "type": "local",
      "command": ["npx", "-y", "github:EL4CTEO/roblox-devforum-mcp"]
    }
  }
}
```

### Windows

If `npx` times out on first launch, clone locally instead:

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install && npm run build
```

Then use the local path in your config:

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "node",
      "args": ["C:/path/to/roblox-devforum-mcp/build/index.js"]
    }
  }
}
```

### Cloudflare Worker (desktop / web / mobile)

```bash
npx wrangler login
npm run worker:secret
npm run worker:deploy
```

claude.ai → Settings → Connectors → Add custom connector:
- URL: `https://roblox-devforum-mcp.YOURNAME.workers.dev/mcp`
- Header: `Authorization: Bearer YOUR_AUTH_TOKEN`

## Tools

| Tool | Use when |
|------|----------|
| `forum_search` | Find DevForum threads with filters (solved, bugs, category, tag, period, sort, user) |
| `forum_thread` | Read a thread, its accepted answer, and replies |
| `forum_taxonomy` | Browse categories, tags, or get a category's metadata |
| `roblox_api` | Look up any class, member, enum, or inheritance chain from the live API dump |
| `roblox_docs` | Read Creator Hub guides, Luau stdlib, or community tutorials |
| `platform_status` | Check if Roblox services are operational |
| `creator_store` | Search models, audio, plugins, meshes, decals, animations, badges |

Every tool returns both readable markdown and a structured JSON payload.

## Resources

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

- **`research-feature`** — class lookup → solved threads → known bugs → guides
- **`explain-error`** — debug pipeline using solved DevForum evidence
- **`find-implementation-pattern`** — docs + tutorials + proven patterns
- **`audit-deprecated-api`** — deprecation status + migration guides

## Local development

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

```bash
npm run typecheck    # tsc --noEmit
npm run test         # vitest (45 tests)
npm run check        # lint + typecheck + test
npm run build        # tsc → build/
```

## Environment variables

All optional. Set via MCP client `env` field (stdio) or Wrangler secrets/vars (Worker).

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTH_TOKEN` | — | Worker Bearer token |
| `RDFM_LOG_LEVEL` | `info` | `debug` / `info` / `warning` / `error` |
| `RDFM_FETCH_TIMEOUT_MS` | `15000` | Request timeout |
| `RDFM_CACHE_TTL_MS` | `300000` | Cache TTL (5 min) |

## Requirements

Node.js >= 20

## License

UNLICENSED — private use
