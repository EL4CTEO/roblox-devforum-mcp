import { describe, expect, it } from "vitest";
import {
  extractNextData,
  findLuauSection,
  parseDuckDuckGoSiteResults,
  parseStatusPage,
} from "../../src/lib/htmlParse.js";

describe("parseStatusPage", () => {
  it("extracts top-level component name and status (regex fallback when classes absent)", () => {
    const html = `<div><p class="container_name">Game Servers</p><p class="pull-right">Operational</p></div>`;
    const page = parseStatusPage(html);
    const matched = page.components.find((c) => c.name === "Game Servers");
    expect(matched?.status).toBe("Operational");
  });

  it("returns empty arrays on garbage input", () => {
    const page = parseStatusPage("<html></html>");
    expect(page.components).toEqual([]);
  });
});

describe("findLuauSection", () => {
  it("returns not-found for missing module", () => {
    const r = findLuauSection("<html>nothing here</html>", "math");
    expect(r.found).toBe(false);
    expect(r.available).toContain("math");
  });

  it("captures section between two libraries", () => {
    const html = "prefix function math.abs(x) ... function string.len(s) ... suffix";
    const r = findLuauSection(html, "math");
    expect(r.found).toBe(true);
    expect(r.text).toContain("math.abs");
    expect(r.text).not.toContain("string.len");
  });
});

describe("parseDuckDuckGoSiteResults", () => {
  it("extracts result anchors", () => {
    const html =
      `<a class="result__a" href="//create.roblox.com/docs/foo">Foo Doc</a>` +
      `<a class="result__a" href="https://create.roblox.com/docs/bar">Bar Doc</a>`;
    const r = parseDuckDuckGoSiteResults(html);
    expect(r).toHaveLength(2);
    expect(r[0]?.url).toBe("https://create.roblox.com/docs/foo");
    expect(r[1]?.title).toBe("Bar Doc");
  });
});

describe("extractNextData", () => {
  it("parses inline JSON", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">{"a":1}</script>`;
    expect(extractNextData(html)).toEqual({ a: 1 });
  });

  it("returns null on missing tag", () => {
    expect(extractNextData("<html></html>")).toBeNull();
  });
});
