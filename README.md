<img src="https://raw.githubusercontent.com/EL4CTEO/roblox-devforum-mcp/main/assets/devforum.png" alt="Roblox Developer Forum" width="440">

# roblox-devforum-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI coding agent the **Roblox
Developer Forum** and the **official creator docs**.

When your agent hits a Roblox bug, it can check whether Roblox already has it triaged, read the
accepted answer, and confirm the API before writing Luau.

No API key, no login, no setup.

## Install

```bash
claude mcp add roblox-devforum -- npx -y roblox-devforum-mcp
```

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

```bash
dsh plugin --profile web add roblox-devforum-mcp
```

Any other MCP client:

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

## Tools

| Tool | What it does |
| --- | --- |
| `search_devforum` | Search the forum. Filters for category, tag, solved-only, likes and date. Pass several phrasings to run them at once. |
| `search_bugs` | Search only the bug-report categories, so a hit means somebody reported the same symptom. |
| `get_thread` | Read a topic as Markdown, accepted answer first, code blocks intact. |
| `get_replies` | Page through a long thread. |
| `list_recent` | Latest or top topics in a category or tag. |
| `list_categories` | Every category and tag slug the filters accept. |
| `search_creator_docs` | Search the docs by page content; pass `path` to read a page in full. |
| `get_engine_api` | Signatures, security levels and deprecations from the live API dump. |
| `check_api_health` | Check APIs before you ship: removed, deprecated, security-gated, yielding. |
| `get_whats_new` | Recent platform changes — for "this worked last week". |
| `get_weekly_recap` | Any Roblox Weekly Recap, current or historical. |

Every tool is read-only, returns Markdown with source URLs, and stays inside a token budget.

`[answered]` beside a result means a reply was marked as the solution — by whoever opened the
thread, not by Roblox. Roblox does not publish a triage state, so read the thread to see
whether staff replied.

## Example

> *"My DataStore:SetAsync keeps failing with `502: API Services rejected request`. Is this on
> Roblox's end?"*

The agent runs `search_bugs` on the error text, `get_thread` on the best hit, then
`check_api_health` before touching your code.

## Configuration

All optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVFORUM_CACHE_TTL` | `300` | Search cache lifetime, in seconds. |
| `DEVFORUM_TIMEOUT_MS` | `12000` | Per-request timeout. |
| `DEVFORUM_DEADLINE_MS` | `24000` | Total time one request may spend, retries included. |
| `DEVFORUM_MAX_RETRIES` | `3` | Retries on 429 and 5xx. |
| `DEVFORUM_CONCURRENCY` | `4` | Simultaneous requests to the DevForum. |
| `DEVFORUM_CDN_CONCURRENCY` | `8` | Simultaneous requests to GitHub-hosted docs. |
| `DEVFORUM_DOCS_SCAN` | `14` | Doc pages scored per search. |
| `DEVFORUM_CACHE_DIR` | OS temp dir | Where the API dump and docs index are cached. |
| `DEVFORUM_BASE_URL` | `https://devforum.roblox.com` | Point at another Discourse instance. |

A bad value is ignored, with a note on stderr, and the default is used.

## Data sources

[devforum.roblox.com](https://devforum.roblox.com) (public Discourse API),
[Roblox/creator-docs](https://github.com/Roblox/creator-docs), and the
[Roblox-Client-Tracker](https://github.com/MaximumADHD/Roblox-Client-Tracker) API dump.

Not affiliated with or endorsed by Roblox Corporation.

## Development

```bash
npm install && npm run build
npm test          # offline unit and server tests
npm run inspect   # MCP Inspector against the built server
```

## License

MIT
