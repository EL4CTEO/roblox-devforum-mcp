import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Config } from "./config.js";
import { type AppContext } from "./context.js";
export interface ServerHandle {
    server: McpServer;
    ctx: AppContext;
}
export declare const SERVER_CAPABILITIES: {
    readonly logging: {};
    readonly completions: {};
    readonly resources: {
        readonly listChanged: false;
        readonly subscribe: false;
    };
    readonly prompts: {
        readonly listChanged: false;
    };
    readonly tools: {
        readonly listChanged: false;
    };
};
export declare const SERVER_INSTRUCTIONS: string;
/**
 * Register all tools, resources, and prompts on an existing McpServer instance.
 * Used by both the Node stdio entry and the Cloudflare Worker (McpAgent) entry.
 */
export declare function registerAll(server: McpServer, ctx: AppContext): void;
export declare function createServer(config: Config): ServerHandle;
