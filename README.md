# roblox-devforum-mcp

State-of-the-art MCP server for the Roblox developer workflow. **27 tools** covering DevForum, Creator Hub Docs, API Dump, Luau Standard Library, Creator Store, and Platform Status. No authentication required.

## Features

- **Real API Enum values** — actual integer values from Full-API-Dump.json (e.g. `Plastic = 256`)
- **Creator Store asset details** — name, creator, price via economy API
- **Accepted answer extraction** — solved threads show the accepted reply inline
- **Object tag formatting** — handles `{read, write}` security objects (no `[object Object]`)
- **Creator Hub `__NEXT_DATA__` extraction** — structured docs without JS rendering
- **Roblox Status HTML scraping** — live component status + active incidents
- **Luau standard library scraping** — function signatures from luau-lang.org
- **Site-search fallback** — DuckDuckGo `site:create.roblox.com` for Creator Hub docs
- **ETag conditional caching** — HTTP 304 responses extend cache TTL (LRU, 200 entries, 5min TTL)
- **Search scoring** — relevance-ranked with solved boost, category weight, recency decay
- **Rate limit resilience** — exponential backoff + jitter, 3 retries, 15s timeout
- **Per-post truncation** — `max_length` on thread replies to keep context manageable

## Tools (27)

### DevForum (12)

| Tool | Description |
|------|-------------|
| `get_announcements` | Latest DevForum announcements |
| `get_latest_posts` | Latest posts, optionally filtered by category |
| `search_devforum` | Search topics by query with `[SOLVED]` indicators |
| `get_thread` | Read a thread (first post + metadata + accepted answer) |
| `get_post_replies` | Thread replies (paginated, with `max_length` truncation) |
| `get_action_required` | Topics tagged action-required |
| `get_engine_updates` | Roblox engine & Studio release notes |
| `get_category` | Topics from a specific category by slug and ID |
| `get_category_metadata` | Category info, subcategories, moderators, topic count |
| `get_top_posts` | Top posts by period (daily/weekly/monthly/yearly/all) |
| `get_new_posts` | Newest topics (chronological) |
| `get_user_posts` | Recent activity for a DevForum user |

### Search & Debugging (4)

| Tool | Description |
|------|-------------|
| `get_solved_topics` | Search solved topics (preferred for debugging) |
| `search_bugs` | Search bug reports (studio-bugs / engine-bugs) |
| `get_categories` | List all DevForum categories with IDs and topic counts |
| `get_tags` | List all DevForum tags with topic counts |

### Creator Hub & Docs (5)

| Tool | Description |
|------|-------------|
| `get_creator_docs` | Fetch any Creator Hub doc with `__NEXT_DATA__` extraction |
| `search_creator_docs` | Search Creator Hub docs via DevForum + DuckDuckGo fallback |
| `get_luau_docs` | Luau standard library reference (math, string, table, etc.) |
| `get_api_docs` | Full Roblox engine class docs with descriptions and object tags |
| `search_community_resources` | Search community tutorials and resources |

### API Reference (3)

| Tool | Description |
|------|-------------|
| `search_api_member` | Search for a member across ALL Roblox API classes |
| `get_class_hierarchy` | Full inheritance tree (parents + subclasses) |
| `get_enum` | Inspect any Roblox enum — real Names + Values from API Dump |

### Platform & Store (3)

| Tool | Description |
|------|-------------|
| `get_roblox_status` | Current status of Roblox services with active incidents |
| `search_creator_store` | Search Creator Store for assets (name, creator, price, URL) |

## Install

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

## Configure

### Claude Desktop

Add to `claude_desktop_config.json`:

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

Add to `opencode.json`:

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

## Requirements

- Node.js >= 20.0.0
- No API keys or authentication required

## License

UNLICENSED — private use only.
