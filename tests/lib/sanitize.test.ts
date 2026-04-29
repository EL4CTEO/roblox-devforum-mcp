import { describe, expect, it } from "vitest";
import { fmtTags, formatDate, stripHtml, truncate } from "../../src/lib/sanitize.js";

describe("stripHtml", () => {
  it("removes script and style", () => {
    expect(stripHtml("<style>x</style><p>hi</p><script>y</script>")).toBe("hi");
  });

  it("decodes basic entities", () => {
    expect(stripHtml("&amp;&lt;&gt;&quot;&#39;")).toBe("&<>\"'");
  });
});

describe("truncate", () => {
  it("returns input if short", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
  it("appends ellipsis if longer", () => {
    expect(truncate("abcdef", 5)).toBe("ab...");
  });
});

describe("formatDate", () => {
  it("returns YYYY-MM-DD for ISO", () => {
    expect(formatDate("2025-01-02T03:04:05Z")).toBe("2025-01-02");
  });
  it("returns 'unknown' for invalid", () => {
    expect(formatDate(undefined)).toBe("unknown");
    expect(formatDate("not a date")).toBe("unknown");
  });
});

describe("fmtTags", () => {
  it("formats string tags", () => {
    expect(fmtTags(["a", "b"])).toBe(" [a, b]");
  });
  it("formats object tags as key:value pairs", () => {
    expect(fmtTags([{ Read: "None", Write: "Plugin" }])).toBe(" [Read: None; Write: Plugin]");
  });
  it("returns empty for nullish/empty", () => {
    expect(fmtTags(undefined)).toBe("");
    expect(fmtTags([])).toBe("");
  });
});
