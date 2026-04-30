import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SERVER_PATH = join(ROOT, "build", "index.js");

// ── JSON-RPC over stdio helpers ──────────────────────────────

function encodeRpc(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function createRpcReader(stream) {
  let buf = "";
  const queue = [];
  let resolve = null;

  stream.on("data", (chunk) => {
    buf += chunk.toString();
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const msgStart = headerEnd + 4;
      if (buf.length < msgStart + len) break;
      const json = buf.slice(msgStart, msgStart + len);
      buf = buf.slice(msgStart + len);
      try {
        const obj = JSON.parse(json);
        if (resolve) {
          const r = resolve;
          resolve = null;
          r(obj);
        } else {
          queue.push(obj);
        }
      } catch {
        // ignore bad JSON
      }
    }
  });

  return () =>
    new Promise((res) => {
      if (queue.length) {
        res(queue.shift());
      } else {
        resolve = res;
      }
    });
}

// ── Test Runner ────────────────────────────────────────────────

async function run() {
  console.log(`Spawning MCP server: ${SERVER_PATH}\n`);

  const proc = spawn("node", [SERVER_PATH], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const read = createRpcReader(proc.stdout);
  const errors = [];

  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) errors.push(line);
  });

  proc.on("error", (e) => {
    console.error("Process error:", e.message);
    process.exit(1);
  });

  proc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`Server exited with code ${code}`);
      if (errors.length) console.error("Stderr:", errors.join("\n"));
    }
  });

  // Send initialize
  proc.stdin.write(
    encodeRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-harness", version: "0.1.0" },
      },
    })
  );

  const initRes = await read();
  console.log("1. Initialize:", initRes.error ? `ERROR: ${JSON.stringify(initRes.error)}` : "OK");
  if (initRes.error) throw new Error("Initialize failed");

  // Send initialized notification
  proc.stdin.write(
    encodeRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
  );

  // List tools
  proc.stdin.write(
    encodeRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
  );

  const toolsRes = await read();
  const tools = toolsRes.result?.tools || [];
  console.log(`2. Tools registered: ${tools.length}`);
  if (!tools.length) {
    console.error("No tools found!");
    proc.kill();
    process.exit(1);
  }

  // Print missing vs expected
  const expected = [
    "get_announcements",
    "get_latest_posts",
    "search_devforum",
    "get_thread",
    "get_action_required",
    "get_engine_updates",
    "get_category",
    "get_top_posts",
    "get_post_replies",
    "get_user_posts",
    "get_api_docs",
    "search_creator_docs",
    "get_creator_docs",
    "get_luau_docs",
    "get_categories",
    "get_tags",
    "get_category_metadata",
    "search_bugs",
    "get_solved_topics",
    "get_new_posts",
    "search_api_member",
    "get_class_hierarchy",
    "get_enum",
    "search_community_resources",
    "get_roblox_status",
  ];
  const registered = new Map(tools.map((t) => [t.name, t]));
  const missing = expected.filter((n) => !registered.has(n));
  const extra = [...registered.keys()].filter((n) => !expected.includes(n));
  if (missing.length) console.log("   MISSING:", missing.join(", "));
  if (extra.length) console.log("   EXTRA:", extra.join(", "));

  // Helper for calling tools
  async function callTool(name, args = {}, label) {
    proc.stdin.write(
      encodeRpc({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name, arguments: args },
      })
    );
    const res = await read();
    const ok = !res.error && res.result?.content?.[0]?.text;
    const text = res.result?.content?.[0]?.text || "";
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    const err = res.error ? JSON.stringify(res.error) : "";
    console.log(`${label}: ${ok ? "PASS" : `FAIL ${err.slice(0,120)}`} | ${snippet.slice(0,200)}`);
    return { ok, text, error: res.error };
  }

  // ── Tool Tests ─────────────────────────────────────────────
  console.log("\n--- Running tool tests ---\n");

  await callTool("get_announcements", { limit: 2 }, "3a. announcements");
  await callTool("get_latest_posts", { limit: 2 }, "3b. latest_posts");
  await callTool("search_devforum", { query: "Workspace", limit: 2 }, "3c. search");
  await callTool("get_thread", { thread_id: "1" }, "3d. thread (bad id — expect 404-ish)");
  await callTool("get_engine_updates", {}, "3e. engine_updates");
  await callTool("get_category", { slug: "help-and-feedback", category_id: 35, limit: 2 }, "3f. category");
  await callTool("get_top_posts", { period: "daily" }, "3g. top_posts");

  await callTool("get_api_docs", { class_name: "BasePart", include_inherited: false }, "4a. api_docs");
  await callTool("search_api_member", { query: "Touched", limit: 3 }, "4b. api_member");
  await callTool("get_class_hierarchy", { class_name: "BasePart" }, "4c. class_hierarchy");
  await callTool("get_enum", { name: "Material" }, "4d. enum");

  await callTool("search_creator_docs", { query: "VectorForce", limit: 2 }, "5a. creator_docs_search");
  await callTool("get_creator_docs", { path: "docs/reference/engine/classes/BasePart" }, "5b. creator_docs_get");
  await callTool("get_luau_docs", { library: "math" }, "5c. luau_docs");
  await callTool("search_community_resources", { query: "NPC", limit: 2 }, "5d. community_resources");

  await callTool("search_bugs", { query: "crash", category: "studio-bugs", limit: 2 }, "6a. search_bugs");
  await callTool("get_solved_topics", { query: "Physics", limit: 2 }, "6b. solved_topics");
  await callTool("get_new_posts", { limit: 2 }, "6c. new_posts");
  await callTool("get_roblox_status", {}, "6d. roblox_status");
  await callTool("get_user_posts", { username: "Roblox" }, "6e. user_posts");

  proc.stdin.end();
  console.log("\n--- All tests sent ---");

  // Give a moment for any queued stderr
  await new Promise((r) => setTimeout(r, 2000));
  if (errors.length) {
    console.log("\nStderr during run:");
    for (const e of errors.slice(0, 5)) console.log(" ", e);
  }
  proc.kill();
}

run().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
