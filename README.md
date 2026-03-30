# roblox-devforum-mcp

MCP server that connects to the [Roblox Developer Forum](https://devforum.roblox.com) (Discourse-based) and the [Roblox Creator Documentation](https://create.roblox.com/docs). Provides 18 tools for searching, browsing, and reading DevForum posts, bug reports, engine updates, and official API docs.

No authentication required — all endpoints are public.

## Tools

| Tool | Description |
|------|-------------|
| `get_announcements` | Latest DevForum announcements |
| `get_latest_posts` | Latest posts, optionally filtered by category |
| `search_devforum` | Search topics by query |
| `get_thread` | Read a specific thread (page 1 only) |
| `get_action_required` | Topics tagged action-required |
| `get_engine_updates` | Roblox engine & Studio updates |
| `get_category` | Topics from a specific category |
| `get_top_posts` | Top posts by time period |
| `get_post_replies` | Thread replies (single page) |
| `get_user_posts` | Recent activity for a user |
| `get_api_docs` | Roblox engine class documentation |
| `search_creator_docs` | Search official Creator docs |
| `get_categories` | List all DevForum categories |
| `get_tags` | List all DevForum tags |
| `get_category_metadata` | Category metadata (not topics) |
| `search_bugs` | Search bug reports (studio-bugs / engine-bugs) |
| `get_solved_topics` | Search solved topics (preferred for debugging) |
| `get_new_posts` | Newest topics on the DevForum |

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
