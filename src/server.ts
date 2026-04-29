import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Config, SERVER_NAME, VERSION } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllTools } from "./tools/index.js";

export interface ServerHandle {
  server: McpServer;
  ctx: AppContext;
}

export function createServer(config: Config): ServerHandle {
  const ctx = createContext(config);
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: {
        logging: {},
        completions: {},
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
        tools: { listChanged: false },
      },
      instructions: [
        "Roblox knowledge MCP. Use it for research-style queries while you're coding inside Roblox Studio.",
        "",
        "Tools (7):",
        "- forum_search: unified DevForum search (status:solved, category, tag, top/latest/new). Use status='solved' for debugging.",
        "- forum_thread: read a thread + accepted answer + replies (paginated).",
        "- forum_taxonomy: list categories, list tags, or fetch one category's metadata.",
        "- roblox_api: classes, members, hierarchy, enums from the live Full-API-Dump.",
        "- roblox_docs: Creator Hub pages, Luau stdlib, and community DevForum tutorials.",
        "- platform_status: current Roblox platform/component status and incidents.",
        "- creator_store: search the Roblox catalog (models, plugins, audio).",
        "",
        "Resources expose stable URIs you can cite or read directly:",
        "- roblox-api://class/{className}, roblox-api://enum/{enumName}",
        "- roblox-luau://stdlib/{module}",
        "- roblox-devforum://thread/{topicId}, roblox-devforum://category/{slug}",
        "- roblox-docs://creator/{path}",
        "",
        "Prompts: research-feature, explain-error, find-implementation-pattern, audit-deprecated-api.",
      ].join("\n"),
    }
  );
  ctx.logger.setServer(server);

  registerAllTools(server, ctx);
  registerAllResources(server, ctx);
  registerAllPrompts(server);

  return { server, ctx };
}
