import type { NewsItem, ReleaseNoteIndexEntry, ReleaseNoteSection } from "../types.js";
export declare function parseReleaseNoteSections(text: string): ReleaseNoteSection;
export declare function extractReleaseNoteIndex(html: string): ReleaseNoteIndexEntry[];
export declare function extractReleaseNoteFromHtml(html: string, version: string, url: string): NewsItem | null;
export declare function renderReleaseNoteMarkdown(item: NewsItem): string;
