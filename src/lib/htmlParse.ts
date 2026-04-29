import * as cheerio from "cheerio";
import { URLS } from "../config.js";
import type { SearchResult, StatusComponent, StatusIncident, StatusPage } from "../types.js";

const LUAU_LIBRARIES = [
  "math",
  "table",
  "string",
  "coroutine",
  "bit32",
  "utf8",
  "os",
  "debug",
  "buffer",
  "vector",
] as const;

export type LuauLibrary = (typeof LUAU_LIBRARIES)[number];

export const LUAU_LIBRARY_NAMES = LUAU_LIBRARIES;

export function parseStatusPage(html: string): StatusPage {
  const $ = cheerio.load(html);
  const components: StatusComponent[] = [];
  const incidents: StatusIncident[] = [];

  $(".component-container").each((_, el) => {
    const $el = $(el);
    const topName = $el.find(".component_name").first().clone();
    topName.find("i").remove();
    const name = topName.text().trim();
    const status = $el.find(".component-status").first().text().trim();
    if (name && status) components.push({ name, status });

    $el.find(".child-components-container .component-inner-container").each((_i, sub) => {
      const $sub = $(sub);
      const subName = $sub.find(".container_name").first().text().trim();
      const subStatus = $sub.find(".pull-right").first().text().trim();
      if (subName && subStatus) {
        components.push({ name: subName, status: subStatus });
      }
    });
  });

  if (components.length === 0) {
    const subRe = /container_name[^>]*>([^<]+)<\/p>[\s\S]*?pull-right[^>]*>([^<]+)<\/p>/g;
    for (const m of html.matchAll(subRe)) {
      const name = (m[1] ?? "").trim();
      const status = (m[2] ?? "").trim();
      if (name && status) components.push({ name, status });
    }
  }

  $(".incidents-list .incident-title, .unresolved-incidents .incident-title").each((_, el) => {
    const $el = $(el);
    const name = $el.text().trim();
    const status = $el.next(".incident-status, .status").text().trim();
    if (name) incidents.push({ name, status });
  });

  return {
    page: { name: "Roblox", url: URLS.robloxStatus },
    components,
    incidents,
  };
}

export function findLuauSection(
  html: string,
  library: string
): { found: boolean; text: string; available: readonly string[] } {
  const anchor = `function ${library}.`;
  const start = html.indexOf(anchor);
  if (start === -1) {
    return { found: false, text: "", available: LUAU_LIBRARIES };
  }
  let end = html.length;
  for (const lib of LUAU_LIBRARIES) {
    if (lib === library) continue;
    const idx = html.indexOf(`function ${lib}.`, start + anchor.length);
    if (idx > start && idx < end) end = idx;
  }
  return {
    found: true,
    text: html.substring(start, end),
    available: LUAU_LIBRARIES,
  };
}

export function parseDuckDuckGoSiteResults(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("a.result__a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href") ?? "";
    const title = $a.text().trim();
    if (!href || !title) return;
    const url = href.startsWith("//") ? `https:${href}` : href;
    results.push({ title, url });
  });
  return results.slice(0, 10);
}

export function extractNextData(html: string): unknown {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/
  );
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function flattenDocBody(body: unknown): string {
  if (!Array.isArray(body)) return "";
  return body
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") return b.text;
        if (Array.isArray(b.children)) {
          return (b.children as unknown[])
            .map((c) =>
              typeof c === "string"
                ? c
                : c && typeof c === "object" && "text" in c
                  ? String((c as Record<string, unknown>).text ?? "")
                  : ""
            )
            .join("");
        }
        if (typeof b.code === "string") return `\n\`\`\`\n${b.code}\n\`\`\``;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}
