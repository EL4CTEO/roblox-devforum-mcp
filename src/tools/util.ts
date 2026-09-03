/** Small helpers shared by the tool implementations. */

import { HttpError, TimeoutError } from "../http.js";

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
  // A timeout is the one failure the caller can act on, and the DevForum's search index is
  // where it happens: some filter combinations run past thirty seconds while each term on
  // its own answers in about one. Say which lever to pull instead of naming an abort.
  if (err instanceof TimeoutError) {
    return fail(
      `${context}: ${err.message}. The DevForum's search index is slow for some filter combinations — retry with fewer words, or drop one filter (tags, category, solved_only).`,
    );
  }
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
export function parseTopicId(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "number") return Number.isInteger(input) ? input : undefined;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /\/t\/(?:[^/]+\/)?(\d+)/.exec(trimmed);
  return match?.[1] ? Number(match[1]) : undefined;
}
