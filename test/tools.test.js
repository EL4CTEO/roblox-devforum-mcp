// End-to-end tool calls against a fake network: a tiny API dump, docs tree and forum, so the
// behaviour a model actually sees is checked without touching the real services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A private disk cache, so the real (fresh) api-dump.json in the shared cache is never read.
process.env.DEVFORUM_MAX_RETRIES = "0";
process.env.DEVFORUM_CACHE_DIR = mkdtempSync(join(tmpdir(), "devforum-mcp-test-"));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/index.js");
const { clearCache } = await import("../dist/http.js");

const DOCS = "content/en-us/reference/engine/";

const dump = {
  Classes: [
    {
      Name: "Instance",
      Tags: ["NotCreatable"],
      Members: [
        { MemberType: "Function", Name: "FindFirstChild", ReturnType: { Name: "Instance" }, Parameters: [{ Name: "name", Type: { Name: "string" } }] },
        { MemberType: "Property", Name: "Parent", ValueType: { Name: "Instance" } },
        { MemberType: "Function", Name: "findFirstChild", Tags: ["Deprecated"], ReturnType: { Name: "Instance" }, Parameters: [{ Name: "name", Type: { Name: "string" } }] },
      ],
    },
    {
      Name: "DataModel",
      Superclass: "Instance",
      Members: [
        { MemberType: "Property", Name: "Workspace", ValueType: { Name: "Workspace" } },
        { MemberType: "Property", Name: "lighting", ValueType: { Name: "Instance" }, Tags: ["Deprecated"] },
      ],
    },
    { Name: "Lighting", Superclass: "Instance", Members: [{ MemberType: "Property", Name: "ClockTime", ValueType: { Name: "float" } }] },
    { Name: "Script", Superclass: "Instance", Members: [] },
    { Name: "Workspace", Superclass: "Instance", Tags: ["NotCreatable", "Service"], Members: [] },
    { Name: "Players", Superclass: "Instance", Tags: ["NotCreatable", "Service"], Members: [{ MemberType: "Property", Name: "LocalPlayer", ValueType: { Name: "Player" } }] },
    { Name: "Player", Superclass: "Instance", Members: [{ MemberType: "Property", Name: "Character", ValueType: { Name: "Model" } }] },
    { Name: "Model", Superclass: "Instance", Members: [] },
    {
      Name: "Humanoid",
      Superclass: "Instance",
      Members: [
        { MemberType: "Function", Name: "MoveTo", ReturnType: { Name: "null" }, Parameters: [{ Name: "location", Type: { Name: "Vector3" } }] },
        { MemberType: "Property", Name: "Health", ValueType: { Name: "float" } },
        { MemberType: "Property", Name: "MaxHealth", ValueType: { Name: "float" } },
      ],
    },
  ],
  Enums: [
    { Name: "Material", Items: [{ Name: "Neon", Value: 288 }, { Name: "Plastic", Value: 256 }] },
    { Name: "Font", Items: [{ Name: "Arial", Value: 1 }] },
  ],
};

const pages = {
  "datatypes/Font.yaml": "name: Font\ntype: datatype\nsummary: |\n  A font.\nconstructors:\n  - name: Font.new\n    summary: |\n      Makes one.\n",
  "libraries/task.yaml": "name: task\ntype: library\nfunctions:\n  - name: task.wait\n    summary: |\n      Yields.\n    parameters:\n      - name: duration\n        type: number\n    tags: []\n    deprecation_message: ''\n",
  "globals/LuaGlobals.yaml": "name: Lua globals\ntype: global\nfunctions:\n  - name: print\n    summary: |\n      Prints.\n    tags: []\n",
  "globals/RobloxGlobals.yaml":
    "name: Roblox globals\ntype: global\nfunctions:\n  - name: wait\n    summary: |\n      Yields, throttled.\n    parameters:\n      - name: seconds\n        type: number\n    tags:\n      - Deprecated\n    deprecation_message: |\n      This method has been superseded by `Library.task.wait()` and should not be\n      used for future work.\n",
};

let forum = () => undefined;
const json200 = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

globalThis.fetch = async (input) => {
  const url = String(input);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.includes("api.github.com")) {
    const tree = [...Object.keys(pages), "datatypes/Vector3.yaml"].map((p) => ({ path: DOCS + p, type: "blob" }));
    return json({ tree });
  }
  if (url.includes("API-Dump.json")) return new Response(JSON.stringify(dump));
  if (url.includes("raw.githubusercontent.com/Roblox/creator-docs")) {
    const page = pages[url.slice(url.indexOf(DOCS) + DOCS.length)];
    return page === undefined ? new Response("404: Not Found", { status: 404 }) : new Response(page);
  }
  if (url.includes("/site.json")) return json({ categories: [] });
  const answer = await forum(url);
  return answer ?? json({}, 404);
};

async function call(name, args) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  const server = createServer();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
  } finally {
    await client.close();
    await server.close();
  }
}

const lineFor = (text, entry) => text.split("\n").find((l) => l.includes(` ${entry} —`)) ?? "";

test("check_api_health tells exact spellings, twins, libraries and globals apart", async () => {
  const { text } = await call("check_api_health", {
    members: [
      "Instance.FindFirstChild",
      "Instance.findFirstChild",
      "Humanoid.moveTo",
      "Humanoid.new",
      "Instance.new",
      "Enum.Material.neon",
      "task.wait",
      "Task.wait",
      "wait",
      "print",
      "Vector3.Magnitude",
    ],
  });
  assert.match(lineFor(text, "Instance.FindFirstChild"), /^OK /);
  // The deprecated camelCase twin used to be matched to FindFirstChild and reported current.
  assert.match(lineFor(text, "Instance.findFirstChild"), /^DEPRECATED /);
  assert.match(lineFor(text, "Humanoid.moveTo"), /^WRONG CASE .*Humanoid:MoveTo/);
  // Only Instance has a Luau constructor; "Humanoid.new" used to be waved through.
  assert.match(lineFor(text, "Humanoid.new"), /^NOT FOUND .*Instance\.new\("Humanoid"\)/);
  assert.match(lineFor(text, "Instance.new"), /^OK /);
  assert.match(lineFor(text, "Enum.Material.neon"), /^WRONG CASE .*Enum\.Material\.Neon/);
  // task.wait used to be "no class task in the current API".
  assert.match(lineFor(text, "task.wait"), /^OK .*task library/);
  assert.match(lineFor(text, "Task.wait"), /^WRONG CASE .*task\.wait/);
  assert.match(lineFor(text, "wait"), /^DEPRECATED .*superseded by `task\.wait\(\)`/);
  assert.match(lineFor(text, "print"), /^OK /);
  // The Vector3 page 404s. That entry says so; the rest of the batch still answers.
  assert.match(lineFor(text, "Vector3.Magnitude"), /^UNKNOWN /);
});

test("get_engine_api reads a library function from the docs", async () => {
  const { text, isError } = await call("get_engine_api", { name: "task.wait" });
  assert.equal(isError, false);
  assert.match(text, /task is a Luau library/);
  assert.match(text, /- name: task\.wait/);
  const methods = await call("get_engine_api", { name: "Humanoid.MoveTo" });
  assert.match(methods.text, /MoveTo\(location: Vector3\) -> \(\)/, "a void return reads (), not null");
});

test("search_devforum keeps the phrasings that answered when one fails", async () => {
  clearCache();
  forum = (url) => {
    if (!url.includes("/search.json")) return undefined;
    const q = new URL(url).searchParams.get("q") ?? "";
    if (q.startsWith("broken")) throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({ topics: [{ id: 7, title: "TweenService tween not playing", posts_count: 3 }], posts: [{ id: 70, topic_id: 7, post_number: 1 }] }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const { text, isError } = await call("search_devforum", { query: ["tween not playing", "broken phrasing"] });
  assert.equal(isError, false, text);
  assert.match(text, /TweenService tween not playing/);
  assert.match(text, /"broken phrasing" could not be searched and was skipped/);
});

test("get_thread hoists an accepted answer that sits past the first chunk", async () => {
  clearCache();
  const post = (n, extra = {}) => ({ id: 1000 + n, post_number: n, username: `u${n}`, cooked: `<p>post ${n}</p>`, ...extra });
  forum = (url) => {
    const body = url.includes("/posts/by_number/55/40.json")
      ? post(40, { cooked: "<p>the real answer</p>", accepted_answer: true })
      : url.includes("/t/55.json")
        ? {
            id: 55,
            title: "Long thread",
            posts_count: 43,
            accepted_answer: { post_number: 40 },
            post_stream: { posts: Array.from({ length: 20 }, (_, i) => post(i + 1)), stream: Array.from({ length: 43 }, (_, i) => 1001 + i) },
          }
        : undefined;
    return body && new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const { text } = await call("get_thread", { topic: 55, max_posts: 3 });
  assert.match(text, /#40 by u40 ✅ ACCEPTED ANSWER/);
  assert.match(text, /the real answer/);
  assert.match(text, /answered \(a reply the asker marked as the solution\)/);
});

test("the enum shorthand gets the item and case checks the Enum. form gets", async () => {
  const { text } = await call("check_api_health", {
    members: ["Material.Neon", "Material.TotallyFake", "material", "Font.new", "Font.Arial"],
  });
  assert.match(lineFor(text, "Material.Neon"), /^OK .*Write it Enum\.Material\.Neon/);
  // Both used to be "OK — Enum.Material exists".
  assert.match(lineFor(text, "Material.TotallyFake"), /^NOT FOUND .*no item "TotallyFake"/);
  assert.match(lineFor(text, "material"), /^WRONG CASE .*Enum\.Material/);
  // Font is an enum and a datatype: the constructor is the datatype's, the item the enum's.
  assert.match(lineFor(text, "Font.new"), /^OK .*datatype/);
  assert.match(lineFor(text, "Font.Arial"), /^OK .*Enum\.Font\.Arial = 1/);
});

test("get_engine_api resolves the enum shorthand and a named member exactly", async () => {
  const shorthand = await call("get_engine_api", { name: "Material.Neon" });
  assert.equal(shorthand.isError, false, shorthand.text);
  assert.match(shorthand.text, /^Enum\.Material\nNeon = 288/);
  const health = await call("get_engine_api", { name: "Humanoid.Health" });
  assert.match(health.text, /Health: float/);
  assert.doesNotMatch(health.text, /MaxHealth/, "a named member is matched whole, not as a substring");
  const substring = await call("get_engine_api", { name: "Humanoid", filter: "health" });
  assert.match(substring.text, /MaxHealth/, "an explicit filter stays a substring");
});

test("get_thread puts a Roblox_Staff reply ahead of community replies", async () => {
  clearCache();
  const post = (n, extra = {}) => ({ id: 2000 + n, post_number: n, username: `u${n}`, cooked: `<p>post ${n}</p>`, ...extra });
  forum = (url) =>
    url.includes("/t/66.json")
      ? json200({
          id: 66,
          title: "Engine bug",
          posts_count: 4,
          post_stream: {
            posts: [
              post(1),
              post(2, { actions_summary: [{ id: 2, count: 30 }] }),
              post(3, { actions_summary: [{ id: 2, count: 10 }] }),
              post(4, { username: "engineer", staff: false, primary_group_name: "Roblox_Staff", flair_name: "Roblox_Staff" }),
            ],
            stream: [2001, 2002, 2003, 2004],
          },
        })
      : undefined;
  const { text } = await call("get_thread", { topic: 66, max_posts: 2 });
  assert.match(text, /#4 by engineer \(Roblox staff\)/);
  assert.doesNotMatch(text, /#2 by u2/);
});

test("get_weekly_recap reads the pinned current recap, not the one before it", async () => {
  clearCache();
  forum = (url) => {
    if (url.includes("/tag/weekly-recap/l/latest.json")) {
      return json200({
        topic_list: {
          topics: [
            { id: 3, title: "Weekly Recap: September 21 - 25", pinned: true, pinned_globally: true, created_at: "2026-09-25T21:00:00Z" },
            { id: 2, title: "Weekly Recap: September 14–20", created_at: "2026-09-18T22:00:00Z" },
            { id: 1, title: "About the Announcements category", pinned: true, created_at: "2021-01-01T08:00:00Z" },
          ],
        },
      });
    }
    return undefined;
  };
  const { text } = await call("get_weekly_recap", { list: true, limit: 5 });
  assert.match(text, /^2 Weekly Recaps[\s\S]*- Weekly Recap: September 21 - 25\n[\s\S]*September 14–20/);
  assert.doesNotMatch(text, /About the/);
});

test("check_api_health follows a dotted path the way Luau evaluates it", async () => {
  const { text } = await call("check_api_health", {
    members: [
      "game.Players.LocalPlayer.Character",
      "game.Players.LocalPlayer.Character.Humanoid",
      "game.Players.LocalPlayer.Charcter",
      "workspace.Map.Door.Touched",
      "LoadLibrary",
      "game.Lighting.ClockTime",
      "script.Parent.Touched",
    ],
  });
  // Only the last two segments used to be read: "no class LocalPlayer".
  assert.match(lineFor(text, "game.Players.LocalPlayer.Character"), /^OK .*Character: Model/);
  assert.match(lineFor(text, "game.Players.LocalPlayer.Character.Humanoid"), /^OK .*child named "Humanoid"/);
  assert.match(lineFor(text, "game.Players.LocalPlayer.Charcter"), /^NOT FOUND .*Player has no member "Charcter"/);
  assert.match(lineFor(text, "workspace.Map.Door.Touched"), /^UNCHECKED .*"Map" is not a member of Workspace/);
  // The deprecated lower-case `lighting` property is typed Instance; the service is Lighting.
  assert.match(lineFor(text, "game.Lighting.ClockTime"), /^OK .*ClockTime: float/);
  // Parent can be any class, so "Instance has no member Touched" was a false alarm.
  assert.match(lineFor(text, "script.Parent.Touched"), /^UNCHECKED .*"Parent" is typed Instance/);
  assert.match(lineFor(text, "LoadLibrary"), /^NOT FOUND .*no class, enum, datatype, library or global named "LoadLibrary"/);
});

test("get_thread shows the reply a link points at", async () => {
  clearCache();
  const post = (n) => ({ id: 3000 + n, post_number: n, username: `u${n}`, cooked: `<p>post ${n}</p>` });
  forum = (url) =>
    url.includes("/posts/by_number/77/33.json")
      ? json200({ ...post(33), cooked: "<p>the linked reply</p>" })
      : url.includes("/t/77.json")
        ? json200({
            id: 77,
            title: "Long thread",
            posts_count: 40,
            post_stream: { posts: Array.from({ length: 20 }, (_, i) => post(i + 1)), stream: Array.from({ length: 40 }, (_, i) => 3001 + i) },
          })
        : undefined;
  const { text } = await call("get_thread", { topic: "https://devforum.roblox.com/t/long-thread/77/33", max_posts: 2 });
  assert.match(text, /#1 by u1[\s\S]*#33 by u33[\s\S]*the linked reply/);
});

test("get_whats_new reports the sections that loaded when one listing fails", async () => {
  clearCache();
  const now = new Date().toISOString();
  forum = (url) => {
    if (url.includes("/release-notes/")) throw new TypeError("fetch failed");
    if (url.includes("/tag/weekly-recap/")) {
      return json200({ topic_list: { topics: [{ id: 3, title: "Weekly Recap: this week", created_at: now }] } });
    }
    if (url.includes("/t/3.json")) throw new TypeError("fetch failed"); // the body is optional too
    if (url.includes("/announcements/")) {
      return json200({ topic_list: { topics: [{ id: 9, title: "A new API", created_at: now }] } });
    }
    return undefined;
  };
  const { text, isError } = await call("get_whats_new", { days: 7 });
  assert.equal(isError, false, text);
  assert.match(text, /Weekly Recap: this week/);
  assert.match(text, /A new API/);
  assert.match(text, /release notes could not be loaded and is left out/);
});
