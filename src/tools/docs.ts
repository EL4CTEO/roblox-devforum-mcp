/** Official documentation tools: creator-docs search and engine API lookup. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  classChain,
  docUrl,
  fetchDoc,
  findClass,
  findEnum,
  findDatatype,
  searchDocs,
  securityOf,
  signature,
  suggestClasses,
  suggestMembers,
  resolveMember,
  deprecationNote,
  type ApiMember,
} from "../docs.js";
import { truncate } from "../format.js";
import { ok, fail, toToolError } from "./util.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

export function registerDocsTools(server: McpServer): void {
  server.registerTool(
    "search_creator_docs",
    {
      title: "Search official Roblox documentation",
      description:
        "Find and read pages from Roblox's official creator documentation (create.roblox.com/docs). Call with `query` to list matching pages, then call again with `path` from a result to read that page in full. Use this for intended behaviour, limits and quotas, and guide-level explanations — pair it with search_devforum for what actually happens in production.",
      inputSchema: {
        query: z.string().optional().describe("What to look for, e.g. \"data store limits\" or \"ProximityPrompt\"."),
        path: z.string().optional().describe("Repo path from a previous result, e.g. content/en-us/cloud-services/data-stores/index.md. Returns the full page."),
        limit: z.number().int().min(1).max(25).default(10),
        max_tokens: z.number().int().min(300).max(12000).default(3000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!args.query && !args.path) return fail("Provide either `query` to search or `path` to read a page.");
      try {
        if (args.path) {
          const text = await fetchDoc(args.path);
          return ok(
            `${docUrl(args.path.startsWith("content/en-us/") ? args.path : `content/en-us/${args.path}`)}\n\n${truncate(text, args.max_tokens, "read the page online")}`,
          );
        }
        const hits = await searchDocs(args.query as string, args.limit);
        if (hits.length === 0) {
          return ok(`No documentation page matched "${args.query}". Try an exact class name (DataStoreService) or a shorter phrase.`);
        }
        const body = hits
          .map((h, i) => {
            const snippet = h.snippet ? `\n   ${h.snippet}` : "";
            return `${i + 1}. ${h.title} (${h.kind})\n   ${h.url}\n   path: ${h.path}${snippet}`;
          })
          .join("\n\n");
        const footer = "Call search_creator_docs again with `path` to read a page in full.";
        return ok(
          truncate(`${hits.length} documentation pages for "${args.query}":\n\n${body}\n\n${footer}`, args.max_tokens, "lower limit"),
        );
      } catch (err) {
        return toToolError("search_creator_docs failed", err);
      }
    },
  );

  server.registerTool(
    "check_api_health",
    {
      title: "Check Roblox APIs for deprecation",
      description:
        "Batch-check Roblox APIs before you ship Luau that uses them. Pass entries like \"Humanoid.MoveTo\", \"BodyVelocity\" or \"DataStoreService.GetDataStore\" and each is verified against the live API dump: does it still exist, is it deprecated (with the official replacement where the docs give one), is it locked behind a security level normal scripts cannot use, and does it yield. Use this whenever you are about to write or review Roblox code — models often reproduce APIs that Roblox retired years ago.",
      inputSchema: {
        members: z
          .array(z.string().min(2))
          .min(1)
          .max(25)
          .describe("Entries to check: \"ClassName\" or \"ClassName.MemberName\", e.g. [\"BodyVelocity\", \"Humanoid.MoveTo\"]."),
        max_tokens: z.number().int().min(300).max(12000).default(2500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const lines = await Promise.all(
          args.members.map(async (entry) => {
            const raw = entry.trim().replace(/^game[.:]/i, "").replace(/[():].*$/, "");

            // "Enum.RaycastFilterType" and "Enum.Material.Neon" name an enum, not a class.
            const enumMatch = /^Enum\.([A-Za-z0-9_]+)/.exec(raw);
            if (enumMatch?.[1]) {
              const enumType = await findEnum(enumMatch[1]);
              return enumType
                ? `OK        ${entry} — Enum.${enumType.Name} exists (${enumType.Items?.length ?? 0} items).`
                : `NOT FOUND ${entry} — no Enum named "${enumMatch[1]}".`;
            }

            const dot = raw.lastIndexOf(".");
            const className = dot > 0 ? raw.slice(0, dot) : raw;
            const memberName = dot > 0 ? raw.slice(dot + 1) : undefined;

            const cls = await findClass(className);
            if (!cls) {
              const enumType = await findEnum(className);
              if (enumType) return `OK        ${entry} — Enum.${enumType.Name} exists.`;
              // Datatypes such as Vector3 or CFrame live in the docs, not the class dump.
              const datatype = await findDatatype(className);
              if (datatype) {
                return `OK        ${entry} — ${datatype} is a datatype; see https://create.roblox.com/docs/reference/engine/datatypes/${datatype}`;
              }
              const near = await suggestClasses(className);
              return `NOT FOUND ${entry} — no class "${className}" in the current API.${near.length ? ` Closest: ${near.join(", ")}.` : ""}`;
            }

            const notes: string[] = [];
            let state = "OK       ";

            if (!memberName) {
              if (cls.Tags?.includes("Deprecated")) {
                state = "DEPRECATED";
                const note = await deprecationNote(cls.Name);
                if (note) notes.push(note);
              }
              if (cls.Tags?.includes("NotCreatable")) notes.push("not creatable with Instance.new");
              if (cls.Tags?.includes("Service")) notes.push("get it via game:GetService");
              return `${state} ${entry} — class ${cls.Name}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
            }

            const found = await resolveMember(cls.Name, memberName);
            if (!found) {
              const near = await suggestMembers(cls.Name, memberName);
              return `NOT FOUND ${entry} — ${cls.Name} has no member "${memberName}"; it may have been removed.${near.length ? ` Closest: ${near.join(", ")}.` : ""}`;
            }

            const { owner, member } = found;
            if (member.Tags?.includes("Deprecated")) {
              state = "DEPRECATED";
              const note = await deprecationNote(owner.Name, member.Name);
              if (note) notes.push(note);
            }
            const security = securityOf(member);
            if (security) {
              state = state === "DEPRECATED" ? state : "RESTRICTED";
              notes.push(`security: ${security} — normal game scripts cannot use this`);
            }
            if (member.Tags?.includes("NotScriptable")) notes.push("not scriptable");
            if (member.Tags?.includes("Yields")) notes.push("yields, call from a coroutine or with care");
            if (member.Tags?.includes("ReadOnly")) notes.push("read-only");
            if (owner.Name !== cls.Name) notes.push(`inherited from ${owner.Name}`);

            return `${state} ${entry} — ${signature(member)}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
          }),
        );

        const flagged = lines.filter((l) => !l.startsWith("OK")).length;
        const header = flagged === 0
          ? `All ${lines.length} APIs are current and usable from game scripts.`
          : `${flagged} of ${lines.length} APIs need attention:`;
        return ok(truncate(`${header}\n\n${lines.join("\n")}`, args.max_tokens, "check fewer at a time"));
      } catch (err) {
        return toToolError("check_api_health failed", err);
      }
    },
  );

  server.registerTool(
    "get_engine_api",
    {
      title: "Look up the Roblox engine API",
      description:
        "Authoritative signature lookup from the live Roblox API dump: a class's properties, methods, events and callbacks with parameter types, security level, deprecation and thread safety. Use this to confirm a method exists, check whether it is deprecated or server-only, or find the right member name before writing Luau.",
      inputSchema: {
        name: z.string().min(2).describe("Class name (e.g. DataStoreService, Humanoid) or Enum name (e.g. RaycastFilterType)."),
        filter: z.string().optional().describe("Only members whose name contains this substring."),
        member_types: z
          .array(z.enum(["Property", "Function", "Event", "Callback"]))
          .optional()
          .describe("Restrict to these member kinds."),
        include_inherited: z.boolean().default(false).describe("Include members inherited from superclasses."),
        max_tokens: z.number().int().min(300).max(12000).default(3000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const cls = await findClass(args.name);
        if (!cls) {
          const enumType = await findEnum(args.name);
          if (enumType) {
            const items = (enumType.Items ?? []).map((i) => `${i.Name} = ${i.Value}`).join(", ");
            return ok(`Enum.${enumType.Name}\n${items || "(no items)"}`);
          }
          const suggestions = await suggestClasses(args.name);
          return fail(
            `No engine class or enum named "${args.name}".${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
          );
        }

        const chain = args.include_inherited ? await classChain(cls.Name) : [cls];
        const wanted = args.member_types ? new Set(args.member_types) : undefined;
        const filter = args.filter?.toLowerCase();

        const sections: string[] = [];
        for (const entry of chain) {
          const members = (entry.Members ?? []).filter((m) => {
            if (wanted && !wanted.has(m.MemberType as never)) return false;
            if (filter && !m.Name.toLowerCase().includes(filter)) return false;
            return true;
          });
          if (members.length === 0) continue;

          const grouped = new Map<string, ApiMember[]>();
          for (const m of members) {
            const list = grouped.get(m.MemberType) ?? [];
            list.push(m);
            grouped.set(m.MemberType, list);
          }

          const lines: string[] = [];
          for (const [type, list] of [...grouped].sort()) {
            lines.push(`${type}s:`);
            for (const m of list.sort((a, b) => a.Name.localeCompare(b.Name))) {
              const notes: string[] = [];
              const security = securityOf(m);
              if (security) notes.push(`security: ${security}`);
              if (m.Tags?.includes("Deprecated")) notes.push("DEPRECATED");
              if (m.Tags?.includes("ReadOnly")) notes.push("read-only");
              if (m.Tags?.includes("Yields")) notes.push("yields");
              if (m.Tags?.includes("NotReplicated")) notes.push("not replicated");
              if (m.ThreadSafety && m.ThreadSafety !== "ReadSafe") notes.push(`thread: ${m.ThreadSafety}`);
              lines.push(`  ${signature(m)}${notes.length ? `  [${notes.join(", ")}]` : ""}`);
            }
          }
          const heading = entry === cls ? `# ${entry.Name}` : `# inherited from ${entry.Name}`;
          sections.push(`${heading}\n${lines.join("\n")}`);
        }

        if (sections.length === 0) {
          return ok(`${cls.Name} has no members matching those filters. Superclass: ${cls.Superclass ?? "none"}.`);
        }

        const head = [
          `${cls.Name} (inherits ${cls.Superclass ?? "none"})`,
          cls.Tags?.length ? `class tags: ${cls.Tags.join(", ")}` : undefined,
          `docs: https://create.roblox.com/docs/reference/engine/classes/${cls.Name}`,
        ]
          .filter(Boolean)
          .join("\n");

        return ok(truncate(`${head}\n\n${sections.join("\n\n")}`, args.max_tokens, "use `filter` to narrow"));
      } catch (err) {
        return toToolError("get_engine_api failed", err);
      }
    },
  );
}
