import test from "node:test";
import assert from "node:assert/strict";

import { htmlToMarkdown, truncate, relativeDate, decodeEntities } from "../dist/format.js";
import { buildSearchQuery, topicUrl, categoryName } from "../dist/discourse.js";
import { rank, bugStatus, likesOf } from "../dist/rank.js";
import { parseTopicId } from "../dist/tools/util.js";
import { docUrl, signature, securityOf, queryTerms, scorePath } from "../dist/docs.js";

test("htmlToMarkdown keeps fenced code and drops chrome", () => {
  const html =
    '<p>Broken since <b>today</b>.</p><pre><code class="lang-lua">local ok = pcall(function()\n\tprint(&quot;hi&quot;)\nend)</code></pre>' +
    '<aside class="quote"><blockquote>old reply</blockquote></aside><script>bad()</script>';
  const md = htmlToMarkdown(html);
  assert.match(md, /```lua/);
  assert.match(md, /print\("hi"\)/);
  assert.match(md, /\*\*today\*\*/);
  assert.match(md, /\[quoted earlier reply\]/);
  assert.doesNotMatch(md, /bad\(\)/);
  assert.doesNotMatch(md, /<[a-z]/i);
});

test("htmlToMarkdown renders links, lists and images", () => {
  const md = htmlToMarkdown(
    '<ul><li>one</li><li>two</li></ul><a href="https://x.dev/a">docs</a><img alt="screenshot" src="a.png">',
  );
  assert.match(md, /- one\n- two/);
  assert.match(md, /\[docs\]\(https:\/\/x\.dev\/a\)/);
  assert.match(md, /\[image: screenshot\]/);
});

test("decodeEntities handles named, decimal and hex references", () => {
  assert.equal(decodeEntities("a &amp; b &#65; &#x42; &hellip;"), "a & b A B …");
});

test("truncate respects the token budget and flags the cut", () => {
  const long = "sentence. ".repeat(500);
  const out = truncate(long, 50, "use get_replies");
  assert.ok(out.length < long.length);
  assert.match(out, /use get_replies/);
  assert.equal(truncate("short", 50), "short");
});

test("relativeDate summarises age", () => {
  const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  assert.equal(relativeDate(days(1)), "1 day ago");
  assert.equal(relativeDate(days(10)), "10 days ago");
  assert.match(relativeDate(days(90)), /mo ago/);
  assert.match(relativeDate(days(800)), /yr ago/);
  assert.equal(relativeDate(undefined), "unknown");

  // Calendar days, not 24-hour blocks: get_weekly_recap printed "published 2026-08-28
  // (today)" on the 29th because the post was 22 hours old.
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(23, 30, 0, 0);
  assert.equal(relativeDate(yesterday.toISOString()), "1 day ago");

  const earlierToday = new Date();
  earlierToday.setUTCHours(0, 1, 0, 0);
  assert.equal(relativeDate(earlierToday.toISOString()), "today");
});

test("buildSearchQuery emits Discourse advanced-search syntax", () => {
  const q = buildSearchQuery({
    query: "DataStore 502",
    category: "engine-bugs",
    tags: ["datastore"],
    solvedOnly: true,
    minLikes: 5,
    after: "2025-01-01",
    order: "latest",
  });
  assert.equal(
    q,
    "DataStore 502 #engine-bugs tags:datastore status:solved min_post_likes:5 after:2025-01-01 order:latest",
  );
  assert.equal(buildSearchQuery({ query: "raycast", order: "relevance" }), "raycast");
});

test("topicUrl and categoryName map ids back to readable values", () => {
  assert.equal(topicUrl(123, "my-slug"), "https://devforum.roblox.com/t/my-slug/123");
  assert.equal(topicUrl(123, "my-slug", 4), "https://devforum.roblox.com/t/my-slug/123/4");
  assert.equal(categoryName(28), "engine-bugs");
  assert.equal(categoryName(999999), "category-999999");
});

// DeepSeek called get_thread with {topicId} and get_engine_api with "Humanoid.LoadAnimation"
// — the spellings our own output teaches — and got validation errors from the tools that
// printed them. Both spellings resolve now.
test("parseTopicId reports a missing topic instead of throwing", () => {
  assert.equal(parseTopicId(undefined), undefined);
});

// Roblox keeps release notes off the docs repo, so every path spelling 404s. The dead end
// has to name the tool that does have them, or a model just keeps guessing paths.
test("release-notes queries are recognised so the dead end can redirect", async () => {
  const { isReleaseNotesQuery } = await import("../dist/tools/docs.js");
  for (const q of [
    "release notes 736",
    "release-notes-736",
    "content/en-us/release-notes/release-notes-736.md",
    "updates release notes",
    "content/en-us/updates/736",
    "changelog",
  ]) {
    assert.equal(isReleaseNotesQuery(q), true, `${q} must be recognised`);
  }
  for (const q of ["DataStoreService", "data store limits", "ProximityPrompt"]) {
    assert.equal(isReleaseNotesQuery(q), false, `${q} must not be diverted`);
  }
});

test("get_engine_api resolves a member path to its class", async () => {
  const { splitApiEntry } = await import("../dist/tools/docs.js");
  assert.deepEqual(splitApiEntry("Humanoid.LoadAnimation"), {
    raw: "Humanoid.LoadAnimation",
    className: "Humanoid",
    memberName: "LoadAnimation",
  });
  // A bare class name must still look up the class, not be read as a member.
  assert.deepEqual(splitApiEntry("Humanoid"), { raw: "Humanoid", className: "Humanoid" });
});

test("parseTopicId accepts ids, urls and slugs", () => {
  assert.equal(parseTopicId(4756879), 4756879);
  assert.equal(parseTopicId(" 4756879 "), 4756879);
  assert.equal(parseTopicId("https://devforum.roblox.com/t/datastore-502/3665478/7"), 3665478);
  assert.equal(parseTopicId("/t/3665478"), 3665478);
  assert.equal(parseTopicId("not a topic"), undefined);
});

test("rank promotes solved and recent threads over stale unanswered ones", () => {
  const fresh = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stale = new Date(Date.now() - 6 * 365 * 86_400_000).toISOString();
  const topics = [
    { id: 1, title: "old unanswered", bumped_at: stale, posts_count: 1, like_count: 0 },
    { id: 2, title: "recent solved", bumped_at: fresh, posts_count: 9, reply_count: 8, like_count: 12, has_accepted_answer: true },
  ];
  const ranked = rank(topics, []);
  assert.equal(ranked[0].topic.id, 2);

  const original = rank(topics, [], true);
  assert.equal(original[0].topic.id, 1);
});

test("rank attaches the earliest matching post to its topic", () => {
  const topics = [{ id: 7, title: "t" }];
  const posts = [
    { id: 20, topic_id: 7, post_number: 5, blurb: "later" },
    { id: 10, topic_id: 7, post_number: 1, blurb: "first" },
  ];
  assert.equal(rank(topics, posts)[0].post.blurb, "first");
});

test("bugStatus reads staff triage tags", () => {
  assert.equal(bugStatus({ id: 1, title: "a", tags: ["confirmed", "datastore"] }), "confirmed");
  assert.equal(bugStatus({ id: 1, title: "a", tags: ["cannot-reproduce"] }), "cannot-reproduce");
  assert.equal(bugStatus({ id: 1, title: "a", has_accepted_answer: true }), "solved");
  assert.equal(bugStatus({ id: 1, title: "a" }), undefined);
});

test("docUrl maps repo paths to create.roblox.com", () => {
  assert.equal(
    docUrl("content/en-us/reference/engine/classes/DataStoreService.yaml"),
    "https://create.roblox.com/docs/reference/engine/classes/DataStoreService",
  );
  assert.equal(
    docUrl("content/en-us/cloud-services/data-stores/index.md"),
    "https://create.roblox.com/docs/cloud-services/data-stores",
  );
});

test("signature and securityOf format API dump members", () => {
  assert.equal(
    signature({
      MemberType: "Function",
      Name: "GetDataStore",
      ReturnType: { Name: "GlobalDataStore" },
      Parameters: [
        { Name: "name", Type: { Name: "string" } },
        { Name: "scope", Type: { Name: "string" }, Default: "global" },
      ],
    }),
    "GetDataStore(name: string, scope: string = global) -> GlobalDataStore",
  );
  assert.equal(signature({ MemberType: "Property", Name: "Health", ValueType: { Name: "float" } }), "Health: float");
  assert.equal(securityOf({ MemberType: "Property", Name: "X", Security: { Read: "None", Write: "None" } }), undefined);
  assert.equal(securityOf({ MemberType: "Function", Name: "X", Security: "RobloxScriptSecurity" }), "RobloxScriptSecurity");
});

test("queryTerms drops stopwords but never returns nothing", () => {
  assert.deepEqual(queryTerms("how do I fix data store limits"), ["fix", "data", "store", "limits"]);
  assert.deepEqual(queryTerms("how to use it"), ["how", "to", "use", "it"]);
});

test("scorePath rewards full-query coverage and exact page names", () => {
  const terms = ["datastoreservice"];
  const exact = scorePath("content/en-us/reference/engine/classes/DataStoreService.yaml", terms, "datastoreservice");
  const partial = scorePath("content/en-us/cloud-services/data-stores/index.md", ["data", "store"], "datastore");
  assert.ok(exact > partial);
  assert.equal(scorePath("content/en-us/ui/buttons.md", ["datastore"], "datastore"), 0);
});

test("blurbs and automated posts are cleaned up", async () => {
  const { isAutomated } = await import("../dist/tools/forum.js");
  assert.equal(isAutomated({ username: "system", cooked: "<p>This topic was automatically closed.</p>" }), true);
  assert.equal(isAutomated({ username: "system", cooked: "<p>A real answer.</p>" }), false);
  assert.equal(isAutomated({ username: "someone", cooked: "<p>automatically closed</p>" }), false);
  assert.equal(decodeEntities("entry &amp; entryKey=1"), "entry & entryKey=1");
});

test("a fresh thread outranks an old solved one", () => {
  const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const topics = [
    { id: 1, title: "old solved", bumped_at: at(6 * 365), posts_count: 9, reply_count: 8, like_count: 20, has_accepted_answer: true },
    { id: 2, title: "fresh unsolved", bumped_at: at(20), posts_count: 4, reply_count: 3, like_count: 1 },
  ];
  assert.equal(rank(topics, [])[0].topic.id, 2);
});

test("age still loses to a much better relevance match", () => {
  const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const topics = [
    { id: 1, title: "top hit, 1 year old", bumped_at: at(365), posts_count: 6, reply_count: 5, like_count: 10, has_accepted_answer: true },
    { id: 2, title: "weak hit, brand new", bumped_at: at(2), posts_count: 1, like_count: 0 },
  ];
  assert.equal(rank(topics, [])[0].topic.id, 1);
});

test("parseDeprecationMessage reads inline and block-scalar values", async () => {
  const { parseDeprecationMessage } = await import("../dist/docs.js");
  const yaml = [
    "name: BodyVelocity",
    "deprecation_message: |",
    "  This object is deprecated and should not be used for new work.",
    "  Use LinearVelocity instead.",
    "properties:",
    "  - name: BodyVelocity.Velocity",
    "    deprecation_message: 'Use LinearVelocity.VectorVelocity.'",
    "    security:",
    "      read: None",
    "  - name: BodyVelocity.P",
    "    deprecation_message: ''",
  ].join("\n");
  assert.match(parseDeprecationMessage(yaml), /Use LinearVelocity instead/);
  assert.equal(parseDeprecationMessage(yaml, "Velocity"), "Use LinearVelocity.VectorVelocity.");
  assert.equal(parseDeprecationMessage(yaml, "P"), undefined);
  assert.equal(parseDeprecationMessage(yaml, "Missing"), undefined);
});

test("cachedJson round-trips and reuses a fresh entry", async () => {
  const { cachedJson } = await import("../dist/cache.js");
  const key = `test-${Date.now()}`;
  let calls = 0;
  const load = async () => { calls += 1; return { value: calls }; };
  assert.deepEqual(await cachedJson(key, 60_000, load), { value: 1 });
  assert.deepEqual(await cachedJson(key, 60_000, load), { value: 1 }, "second call should hit disk");
  assert.equal(calls, 1);
  assert.deepEqual(await cachedJson(key, -1, load), { value: 2 }, "expired entry should reload");

  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  await rm(join(tmpdir(), "roblox-devforum-mcp", `${key}.json`), { force: true });
});

test("mergeResults dedupes and promotes topics found by several phrasings", async () => {
  const { mergeResults } = await import("../dist/rank.js");
  const t = (id) => ({ id, title: `t${id}` });
  const { topics, matchedBy } = mergeResults([
    { query: "a", topics: [t(1), t(2)], posts: [{ id: 10, topic_id: 1, post_number: 1 }] },
    { query: "b", topics: [t(3), t(2)], posts: [{ id: 10, topic_id: 1, post_number: 1 }] },
  ]);
  assert.equal(topics[0].id, 2, "matched by both queries, so first");
  assert.deepEqual(topics.map((x) => x.id).sort(), [1, 2, 3]);
  assert.deepEqual(matchedBy.get(2), ["a", "b"]);
  assert.deepEqual(matchedBy.get(1), ["a"]);
});

test("rank scores agreement between phrasings", async () => {
  const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const topics = [
    { id: 1, title: "one phrasing", bumped_at: at(20), posts_count: 5, reply_count: 4 },
    { id: 2, title: "three phrasings", bumped_at: at(20), posts_count: 5, reply_count: 4 },
  ];
  const matchedBy = new Map([[1, ["a"]], [2, ["a", "b", "c"]]]);
  assert.equal(rank(topics, [], false, matchedBy)[0].topic.id, 2);
  assert.equal(rank(topics, [], false)[0].topic.id, 1, "without agreement data, order is unchanged");
});

test("htmlToMarkdown keeps quotes only when asked", () => {
  const html = '<aside class="quote"><blockquote><p>real recap intro</p></blockquote></aside>';
  assert.match(htmlToMarkdown(html, { keepQuotes: true }), /real recap intro/);
  assert.match(htmlToMarkdown(html), /\[quoted earlier reply\]/);
  assert.doesNotMatch(htmlToMarkdown(html), /real recap intro/);
});

test("likesOf falls back to the matched post when search omits topic likes", () => {
  assert.equal(likesOf({ id: 1, title: "t", like_count: 12 }, { id: 2, post_number: 1, like_count: 3 }), 12);
  assert.equal(likesOf({ id: 1, title: "t" }, { id: 2, post_number: 1, like_count: 8 }), 8);
  assert.equal(
    likesOf({ id: 1, title: "t" }, { id: 2, post_number: 1, actions_summary: [{ id: 2, count: 5 }] }),
    5,
  );
  assert.equal(likesOf({ id: 1, title: "t" }), 0);
});

test("htmlToMarkdown pulls stranded heading and list markers back onto their text", () => {
  const html =
    '<h2><a name="p-1-news" class="anchor" href="#p-1-news"></a>\nNews &amp; Alerts</h2>' +
    "<ul><li>\nWe shared a PSA</li></ul>";
  const md = htmlToMarkdown(html);
  assert.match(md, /^## News & Alerts$/m);
  assert.match(md, /^- We shared a PSA$/m);
  assert.doesNotMatch(md, /^##\s*$/m, "no bare heading marker on its own line");
  assert.doesNotMatch(md, /^-\s*$/m, "no bare list marker on its own line");
});

test("category slugs resolve to a canonical path, live or from the shipped fallback", async () => {
  const { categoryPath, resolveCategory, suggestCategories } = await import("../dist/categories.js");

  assert.equal(categoryPath("release-notes"), "updates/release-notes/62");
  assert.equal(categoryPath("bug-reports"), "bug-reports/10");
  assert.equal(categoryPath("Scripting-Support"), "help-and-feedback/scripting-support/55");
  // An unknown slug still builds a path Discourse can redirect, rather than throwing.
  assert.equal(categoryPath("brand-new-category"), "brand-new-category");
  assert.equal(resolveCategory("nope"), undefined);

  assert.deepEqual(suggestCategories("scripting"), ["scripting-support"]);
  assert.ok(suggestCategories("engine-bug").includes("engine-bugs"));
  assert.deepEqual(suggestCategories("!!!"), []);
  // Only the best tier: "bugs" alone also matches xbox-bugs, but offering it alongside the
  // exact answer makes the correction harder to read, not easier.
  assert.deepEqual(suggestCategories("studio bugs"), ["studio-bugs"]);

  // A distinctive word matching nothing must not fall back on the shared suffix:
  // "physics-bugs" answered "did you mean xbox-bugs, other-bugs, forum-bugs?" - all wrong.
  assert.deepEqual(suggestCategories("physics-bugs"), ["bug-reports"]);
  assert.deepEqual(suggestCategories("networking-features"), ["feature-requests"]);
  assert.deepEqual(suggestCategories("lua-support"), ["help-and-feedback"]);
});

// Live check: the ids the tools use must be the ids the forum publishes. Skipped rather
// than failed when the forum is unreachable.
test("the live site.json tree agrees with the shipped fallback", async (t) => {
  const { CATEGORIES, ensureCategories, resolveCategory } = await import("../dist/categories.js");
  const { listCategories } = await import("../dist/discourse.js");

  await ensureCategories();
  let tree;
  try {
    tree = await listCategories();
  } catch {
    return t.skip("DevForum unreachable");
  }
  if (tree.length === 0) return t.skip("DevForum unreachable");

  const advertised = tree.flatMap((c) => [c.slug, ...c.subcategories.map((s) => s.slug)]);
  const unresolved = advertised.filter((slug) => !resolveCategory(slug));
  assert.deepEqual(unresolved, [], "list_categories must not advertise slugs the filters reject");

  const drifted = Object.entries(CATEGORIES)
    .filter(([slug, id]) => resolveCategory(slug) && resolveCategory(slug).id !== id)
    .map(([slug]) => slug);
  assert.deepEqual(drifted, [], "shipped fallback ids no longer match the forum — refresh them");
});

test("splitApiEntry keeps the member when Luau writes it with a colon", async () => {
  const { splitApiEntry } = await import("../dist/tools/docs.js");

  // The colon form used to be cut at the ":", so a deprecated member reported "OK, class X".
  assert.deepEqual(splitApiEntry("Humanoid:LoadAnimation"), {
    raw: "Humanoid.LoadAnimation",
    className: "Humanoid",
    memberName: "LoadAnimation",
  });
  assert.deepEqual(splitApiEntry("game:GetService(\"DataStoreService\")"), {
    raw: "DataModel.GetService",
    className: "DataModel",
    memberName: "GetService",
  });
  // `game` is the DataModel, not a prefix to throw away.
  assert.equal(splitApiEntry("game").className, "DataModel");
  assert.equal(splitApiEntry("game.HttpGet").className, "DataModel");
  // The class is the segment the member hangs off, so instance paths still resolve.
  assert.deepEqual(splitApiEntry("game.Workspace.Terrain"), {
    raw: "DataModel.Workspace.Terrain",
    className: "Workspace",
    memberName: "Terrain",
  });
  assert.deepEqual(splitApiEntry("BodyVelocity"), { raw: "BodyVelocity", className: "BodyVelocity" });
  assert.equal(splitApiEntry("Enum.RaycastFilterType").raw, "Enum.RaycastFilterType");
});

test("broaden trims a symptom sentence to its distinctive words", async () => {
  const { broaden } = await import("../dist/tools/forum.js");

  assert.equal(broaden("ProximityPrompt not triggering on mobile"), "ProximityPrompt triggering");
  // Nothing to gain when the query is already short or is all filler.
  assert.equal(broaden("ProximityPrompt mobile"), undefined);
  assert.equal(broaden("why is it not working"), undefined);
});

test("envInt falls back instead of poisoning comparisons with NaN", async () => {
  const { envInt } = await import("../dist/http.js");
  const KEY = "DEVFORUM_QA_PROBE";
  const restore = process.env[KEY];

  try {
    delete process.env[KEY];
    assert.equal(envInt(KEY, 4, 1), 4);
    process.env[KEY] = "";
    assert.equal(envInt(KEY, 4, 1), 4);
    process.env[KEY] = "8";
    assert.equal(envInt(KEY, 4, 1), 8);
    // A NaN limit made "active < limit" permanently false, which queued every request
    // forever; below-minimum values (0 concurrency) hung in exactly the same way.
    process.env[KEY] = "abc";
    assert.equal(envInt(KEY, 4, 1), 4);
    process.env[KEY] = "0";
    assert.equal(envInt(KEY, 4, 1), 4);
    assert.equal(envInt(KEY, 300, 0), 0); // 0 is legitimate where the minimum allows it
    process.env[KEY] = "-5";
    assert.equal(envInt(KEY, 14, 1), 14);
    process.env[KEY] = "2.7";
    assert.equal(envInt(KEY, 4, 1), 2);
  } finally {
    if (restore === undefined) delete process.env[KEY];
    else process.env[KEY] = restore;
  }
});

test("renderWithin keeps whole posts inside the token budget", async () => {
  const { renderWithin } = await import("../dist/tools/forum.js");
  const topic = { id: 7, title: "long thread", category_id: 55 };
  const posts = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    post_number: i + 1,
    username: `dev${i}`,
    created_at: new Date().toISOString(),
    cooked: `<p>${"reply body ".repeat(80)}</p>`,
  }));

  // Budgeting only the per-post slice multiplied the 120-token floor by the post count,
  // so 30 posts against a 300-token budget rendered roughly 1,700 tokens.
  const tight = renderWithin(posts, topic, 300, "hint");
  assert.ok(tight.shown < posts.length, "a small budget must render fewer posts, not shredded ones");
  assert.ok(tight.body.length <= 300 * 4 + 80, `body was ${tight.body.length} chars for a 300-token budget`);

  const roomy = renderWithin(posts, topic, 4000, "hint");
  assert.ok(roomy.shown > tight.shown, "a larger budget must render more posts");
  assert.ok(roomy.body.length <= 4000 * 4 + 80);
});

test("resolveDocPath keeps caller paths inside the docs tree", async () => {
  const { resolveDocPath } = await import("../dist/docs.js");
  const ROOT = "content/en-us/";

  // Accepts the forms a caller actually has: with the prefix, without it, leading slash.
  assert.equal(resolveDocPath("cloud-services/data-stores/index.md"), `${ROOT}cloud-services/data-stores/index.md`);
  assert.equal(resolveDocPath("/cloud-services/data-stores/index.md"), `${ROOT}cloud-services/data-stores/index.md`);
  assert.equal(resolveDocPath(`${ROOT}reference/engine/classes/DataStoreService.yaml`), `${ROOT}reference/engine/classes/DataStoreService.yaml`);
  assert.equal(resolveDocPath("guides/./intro.md"), `${ROOT}guides/intro.md`);

  // "../../README.md" used to walk out of the docs root and return the repository's own
  // README under a nonsense create.roblox.com/docs/../../README URL.
  assert.throws(() => resolveDocPath("../../README.md"), /outside the documentation tree/);
  assert.throws(() => resolveDocPath(`${ROOT}../../README.md`), /outside the documentation tree/);
  assert.throws(() => resolveDocPath("../"), /outside the documentation tree/);
});
