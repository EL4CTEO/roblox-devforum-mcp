#!/usr/bin/env node
/**
 * roblox-devforum-mcp — MCP server exposing the Roblox DevForum and the official
 * creator documentation so an AI agent can debug Roblox games against real answers.
 */

import { realpathSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { warmCategories } from "./categories.js";
import { registerForumTools } from "./tools/forum.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerUpdateTools } from "./tools/updates.js";

const VERSION = "1.1.2";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "roblox-devforum", version: VERSION },
    {
      instructions:
        "Roblox debugging knowledge base. When the user hits a Roblox Studio or runtime problem: " +
        "1) call search_bugs with the literal error text to see if Roblox already has a triaged bug report; " +
        "2) call search_devforum for community threads and workarounds, then get_thread on the most promising topic_id; " +
        "3) call get_engine_api or search_creator_docs to confirm the intended API behaviour before recommending code. " +
        "When something worked before and broke for no clear reason, call get_whats_new first — a Roblox release may explain it. " +
        "Cite the thread URLs you relied on, and note the thread date — Roblox behaviour changes often.",
    },
  );

  registerForumTools(server);
  registerDocsTools(server);
  registerUpdateTools(server);
  // Pull the live category tree in the background, so the first result already names
  // categories correctly. Startup never waits on it, and never fails if it fails.
  warmCategories();
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Only start the transport when this file is the process entrypoint, so tests can import it. */
function isEntrypoint(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `roblox-devforum-mcp failed to start: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });
}
