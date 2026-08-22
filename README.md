# roblox-devforum-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI coding agent access to the
**Roblox Developer Forum** and the **official Roblox creator documentation**.

When your agent hits a Roblox bug — a DataStore returning `502`, a `ProximityPrompt` that never
fires on mobile, a `Humanoid` property that silently stopped working — it can search what other
developers actually ran into, read the accepted answer, check whether Roblox has already triaged
it as an engine bug, and confirm the intended API behaviour before writing a fix.

- Zero configuration, no API key, no login.
- The API dump and docs index are cached to disk, so only the first run pays for them.
- Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`) and a fast cold start.
- Every response is Markdown, budgeted to a token limit, with source URLs.

## Install

```bash
npx -y roblox-devforum-mcp
```

### Claude Code

```bash
claude mcp add roblox-devforum -- npx -y roblox-devforum-mcp
```

### Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "npx",
      "args": ["-y", "roblox-devforum-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/EL4CTEO/roblox-devforum-mcp.git
cd roblox-devforum-mcp
npm install && npm run build
node dist/index.js
```

## Tools

| Tool | What it does |
| --- | --- |
| `search_devforum` | Full-text DevForum search with category, tag, solved-only, minimum-likes and date filters. Pass an array of phrasings to run up to 5 searches in parallel and merge them. Results are re-ranked so solved and recent threads beat stale unanswered ones. |
| `search_bugs` | Searches only the bug-report categories and surfaces the staff status tag (`confirmed`, `fixed`, `cannot-reproduce`) — answers "is this a known Roblox bug or is it my code?". Accepts parallel phrasings too. |
| `get_thread` | Reads a topic as Markdown with the accepted answer hoisted to the top, staff replies next, and code blocks preserved. Accepts a topic id or a DevForum URL. |
| `get_replies` | Pages through the rest of a long thread. |
| `list_recent` | Latest or top topics in a category or tag — e.g. `release-notes` to check whether a Roblox update caused a regression. |
| `list_categories` | The category tree and most-used tags, so the model can pick valid filter slugs. |
| `search_creator_docs` | Searches create.roblox.com documentation by page content (not just titles) and returns snippets; pass `path` to read a full page. |
| `get_engine_api` | Signatures, security levels, deprecations and thread safety straight from the live Roblox API dump. |
| `check_api_health` | Batch-check APIs before shipping Luau: still exists? deprecated (with the official replacement)? security-gated? yields? Catches retired APIs that models still emit. |
| `get_whats_new` | Digest of recent platform changes: the latest Weekly Recap, Release Notes and Announcements in one call — for "this worked last week". |
| `get_weekly_recap` | Any Roblox Weekly Recap, current or historical. Step back by `week`, jump to a date with `before`, or `list` the archive (back to mid-2025). |

All tools are read-only and make no authenticated calls.

## Example prompts

- *"My DataStore:SetAsync keeps failing with `502: API Services rejected request`. Is this on Roblox's end?"*
- *"ProximityPrompt.Triggered never fires for mobile players — what do other developers do about it?"*
- *"Did anything in the last few Roblox release notes change how `Humanoid.MoveTo` behaves?"*
- *"What shipped on Roblox in the last two weeks?"* / *"When did Server Authority get its full release?"*
- *"What are the actual DataStore request limits, and how should I batch writes?"*
- *"Is `Humanoid:LoadAnimation` still fine to use, or has it been replaced?"*

A typical agent loop: `search_bugs` with the literal error text → `search_devforum` for
workarounds → `get_thread` on the best hit → `get_engine_api` to confirm the API before editing
code.

### Parallel search

An error rarely has one phrasing. Pass several and they run at once, merged and de-duplicated,
with threads found by more than one phrasing promoted to the top:

```json
{ "query": ["DataStore 502 API Services rejected request",
            "datastore internal server error",
            "SetAsync failing 502"] }
```

```
1. [solved] DataStore 502 API Rejected for specific key
   #cloud-services-bugs · 4 replies · 1 yr ago · matched 3 phrasings
```

## Configuration

Everything is optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVFORUM_BASE_URL` | `https://devforum.roblox.com` | Point at a different Discourse instance. |
| `DEVFORUM_CACHE_TTL` | `300` | Search cache lifetime in seconds (threads 15 min, categories and docs 24 h). |
| `DEVFORUM_TIMEOUT_MS` | `12000` | Per-request timeout. |
| `DEVFORUM_MAX_RETRIES` | `3` | Retries on 429/5xx, with jittered backoff. |
| `DEVFORUM_CONCURRENCY` | `4` | Maximum simultaneous requests to the DevForum. |
| `DEVFORUM_CDN_CONCURRENCY` | `8` | Maximum simultaneous requests to GitHub-hosted docs (a static CDN, so a higher ceiling is safe). |
| `DEVFORUM_DOCS_SCAN` | `14` | Documentation pages downloaded and content-scored per search. |
| `GITHUB_TOKEN` | — | Optional; raises the GitHub rate limit used to list the docs file tree. |
| `DEVFORUM_CACHE_DIR` | OS temp dir | Where the API dump and docs index are cached between sessions. |

## Data sources

- [Roblox Developer Forum](https://devforum.roblox.com) via its public Discourse JSON API.
- [Roblox/creator-docs](https://github.com/Roblox/creator-docs) — the source of create.roblox.com/docs.
- [Roblox-Client-Tracker](https://github.com/MaximumADHD/Roblox-Client-Tracker) `API-Dump.json` for engine signatures.

This project is not affiliated with or endorsed by Roblox Corporation.

## Development

```bash
npm install
npm run build
npm test          # builds, then runs the offline unit and server tests
npm run inspect   # opens the MCP Inspector against the built server
```

## License

MIT
