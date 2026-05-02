import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, VERSION } from "./config.js";
import { createContext } from "./context.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllTools } from "./tools/index.js";
export const SERVER_CAPABILITIES = {
    logging: {},
    completions: {},
    resources: { listChanged: false, subscribe: false },
    prompts: { listChanged: false },
    tools: { listChanged: false },
};
export const SERVER_INSTRUCTIONS = [
    "Roblox knowledge MCP. Use it for research-style queries while you're coding inside Roblox Studio.",
    "",
    "Tools (8):",
    "- forum_search: unified DevForum search (status:solved, category, tag, top/latest/new). Use status='solved' for debugging.",
    "- forum_thread: read a thread + accepted answer + replies (paginated).",
    "- forum_taxonomy: list categories, list tags, or fetch one category's metadata.",
    "- roblox_api: classes, members, hierarchy, enums from the live Full-API-Dump.",
    "- roblox_docs: Creator Hub pages, Luau stdlib, and community DevForum tutorials.",
    "- platform_status: current Roblox platform/component status and incidents.",
    "- creator_store: search the Roblox catalog (models, plugins, audio).",
    "- roblox_news: Creator Hub Release Notes + staff DevForum Announcements (filter by date/source/query). Call this before generating code to learn what just shipped or got deprecated.",
    "",
    "Resources expose stable URIs you can cite or read directly:",
    "- roblox-api://class/{className}, roblox-api://enum/{enumName}",
    "- roblox-luau://stdlib/{module}",
    "- roblox-devforum://thread/{topicId}, roblox-devforum://category/{slug}",
    "- roblox-docs://creator/{path}",
    "- roblox-news://release/{version}",
    "",
    "Prompts: research-feature, explain-error, find-implementation-pattern, audit-deprecated-api.",
].join("\n");
/**
 * Register all tools, resources, and prompts on an existing McpServer instance.
 * Used by both the Node stdio entry and the Cloudflare Worker (McpAgent) entry.
 */
export function registerAll(server, ctx) {
    ctx.logger.setServer(server);
    registerAllTools(server, ctx);
    registerAllResources(server, ctx);
    registerAllPrompts(server);
}
export function createServer(config) {
    const ctx = createContext(config);
    const server = new McpServer({ name: SERVER_NAME, version: VERSION }, {
        capabilities: SERVER_CAPABILITIES,
        instructions: SERVER_INSTRUCTIONS,
    });
    registerAll(server, ctx);
    return { server, ctx };
}
//# sourceMappingURL=server.js.map