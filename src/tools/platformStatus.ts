import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { URLS } from "../config.js";
import type { AppContext } from "../context.js";
import { parseStatusPage } from "../lib/htmlParse.js";
import { fail, ok } from "../lib/responses.js";

const inputShape = {
  verbose: z.boolean().default(false).describe("Include unresolved incident descriptions."),
};

const outputShape = {
  url: z.string(),
  components: z.array(
    z.object({ name: z.string(), status: z.string(), description: z.string().optional() })
  ),
  incidents: z.array(
    z.object({ name: z.string(), status: z.string(), shortlink: z.string().optional() })
  ),
  summary: z.record(z.string(), z.array(z.string())),
};

interface Input {
  verbose: boolean;
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "platform_status",
    {
      title: "Roblox Platform Status",
      description:
        "Live status of Roblox services (website, Studio, API, game servers) and active incidents.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (raw): Promise<ReturnType<typeof ok>> => {
      const input = raw as Input;
      try {
        const html = await ctx.http.getHtml(URLS.robloxStatus, { cache: false });
        const data = parseStatusPage(html);

        const summary: Record<string, string[]> = {};
        for (const c of data.components) {
          const list = summary[c.status] ?? [];
          list.push(c.name);
          summary[c.status] = list;
        }

        let text = `Roblox Platform Status\nURL: ${URLS.robloxStatus}\n\n`;
        for (const [status, names] of Object.entries(summary)) {
          text += `### ${status.toUpperCase()}\n`;
          for (const n of names) text += `- ${n}\n`;
          text += "\n";
        }
        if (input.verbose && data.incidents.length > 0) {
          text += "### Active Incidents\n";
          for (const inc of data.incidents) {
            text += `- **${inc.name}**: ${inc.status}\n`;
          }
        }

        return ok(text.trim(), {
          url: URLS.robloxStatus,
          components: data.components,
          incidents: data.incidents,
          summary,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
