# roblox-devforum-mcp

MCP server for the [Roblox Developer Forum](https://devforum.roblox.com), [Creator Hub Docs](https://create.roblox.com), [Roblox API Dump](https://github.com/MaximumADHD/Roblox-Client-Tracker), and [Roblox Status](https://status.roblox.com). 23 tools for DevForum search, API reference, bug reports, engine updates, Creator Hub docs, and platform status.

No authentication required — all endpoints are public.

## Features

- **Creator Hub `__NEXT_DATA__` extraction** — fetches structured documentation from create.roblox.com without JavaScript rendering
- **API Dump** — full Roblox engine class docs with properties, methods, events, callbacks, and inheritance
- **Search scoring** — relevance-ranked results with category weighting and accepted answer boost
- **Rate limit resilience** — exponential backoff with jitter, 3 retries, inflight deduplication
- **Caching** — 5-min TTL, 200-entry LRU cache

## Tools

### DevForum (12)

| Tool | Description |
|------|-------------|
| `get_announcements` | Latest DevForum announcements |
| `get_latest_posts` | Latest posts, optionally filtered by category |
| `get_search_devforum` | Search topics by query with category filter |
| `get_thread` | Read a specific thread (first post + metadata + accepted answer) |
| `get_post_replies` | Thread replies (paginated) |
| `get_action_required` | Topics tagged action-required |
| `get_engine_updates` | Roblox engine & Studio release notes |
| `get_category` | Topics from a specific category |
| `get_category_metadata` | Category metadata, subcategories, moderators |
| `get_top_posts` | Top posts by time period |
| `get_new_posts` | Newest topics (chronological) |
| `get_user_posts` | Recent activity for a user |

### Search (4)

| Tool | Description |
|------|-------------|
| `search_devforum` | General DevForum search with solved indicators |
| `search_bugs` | Search bug reports (studio-bugs / engine-bugs) |
| `get_solved_topics` | Search solved topics (preferred for debugging) |
| `search_community_resources` | Search community tutorials and resources |

### Creator Hub & Docs (4)

| Tool | Description |
|------|-------------|
| `get_creator_docs` | Fetch Creator Hub docs with `__NEXT_DATA__` structured extraction |
| `search_creator_docs` | Search Creator Hub docs with relevance scoring |
| `get_luau_docs` | Luau standard library reference (math, string, table, task, etc.) |
| `get_api_docs` | Full Roblox engine class documentation (properties, methods, events, callbacks, inheritance) |

### API Reference (3)

| Tool | Description |
|------|-------------|
| `search_api_member` | Search for a member by name across ALL Roblox API classes |
| `get_class_hierarchy` | Full inheritance tree for any Roblox class |
| `get_enum` | List all enums or get values for a specific enum |

### Platform (1)

| Tool | Description |
|------|-------------|
| `get_roblox_status` | Current status of Roblox services |

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
