import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { SERVER_NAME, VERSION, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { SERVER_CAPABILITIES, SERVER_INSTRUCTIONS, registerAll } from "./server.js";
export class RobloxDevforumMcp extends McpAgent {
    server = new McpServer({ name: SERVER_NAME, version: VERSION }, {
        capabilities: SERVER_CAPABILITIES,
        instructions: SERVER_INSTRUCTIONS,
    });
    async init() {
        const config = loadConfig(this.env);
        const ctx = createContext(config);
        registerAll(this.server, ctx);
    }
}
const handler = RobloxDevforumMcp.serve("/mcp", { binding: "MCP_OBJECT" });
function unauthorized() {
    return new Response(JSON.stringify({
        error: "unauthorized",
        message: "Provide Authorization: Bearer <AUTH_TOKEN>.",
    }), {
        status: 401,
        headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer realm="roblox-devforum-mcp"',
        },
    });
}
function isAuthorized(request, expected) {
    if (!expected)
        return false;
    const header = request.headers.get("authorization") ?? "";
    if (!header.toLowerCase().startsWith("bearer "))
        return false;
    const presented = header.slice(7).trim();
    if (presented.length !== expected.length)
        return false;
    // Constant-time-ish compare to avoid trivial timing leaks.
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
    }
    return diff === 0;
}
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/healthz") {
            return new Response(JSON.stringify({
                ok: true,
                server: SERVER_NAME,
                version: VERSION,
                mcpEndpoint: "/mcp",
            }), { headers: { "content-type": "application/json" } });
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
//# sourceMappingURL=worker.js.map