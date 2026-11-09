# Changelog

## 1.4.0

- Rewritten in Rust: one native binary, no Node.js runtime needed.
- Starts in ~12 ms (was ~350 ms) and idles at ~6 MB RAM (was ~60 MB).
- Faster tool calls: parsed responses are cached, and the API dump and docs index are built once.
- Fixed: functions that return several values showed `-> ()`; they now show e.g. `-> (CFrame, Vector3)`.
- Cancelled requests now stop right away instead of running to the end.
- Same 11 tools, arguments and output as 1.3.4. `npx -y roblox-devforum-mcp` still works; prebuilt binaries for Windows, macOS and Linux are also on the GitHub release.
