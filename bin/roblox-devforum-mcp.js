#!/usr/bin/env node
// Launches the native roblox-devforum-mcp binary for this platform.
//
// The server is written in Rust; npm installs the matching prebuilt binary through one of the
// optional roblox-devforum-mcp-<os>-<arch> packages, and this shim only starts it with stdio
// passed straight through. ROBLOX_DEVFORUM_MCP_BINARY points it at a binary of your own.

"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const exe = process.platform === "win32" ? "roblox-devforum-mcp.exe" : "roblox-devforum-mcp";

function binaryPath() {
  if (process.env.ROBLOX_DEVFORUM_MCP_BINARY) return process.env.ROBLOX_DEVFORUM_MCP_BINARY;
  const pkg = `roblox-devforum-mcp-${process.platform}-${process.arch}`;
  try {
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", exe);
  } catch {
    process.stderr.write(
      `roblox-devforum-mcp: no prebuilt binary for ${process.platform}-${process.arch} (package ${pkg} is missing).\n` +
        "Reinstall without --no-optional / --omit=optional, or build it with: cargo install --git https://github.com/EL4CTEO/roblox-devforum-mcp\n" +
        "and set ROBLOX_DEVFORUM_MCP_BINARY to the installed binary.\n",
    );
    process.exit(1);
  }
}

const child = spawn(binaryPath(), process.argv.slice(2), { stdio: "inherit", windowsHide: true });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (err) => {
  process.stderr.write(`roblox-devforum-mcp failed to start: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
