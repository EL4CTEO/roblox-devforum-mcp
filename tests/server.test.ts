import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("registers tools, resources, prompts without throwing", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const handle = createServer(config);
    expect(handle.server).toBeDefined();
    expect(handle.ctx.config.RDFM_LOG_LEVEL).toBe("info");
  });
});
