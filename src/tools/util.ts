/** Small helpers shared by the tool implementations. */

import { BASE_URL, HttpError, TimeoutError } from "../http.js";

function isForum(url: string): boolean {
  try {
    return new URL(url).host === new URL(BASE_URL).host;
  } catch {
    return false;
  }
}

/** Every tool only reads public pages; none changes anything anywhere. */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

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

/**
 * A YYYY-MM-DD string that names a day on the calendar. The schema regex lets "2026-13-45"
 * through, and Date.parse rolls "2026-02-31" over to 3 March instead of rejecting it, so the
 * date is checked by printing it back.
 */
export function isRealDate(date: string): boolean {
  const at = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === date;
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
    // GitHub answers a spent rate limit with 403, but the forum answers 403 for a topic in a
    // category anonymous readers cannot see. Calling that "rate limited, retry shortly" sent
    // the caller back for the same refusal.
    if (err.status === 403 && isForum(err.url)) {
      return fail(`${context}: the DevForum refused access (403) — it is private or restricted to signed-in members. Pick another thread.`);
    }
    if (err.status === 403 || err.status === 429) {
      return fail(`${context}: rate limited by the upstream service (${err.status}). Retry shortly.`);
    }
    return fail(`${context}: upstream returned HTTP ${err.status}.`);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return fail(`${context}: ${reason}`);
}

/**
 * The topic id and post number a topic reference names: a raw id, a DevForum URL
 * ("/t/slug/123", "/t/slug/123/45", the short "/t/123/45"), or a "slug/123" fragment.
 *
 * A single pattern with an optional slug read the short "/t/123/45" as slug "123", topic 45,
 * and opened the wrong thread. The segments are read in order instead: the slug, when there
 * is one, is the segment that is not a number.
 */
function parseTopicRef(input: string | number | undefined): { id?: number; post?: number } {
  if (input === undefined) return {};
  // Topic ids start at 1; 0 or -5 used to be sent to the forum and came back a bare 404.
  if (typeof input === "number") return Number.isInteger(input) && input > 0 ? { id: input } : {};
  const trimmed = input.trim().replace(/[?#].*$/, "");
  const at = trimmed.indexOf("/t/");
  const path = at >= 0 ? trimmed.slice(at + 3) : trimmed;
  const segments = path.split("/").filter(Boolean);
  const numeric = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);
  const start = numeric(segments[0]) !== undefined ? 0 : 1;
  const id = numeric(segments[start]);
  if (id === undefined || id === 0) return {};
  const post = numeric(segments[start + 1]);
  return post === undefined ? { id } : { id, post };
}

/** Accept a raw topic id, a full DevForum URL, or a "slug/id" fragment. */
export function parseTopicId(input: string | number | undefined): number | undefined {
  return parseTopicRef(input).id;
}

/** The post a DevForum URL points at — "/t/slug/123/45" is post #45 — if it names one. */
export function parsePostNumber(input: string | number | undefined): number | undefined {
  return parseTopicRef(input).post;
}
