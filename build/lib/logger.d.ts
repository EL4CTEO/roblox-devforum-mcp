import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";
export interface Logger {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    notice(msg: string, data?: Record<string, unknown>): void;
    warning(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    setLevel(level: LogLevel): void;
    setServer(server: McpServer): void;
}
export declare function createLogger(level?: LogLevel): Logger;
