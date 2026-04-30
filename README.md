# roblox-devforum-mcp

MCP server for the Roblox developer ecosystem — DevForum, API reference, Creator Hub docs, Luau stdlib, Creator Store, platform status. **7 tools, 8 resources, 4 prompts.** No API keys needed.

## Install for Claude Desktop

### 1. Open settings

Claude Desktop → **File** → **Settings** (or `Ctrl+,`)

### 2. Go to Developer tab

Click **Developer** in the left sidebar, then **Edit Config**.

### 3. Paste the config

Replace the file contents with:

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

### 4. Restart Claude Desktop

Quit and reopen. First launch downloads and builds (~30s). The hammer icon <img src="https://mintcdn.com/mcp/2BMHnlNW5OqOohXZ/images/claude-desktop-mcp-slider.svg" style="height:1.2em;vertical-align:middle" /> appears in the chat input when ready.

---

### Windows

If `npx` times out, clone locally instead:

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install && npm run build
```

Then use the local path in step 3:

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

## Install for opencode

Add to `opencode.json`:

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

## Install for Claude Code

```bash
claude mcp add roblox-devforum -- npx -y github:EL4CTEO/roblox-devforum-mcp
```

## Install as Cloudflare Worker

Use on desktop, web, and mobile via claude.ai Connectors.

```bash
npx wrangler login
npm run worker:secret          # set AUTH_TOKEN
npm run worker:deploy          # prints your Worker URL
```

In claude.ai → Settings → Connectors → **Add custom connector**:
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
