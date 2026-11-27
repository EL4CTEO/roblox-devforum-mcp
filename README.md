<p align="center"><img src="https://raw.githubusercontent.com/EL4CTEO/roblox-devforum-mcp/main/assets/devforum.png" alt="Roblox Developer Forum" width="440"></p>

<h1 align="center">roblox-devforum-mcp</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@el4cteo/roblox-devforum-mcp"><img src="https://img.shields.io/npm/v/@el4cteo/roblox-devforum-mcp?color=2563eb&label=npm" alt="npm"></a>
  <a href="https://crates.io/crates/roblox-devforum-mcp"><img src="https://img.shields.io/crates/v/roblox-devforum-mcp?color=2563eb" alt="crates.io"></a>
  <a href="https://github.com/EL4CTEO/roblox-devforum-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="MIT"></a>
</p>

An [MCP](https://modelcontextprotocol.io) server that gives your AI coding agent the **Roblox DevForum** and the **official creator docs**: check if a bug is already known, read the accepted answer, verify APIs before writing Luau.

No API key, no login. One native Rust binary: starts in ~12 ms, ~6 MB RAM.

## Install

```bash
claude mcp add roblox-devforum -- npx -y @el4cteo/roblox-devforum-mcp
```

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

```bash
dsh plugin --profile web add @el4cteo/roblox-devforum-mcp
```

Any other MCP client:

```json
{
  "mcpServers": {
    "roblox-devforum": {
      "command": "npx",
      "args": ["-y", "@el4cteo/roblox-devforum-mcp"]
    }
  }
}
```

No Node.js? Grab the binary from the [latest release](https://github.com/EL4CTEO/roblox-devforum-mcp/releases/latest) or `cargo install roblox-devforum-mcp`, then:

```bash
claude mcp add roblox-devforum -- /path/to/roblox-devforum-mcp
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
| `search_creator_docs` | Search the docs by page content; pass `path` (or a docs URL) to read a page in full. |
| `get_engine_api` | Signatures, security levels and deprecations for classes, enums, datatypes and Luau libraries. |
| `check_api_health` | Check APIs before you ship: removed, deprecated, wrong case, security-gated, yielding. |
| `get_whats_new` | Recent platform changes — for "this worked last week". |
| `get_weekly_recap` | Any Roblox Weekly Recap, current or historical. |

Every tool is read-only, returns Markdown with source URLs, and stays inside a token budget.

`[answered]` means the thread's author marked a solution (not Roblox staff).

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
| `ROBLOX_DEVFORUM_MCP_BINARY` | — | npm only: run this binary instead of the bundled one. |

Invalid values fall back to the default (with a note on stderr).

## Data sources

[devforum.roblox.com](https://devforum.roblox.com) (public Discourse API), [Roblox/creator-docs](https://github.com/Roblox/creator-docs), [Roblox-Client-Tracker](https://github.com/MaximumADHD/Roblox-Client-Tracker) API dump.

Not affiliated with or endorsed by Roblox Corporation.

## Development

Needs Rust 1.99+.

```bash
cargo build --release   # target/release/roblox-devforum-mcp
cargo test              # offline unit and tool tests
npm run inspect         # MCP Inspector against the release build
```

Push a `vX.Y.Z` tag to release: CI builds every binary, publishes to npm and the GitHub release.

## License

MIT
