import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

const EXPECTED = [
  "search_devforum",
  "search_bugs",
  "get_thread",
  "get_replies",
  "list_recent",
  "list_categories",
  "search_creator_docs",
  "get_engine_api",
  "get_whats_new",
  "get_weekly_recap",
  "check_api_health",
];

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createServer();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("server exposes every tool with a usable schema", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());

  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
  }
  await close();
});

test("invalid arguments fail without hitting the network", async () => {
  const { client, close } = await connect();
  const res = await client.callTool({ name: "get_engine_api", arguments: { name: "x" } });
  assert.equal(res.isError, true);
  await close();
});

test("an unparseable topic reference returns a tool error, not a throw", async () => {
  const { client, close } = await connect();
  const res = await client.callTool({ name: "get_thread", arguments: { topic: "nonsense" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /topic id/i);
  await close();
});
