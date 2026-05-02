import { describe, expect, it } from "vitest";
import {
  extractReleaseNoteFromHtml,
  extractReleaseNoteIndex,
  parseReleaseNoteSections,
  renderReleaseNoteMarkdown,
} from "../../src/lib/releaseNotes.js";

describe("parseReleaseNoteSections", () => {
  it("groups bullets under their H2 heading", () => {
    const text = [
      "## New Features",
      "- Added FooService",
      "- Added BarService",
      "## Improvements",
      "- Faster startup",
      "## Fixes",
      "- Fixed crash on Workspace",
      "## Removed / Deprecated",
      "- BodyVelocity removed",
    ].join("\n");
    const out = parseReleaseNoteSections(text);
    expect(out.new_features).toEqual(["Added FooService", "Added BarService"]);
    expect(out.improvements).toEqual(["Faster startup"]);
    expect(out.fixes).toEqual(["Fixed crash on Workspace"]);
    expect(out.removed).toEqual(["BodyVelocity removed"]);
  });

  it("ignores unknown headings and keeps current section", () => {
    const text = ["Improvements", "- One", "Some Random Heading", "- Two"].join("\n");
    const out = parseReleaseNoteSections(text);
    expect(out.improvements).toEqual(["One", "Two"]);
  });

  it("accepts numbered list items as bullets", () => {
    const text = ["Fixes", "1. First fix", "2. Second fix"].join("\n");
    const out = parseReleaseNoteSections(text);
    expect(out.fixes).toEqual(["First fix", "Second fix"]);
  });
});

describe("extractReleaseNoteIndex", () => {
  it("pulls and sorts release-notes slugs descending", () => {
    const html = `
      <a href="/docs/release-notes/release-notes-672">Release 672</a>
      <a href="/docs/release-notes/release-notes-674">Release 674</a>
      <a href="/docs/release-notes/release-notes-673">Release 673</a>
    `;
    const entries = extractReleaseNoteIndex(html);
    expect(entries.map((e) => e.version)).toEqual(["674", "673", "672"]);
    expect(entries[0]?.url).toContain("release-notes-674");
  });

  it("dedupes the same version", () => {
    const html = "release-notes-700 release-notes-700 release-notes-699";
    const entries = extractReleaseNoteIndex(html);
    expect(entries.length).toBe(2);
  });
});

describe("extractReleaseNoteFromHtml", () => {
  it("extracts sections from a Next.js __NEXT_DATA__ payload", () => {
    const doc = {
      title: "Release 674",
      description: "Weekly update.",
      body: [
        { text: "## New Features\n- Added FooService\n- Added BarService" },
        { text: "## Fixes\n- Fixed Workspace crash" },
      ],
      metadata: { date: "2026-04-15" },
    };
    const next = { props: { pageProps: { doc } } };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
    const item = extractReleaseNoteFromHtml(
      html,
      "674",
      "https://create.roblox.com/docs/release-notes/release-notes-674"
    );
    expect(item).not.toBeNull();
    expect(item?.version).toBe("674");
    expect(item?.title).toBe("Release 674");
    expect(item?.sections?.new_features).toContain("Added FooService");
    expect(item?.sections?.fixes).toContain("Fixed Workspace crash");
    expect(item?.date.startsWith("2026-04-15")).toBe(true);
  });

  it("falls back to stripped HTML when __NEXT_DATA__ is missing", () => {
    const html = "<html><body><h1>Release 700</h1><p>No data here.</p></body></html>";
    const item = extractReleaseNoteFromHtml(
      html,
      "700",
      "https://create.roblox.com/docs/release-notes/release-notes-700"
    );
    expect(item).not.toBeNull();
    expect(item?.version).toBe("700");
  });
});

describe("renderReleaseNoteMarkdown", () => {
  it("renders title, date, summary and sections", () => {
    const md = renderReleaseNoteMarkdown({
      type: "release_note",
      title: "Release 674",
      url: "https://example.test/r/674",
      date: "2026-04-15T00:00:00Z",
      summary: "Weekly update.",
      version: "674",
      sections: {
        new_features: ["Added FooService"],
        fixes: ["Fixed crash"],
      },
    });
    expect(md).toContain("# Release 674");
    expect(md).toContain("Published 2026-04-15");
    expect(md).toContain("## New Features");
    expect(md).toContain("- Added FooService");
    expect(md).toContain("## Fixes");
    expect(md).toContain("Source: https://example.test/r/674");
  });

  it("skips empty sections", () => {
    const md = renderReleaseNoteMarkdown({
      type: "release_note",
      title: "Release 700",
      url: "https://example.test/r/700",
      date: "",
      summary: "",
      version: "700",
    });
    expect(md).not.toContain("## New Features");
    expect(md).not.toContain("## Fixes");
  });
});
