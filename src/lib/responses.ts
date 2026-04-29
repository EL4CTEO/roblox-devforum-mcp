import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text }],
  };
  if (structured) result.structuredContent = structured;
  return result;
}

export function fail(error: unknown): CallToolResult {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}
