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
        { MemberType: "Function", Name: "findFirstChild", Tags: ["Deprecated"], ReturnType: { Name: "Instance" }, Parameters: [{ Name: "name", Type: { Name: "string" } }] },
      ],
    },
    {
      Name: "Humanoid",
      Superclass: "Instance",
      Members: [{ MemberType: "Function", Name: "MoveTo", ReturnType: { Name: "null" }, Parameters: [{ Name: "location", Type: { Name: "Vector3" } }] }],
    },
  ],
  Enums: [{ Name: "Material", Items: [{ Name: "Neon", Value: 288 }, { Name: "Plastic", Value: 256 }] }],
};

const pages = {
  "libraries/task.yaml": "name: task\ntype: library\nfunctions:\n  - name: task.wait\n    summary: |\n      Yields.\n    parameters:\n      - name: duration\n        type: number\n    tags: []\n    deprecation_message: ''\n",
  "globals/LuaGlobals.yaml": "name: Lua globals\ntype: global\nfunctions:\n  - name: print\n    summary: |\n      Prints.\n    tags: []\n",
  "globals/RobloxGlobals.yaml":
    "name: Roblox globals\ntype: global\nfunctions:\n  - name: wait\n    summary: |\n      Yields, throttled.\n    parameters:\n      - name: seconds\n        type: number\n    tags:\n      - Deprecated\n    deprecation_message: |\n      This method has been superseded by `Library.task.wait()` and should not be\n      used for future work.\n",
};

let forum = () => undefined;

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
