#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, ctx } = createServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  ctx.logger.info("roblox-devforum-mcp ready", {
    transport: "stdio",
    cacheTtlMs: config.RDFM_CACHE_TTL_MS,
    apiDumpTtlMs: config.RDFM_API_DUMP_TTL_MS,
  });

  const shutdown = async (signal: string) => {
    ctx.logger.info(`shutting down (${signal})`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
