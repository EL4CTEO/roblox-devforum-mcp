# roblox-devforum-mcp

MCP server that connects to the [Roblox Developer Forum](https://devforum.roblox.com) (Discourse-based), the [Roblox API Dump](https://github.com/MaximumADHD/Roblox-Client-Tracker), and the [Roblox Status Page](https://status.roblox.com). Provides 22 tools for searching, browsing, reading DevForum posts, bug reports, engine updates, official API docs, enum reference, member search, and platform status.

No authentication required — all endpoints are public.

## Tools

### DevForum (18)

| Tool | Description |
|------|-------------|
| `get_announcements` | Latest DevForum announcements |
| `get_latest_posts` | Latest posts, optionally filtered by category |
| `search_devforum` | Search topics by query |
| `get_thread` | Read a specific thread (first post + metadata) |
| `get_post_replies` | Thread replies (single page) |
| `get_action_required` | Topics tagged action-required |
| `get_engine_updates` | Roblox engine & Studio updates |
| `get_category` | Topics from a specific category |
| `get_top_posts` | Top posts by time period |
| `get_new_posts` | Newest topics on the DevForum |
| `get_user_posts` | Recent activity for a user |
| `get_categories` | List all DevForum categories with IDs, slugs, topic counts |
| `get_category_metadata` | Category metadata, subcategories, moderators |
| `get_tags` | List all DevForum tags with topic counts |
| `search_bugs` | Search bug reports (studio-bugs / engine-bugs) |
| `get_solved_topics` | Search solved topics (preferred for debugging) |
| `search_creator_docs` | Search community tutorials and resources |
| `search_devforum` | General DevForum search with solved indicators |

### API Reference (3)

| Tool | Description |
|------|-------------|
| `get_api_docs` | Full Roblox engine class documentation (properties, methods, events, callbacks, inheritance chain) |
| `search_api_member` | Search for a property, method, event, or callback by name across ALL Roblox API classes |
| `get_enums` | List all Roblox API enums with optional filter |
| `get_enum_values` | Get all values for a specific enum (e.g. "Material" → Plastic, Wood, Slate...) |

### Platform (1)

| Tool | Description |
|------|-------------|
| `get_roblox_status` | Check current status of Roblox services (website, Studio, API, game servers, etc.) |

## Install

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install
npm run build
```

## Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

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

## Claude Code

Run in your terminal:

```bash
claude mcp add roblox-devforum -- npx -y github:EL4CTEO/roblox-devforum-mcp
```
