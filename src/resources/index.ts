import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { URLS } from "../config.js";
import type { AppContext } from "../context.js";
import { LUAU_LIBRARY_NAMES, findLuauSection } from "../lib/htmlParse.js";
import { stripHtml } from "../lib/sanitize.js";
import type { ApiClass, DiscourseThreadResponse } from "../types.js";

function jsonResource(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function textResource(uri: string, text: string, mimeType = "text/markdown") {
  return { contents: [{ uri, mimeType, text }] };
}

function buildChain(cls: ApiClass, classes: ApiClass[]): string[] {
  const chain: string[] = [cls.Name];
  let current: ApiClass | undefined = cls;
  while (current?.Superclass && current.Superclass !== "<<<ROOT>>>") {
    chain.push(current.Superclass);
    const parent = classes.find((c) => c.Name === current?.Superclass);
    if (!parent) break;
    current = parent;
  }
  return chain;
}

export function registerAllResources(server: McpServer, ctx: AppContext): void {
  // Static: list of classes
  server.registerResource(
    "roblox-api-classes-index",
    "roblox-api://classes",
    {
      title: "Roblox API Classes Index",
      description: "Sorted list of every class name in the latest Full-API-Dump.",
      mimeType: "application/json",
    },
    async (uri) => {
      const dump = await ctx.apiDump.load();
      return jsonResource(uri.href, {
        version: dump.Version,
        count: dump.Classes.length,
        classes: dump.Classes.map((c) => c.Name).sort(),
      });
    }
  );

  // Static: list of enums
  server.registerResource(
    "roblox-api-enums-index",
    "roblox-api://enums",
    {
      title: "Roblox API Enums Index",
      description: "Sorted list of every enum in the latest Full-API-Dump.",
      mimeType: "application/json",
    },
    async (uri) => {
      const dump = await ctx.apiDump.load();
      return jsonResource(uri.href, {
        version: dump.Version,
        count: dump.Enums.length,
        enums: dump.Enums.map((e) => e.Name).sort(),
      });
    }
  );

  // Templated: API class
  server.registerResource(
    "roblox-api-class",
    new ResourceTemplate("roblox-api://class/{className}", {
      list: undefined,
      complete: {
        className: async (value) => {
          const dump = await ctx.apiDump.load();
          const q = value.toLowerCase();
          return dump.Classes.filter((c) => c.Name.toLowerCase().startsWith(q))
            .slice(0, 25)
            .map((c) => c.Name);
        },
      },
    }),
    {
      title: "Roblox API Class",
      description: "Full class definition (members, inheritance, tags, docs URL) as JSON.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const dump = await ctx.apiDump.load();
      const className = String(vars.className ?? "");
      const cls = dump.Classes.find((c) => c.Name.toLowerCase() === className.toLowerCase());
      if (!cls) {
        return jsonResource(uri.href, {
          error: `Class "${className}" not found.`,
        });
      }
      const chain = buildChain(cls, dump.Classes);
      return jsonResource(uri.href, {
        name: cls.Name,
        superclass: cls.Superclass,
        inheritanceChain: chain,
        tags: cls.Tags ?? [],
        description: cls.Description,
        docsUrl: `${URLS.creatorDocs}/docs/reference/engine/classes/${cls.Name}`,
        members: cls.Members ?? [],
      });
    }
  );

  // Templated: API enum
  server.registerResource(
    "roblox-api-enum",
    new ResourceTemplate("roblox-api://enum/{enumName}", {
      list: undefined,
      complete: {
        enumName: async (value) => {
          const dump = await ctx.apiDump.load();
          const q = value.toLowerCase();
          return dump.Enums.filter((e) => e.Name.toLowerCase().startsWith(q))
            .slice(0, 25)
            .map((e) => e.Name);
        },
      },
    }),
    {
      title: "Roblox API Enum",
      description: "Enum definition with item names and integer values.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const dump = await ctx.apiDump.load();
      const enumName = String(vars.enumName ?? "");
      const match = dump.Enums.find((e) => e.Name.toLowerCase() === enumName.toLowerCase());
      if (!match) {
        return jsonResource(uri.href, {
          error: `Enum "${enumName}" not found.`,
        });
      }
      return jsonResource(uri.href, {
        name: match.Name,
        items: match.Items,
      });
    }
  );

  // Templated: Luau stdlib
  server.registerResource(
    "roblox-luau-stdlib",
    new ResourceTemplate("roblox-luau://stdlib/{module}", {
      list: undefined,
      complete: {
        module: async (value) => {
          const q = value.toLowerCase();
          return LUAU_LIBRARY_NAMES.filter((m) => m.startsWith(q)).slice(0, 25);
        },
      },
    }),
    {
      title: "Luau Standard Library",
      description: "Reference docs for a Luau standard library module.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const moduleName = String(vars.module ?? "");
      const html = await ctx.http.getHtml(`${URLS.luauLang}/library`);
      const section = findLuauSection(html, moduleName);
      if (!section.found) {
        return textResource(
          uri.href,
          `Library "${moduleName}" not found. Available: ${section.available.join(", ")}.`,
          "text/plain"
        );
      }
      const text = stripHtml(section.text).slice(0, 8000);
      return textResource(uri.href, `# Luau ${moduleName}\n\n${text}`);
    }
  );

  // Templated: DevForum thread
  server.registerResource(
    "roblox-devforum-thread",
    new ResourceTemplate("roblox-devforum://thread/{topicId}", {
      list: undefined,
    }),
    {
      title: "DevForum Thread",
      description: "Full Discourse thread JSON for a given topic id.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const id = String(vars.topicId ?? "");
      const data = await ctx.http.getJson<DiscourseThreadResponse>(
        `${URLS.devforum}/t/${encodeURIComponent(id)}.json`
      );
      return jsonResource(uri.href, data);
    }
  );

  // Templated: DevForum category overview
  server.registerResource(
    "roblox-devforum-category",
    new ResourceTemplate("roblox-devforum://category/{slug}", {
      list: undefined,
    }),
    {
      title: "DevForum Category",
      description: "Topics list (latest) for a forum category by slug.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const slug = String(vars.slug ?? "");
      const data = await ctx.http.getJson(`${URLS.devforum}/c/${encodeURIComponent(slug)}.json`);
      return jsonResource(uri.href, data);
    }
  );

  // Templated: Creator Hub doc page
  server.registerResource(
    "roblox-docs-creator",
    new ResourceTemplate("roblox-docs://creator/{+path}", {
      list: undefined,
    }),
    {
      title: "Roblox Creator Hub Doc",
      description:
        "Creator Hub documentation page (path includes slashes, e.g. 'docs/reference/engine/classes/BasePart').",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const path = String(vars.path ?? "").replace(/^\/+/, "");
      const html = await ctx.http.getHtml(`${URLS.creatorDocs}/${path}`);
      const cleaned = stripHtml(html).slice(0, 8000);
      return textResource(uri.href, cleaned, "text/plain");
    }
  );
}
