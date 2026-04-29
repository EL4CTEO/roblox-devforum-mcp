import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { register as registerCreatorStore } from "./creatorStore.js";
import { register as registerForumSearch } from "./forumSearch.js";
import { register as registerForumTaxonomy } from "./forumTaxonomy.js";
import { register as registerForumThread } from "./forumThread.js";
import { register as registerPlatformStatus } from "./platformStatus.js";
import { register as registerRobloxApi } from "./robloxApi.js";
import { register as registerRobloxDocs } from "./robloxDocs.js";

export function registerAllTools(server: McpServer, ctx: AppContext): void {
  registerForumSearch(server, ctx);
  registerForumThread(server, ctx);
  registerForumTaxonomy(server, ctx);
  registerRobloxApi(server, ctx);
  registerRobloxDocs(server, ctx);
  registerPlatformStatus(server, ctx);
  registerCreatorStore(server, ctx);
}
