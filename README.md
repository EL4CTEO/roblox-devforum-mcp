# roblox-devforum-mcp

MCP server for [Roblox Developer Forum](https://devforum.roblox.com), [Creator Hub Docs](https://create.roblox.com), [Roblox API Dump](https://github.com/MaximumADHD/Roblox-Client-Tracker), [Roblox Status](https://status.roblox.com), and [Creator Store](https://www.roblox.com/catalog). **27 tools** with no authentication required.

## Features

- **Creator Hub `__NEXT_DATA__` extraction** — structured docs without JS rendering
- **Real API Enum values** — actual integer values from Full-API-Dump.json, not just inferred names
- **Creator Store asset search** — find models, plugins, meshes, audio by keyword
- **Site-search fallback** — DuckDuckGo `site:create.roblox.com` for Creator Hub docs
- **ETag conditional caching** — HTTP 304 responses extend cache TTL
- **Search scoring** — relevance-ranked with solved boost, category weight, recency decay
- **Rate limit resilience** — exponential backoff + jitter, 3 retries, 15s timeout
- **Per-post truncation** — `max_length` on thread replies to keep context manageable

## Tools (27)

### DevForum (12)

| Tool | Description |
|------|-------------|
| `get_announcements` | Latest DevForum announcements |
| `get_latest_posts` | Latest posts, optionally filtered by category |
| `search_devforum` | Search topics by query with solved indicators |
| `get_thread` | Read a specific thread (first post + metadata + accepted answer) |
| `get_post_replies` | Thread replies (paginated, with `max_length` truncation) |
| `get_action_required` | Topics tagged action-required |
| `get_engine_updates` | Roblox engine & Studio release notes |
| `get_category` | Topics from a specific category |
| `get_category_metadata` | Category metadata, subcategories, moderators, topic count |
| `get_top_posts` | Top posts by time period |
| `get_new_posts` | Newest topics (chronological) |
| `get_user_posts` | Recent activity for a user |

### Search & Debugging (4)

| Tool | Description |
|------|-------------|
| `search_devforum` | General DevForum search with solved indicators |
| `search_bugs` | Search bug reports (studio-bugs / engine-bugs) |
| `get_solved_topics` | Search solved topics (preferred for debugging) |
| `search_community_resources` | Search community tutorials and resources |

### Creator Hub & Docs (5)

| Tool | Description |
|------|-------------|
| `get_creator_docs` | Fetch any Creator Hub doc with `__NEXT_DATA__` structured extraction |
| `search_creator_docs` | Search Creator Hub docs via DevForum + DuckDuckGo fallback |
| `get_luau_docs` | Luau standard library reference (math, string, table, task, etc.) |
| `get_api_docs` | Full Roblox engine class docs with descriptions |
| `get_enum` | Inspect any Roblox enum — real Names + Values from API Dump |

### API Reference (3)

| Tool | Description |
|------|-------------|
| `search_api_member` | Search for a member across ALL Roblox API classes |
| `get_class_hierarchy` | Full inheritance tree (parents + subclasses) |
| `get_enum` | List or inspect enums with real values |

### Platform (2)

| Tool | Description |
|------|-------------|
| `get_roblox_status` | Current status of Roblox services |
| `search_creator_store` | Search the Creator Store for assets (models, plugins, audio, meshes) |

## Install

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

## Claude Desktop

Add to your `claude_desktop_config.json`:

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

## Claude Code

```bash
claude mcp add roblox-devforum -- node /path/to/roblox-devforum-mcp/build/index.js
```
