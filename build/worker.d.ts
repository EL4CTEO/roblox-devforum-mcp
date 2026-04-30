import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
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
export declare class RobloxDevforumMcp extends McpAgent<Env> {
    server: McpServer;
    init(): Promise<void>;
}
declare const _default: {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};
export default _default;
