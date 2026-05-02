import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { renderReleaseNoteMarkdown } from "../lib/releaseNotes.js";
export declare function register(server: McpServer, ctx: AppContext): void;
export { renderReleaseNoteMarkdown };
