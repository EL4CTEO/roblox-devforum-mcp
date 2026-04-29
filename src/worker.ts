import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { SERVER_NAME, VERSION, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { SERVER_CAPABILITIES, SERVER_INSTRUCTIONS, registerAll } from "./server.js";

export interface Env {
  /** Bearer token clients must present in the Authorization header. */
  AUTH_TOKEN?: string;
  /** Optional overrides — same names as Node env vars. */
  RDFM_LOG_LEVEL?: string;
  RDFM_FETCH_TIMEOUT_MS?: string;
  RDFM_CACHE_TTL_MS?: string;
  RDFM_CACHE_MAX?: string;
  RDFM_API_DUMP_TTL_MS?: string;
  RDFM_MAX_RETRIES?: string;
  RDFM_BASE_BACKOFF_MS?: string;
  RDFM_USER_AGENT?: string;
  RDFM_CIRCUIT_THRESHOLD?: string;
  RDFM_CIRCUIT_WINDOW_MS?: string;
  RDFM_CIRCUIT_COOLDOWN_MS?: string;
  /** Bound automatically by Wrangler. */
  MCP_OBJECT: DurableObjectNamespace;
}

export class RobloxDevforumMcp extends McpAgent<Env> {
  override server: McpServer = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: SERVER_CAPABILITIES,
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  override async init(): Promise<void> {
    const config = loadConfig(this.env as unknown as Record<string, unknown>);
    const ctx = createContext(config);
    registerAll(this.server, ctx);
  }
}

const handler = RobloxDevforumMcp.serve("/mcp", { binding: "MCP_OBJECT" });

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "Provide Authorization: Bearer <AUTH_TOKEN>.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="roblox-devforum-mcp"',
      },
    }
  );
}

function isAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const presented = header.slice(7).trim();
  if (presented.length !== expected.length) return false;
  // Constant-time-ish compare to avoid trivial timing leaks.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({
          ok: true,
          server: SERVER_NAME,
          version: VERSION,
          mcpEndpoint: "/mcp",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not found", { status: 404 });
    }

    if (!isAuthorized(request, env.AUTH_TOKEN)) {
      return unauthorized();
    }

    return handler.fetch(request, env, ctx);
  },
};
