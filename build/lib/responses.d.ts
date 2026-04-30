import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export declare function ok(text: string, structured?: Record<string, unknown>): CallToolResult;
export declare function fail(error: unknown): CallToolResult;
