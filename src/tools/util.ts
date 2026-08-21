/** Small helpers shared by the tool implementations. */

import { HttpError } from "../http.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turn any thrown value into a readable, non-fatal tool error. */
export function toToolError(context: string, err: unknown): ToolResult {
  if (err instanceof HttpError) {
    if (err.status === 404) return fail(`${context}: not found (404). Check the id or path.`);
    if (err.status === 403 || err.status === 429) {
      return fail(`${context}: rate limited by the upstream service (${err.status}). Retry shortly.`);
    }
    return fail(`${context}: upstream returned HTTP ${err.status}.`);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return fail(`${context}: ${reason}`);
}

/** Accept a raw topic id, a full DevForum URL, or a "slug/id" fragment. */
export function parseTopicId(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isInteger(input) ? input : undefined;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /\/t\/(?:[^/]+\/)?(\d+)/.exec(trimmed);
  return match?.[1] ? Number(match[1]) : undefined;
}
