import type { SearchResult, StatusPage } from "../types.js";
declare const LUAU_LIBRARIES: readonly ["math", "table", "string", "coroutine", "bit32", "utf8", "os", "debug", "buffer", "vector"];
export type LuauLibrary = (typeof LUAU_LIBRARIES)[number];
export declare const LUAU_LIBRARY_NAMES: readonly ["math", "table", "string", "coroutine", "bit32", "utf8", "os", "debug", "buffer", "vector"];
export declare function parseStatusPage(html: string): StatusPage;
export declare function findLuauSection(html: string, library: string): {
    found: boolean;
    text: string;
    available: readonly string[];
};
export declare function parseDuckDuckGoSiteResults(html: string): SearchResult[];
export declare function extractJsxChildren(code: string): string;
export declare function extractJsxComponent(next: Record<string, unknown>): string | null;
export declare function extractNextData(html: string): unknown;
export declare function flattenDocBody(body: unknown): string;
export {};
