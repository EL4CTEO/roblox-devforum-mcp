import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { URLS } from "../config.js";
import type { AppContext } from "../context.js";
import { fail, ok } from "../lib/responses.js";
import type { ApiClass, ApiClassSummary, ApiDump, ApiMember, ApiMemberSummary } from "../types.js";

const Kind = z.enum(["class", "member", "hierarchy", "enum", "enums", "classes"]);

const inputShape = {
  kind: Kind.describe(
    "What to look up: 'class' (full class doc), 'member' (search property/method/event by name), 'hierarchy' (inheritance tree), 'enum' (one enum), 'enums'/'classes' (list)."
  ),
  name: z
    .string()
    .optional()
    .describe(
      "Class or enum name (case-insensitive). Required for kind='class'/'hierarchy'/'enum'."
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Substring match. Required for kind='member', optional filter for 'enums'/'classes'."
    ),
  member_type: z
    .enum(["Property", "Function", "Event", "Callback"])
    .optional()
    .describe("Filter for kind='member'."),
  include_inherited: z
    .boolean()
    .default(false)
    .describe("For kind='class', include members from superclasses."),
  limit: z.number().int().min(1).max(200).default(25).describe("Max results."),
};

const Member = z.object({
  name: z.string(),
  kind: z.string(),
  type: z.string().optional(),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        default: z.string().optional(),
      })
    )
    .optional(),
  returnType: z.string().optional(),
  tags: z.array(z.string()),
  description: z.string().optional(),
});

const ClassOut = z.object({
  name: z.string(),
  superclass: z.string().optional(),
  inheritanceChain: z.array(z.string()),
  tags: z.array(z.string()),
  description: z.string().optional(),
  docsUrl: z.string(),
  members: z.object({
    properties: z.array(Member),
    methods: z.array(Member),
    events: z.array(Member),
    callbacks: z.array(Member),
  }),
});

const outputShape = {
  kind: z.string(),
  apiVersion: z.number().optional(),
  class: ClassOut.optional(),
  hierarchy: z
    .object({
      class: z.string(),
      chain: z.array(z.string()),
      directSubclasses: z.array(z.string()),
      totalDescendants: z.number(),
    })
    .optional(),
  members: z
    .array(
      z.object({
        className: z.string(),
        member: Member,
      })
    )
    .optional(),
  enum: z
    .object({
      name: z.string(),
      items: z.array(z.object({ name: z.string(), value: z.number() })),
    })
    .optional(),
  list: z.array(z.string()).optional(),
};

interface Input {
  kind: z.infer<typeof Kind>;
  name?: string;
  query?: string;
  member_type?: "Property" | "Function" | "Event" | "Callback";
  include_inherited: boolean;
  limit: number;
}

function memberToSummary(m: ApiMember): ApiMemberSummary {
  const tags = (m.Tags ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t)));
  const summary: ApiMemberSummary = {
    name: m.Name,
    kind: m.MemberType,
    tags,
  };
  if (m.ValueType?.Name) summary.type = m.ValueType.Name;
  if (m.Parameters && m.Parameters.length > 0) {
    summary.parameters = m.Parameters.map((p) => {
      const param: { name: string; type: string; default?: string } = {
        name: p.Name,
        type: p.Type.Name,
      };
      if (p.Default !== undefined) param.default = p.Default;
      return param;
    });
  }
  if (m.ReturnType?.Name) summary.returnType = m.ReturnType.Name;
  if (m.Description) summary.description = m.Description;
  return summary;
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

function findClass(name: string, classes: ApiClass[]): ApiClass | undefined {
  return classes.find((c) => c.Name.toLowerCase() === name.toLowerCase());
}

function classToSummary(
  cls: ApiClass,
  classes: ApiClass[],
  includeInherited: boolean
): ApiClassSummary {
  const chain = buildChain(cls, classes);
  const all: ApiMember[] = [];
  if (includeInherited) {
    let walk: ApiClass | undefined = cls;
    while (walk) {
      for (const m of walk.Members ?? []) {
        if (!all.some((x) => x.Name === m.Name)) all.push(m);
      }
      if (!walk.Superclass || walk.Superclass === "<<<ROOT>>>") break;
      walk = classes.find((c) => c.Name === walk?.Superclass);
    }
  } else {
    all.push(...(cls.Members ?? []));
  }
  const summary: ApiClassSummary = {
    name: cls.Name,
    inheritanceChain: chain,
    tags: (cls.Tags ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t))),
    docsUrl: `${URLS.creatorDocs}/docs/reference/engine/classes/${cls.Name}`,
    members: {
      properties: all.filter((m) => m.MemberType === "Property").map(memberToSummary),
      methods: all.filter((m) => m.MemberType === "Function").map(memberToSummary),
      events: all.filter((m) => m.MemberType === "Event").map(memberToSummary),
      callbacks: all.filter((m) => m.MemberType === "Callback").map(memberToSummary),
    },
  };
  if (cls.Superclass) summary.superclass = cls.Superclass;
  if (cls.Description) summary.description = cls.Description;
  return summary;
}

function renderClass(c: ApiClassSummary, includeInherited: boolean): string {
  let out = `# ${c.name}\n`;
  out += `Inherits: ${c.inheritanceChain.join(" > ")}\n`;
  if (c.tags.length > 0) out += `Tags: ${c.tags.join(", ")}\n`;
  if (c.description) out += `Description: ${c.description}\n`;
  out += `Docs: ${c.docsUrl}\n\n`;

  const renderList = (label: string, list: ApiMemberSummary[]) => {
    if (list.length === 0) return "";
    let s = `## ${label} (${list.length})\n`;
    for (const m of list) {
      const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
      const desc = m.description ? ` — ${m.description}` : "";
      if (m.parameters) {
        const params = m.parameters
          .map((p) => `${p.name}: ${p.type}${p.default ? ` = ${p.default}` : ""}`)
          .join(", ");
        const ret = m.returnType ?? "void";
        s += `- **${m.name}**(${params}): ${ret}${tags}${desc}\n`;
      } else if (m.type) {
        s += `- **${m.name}**: ${m.type}${tags}${desc}\n`;
      } else {
        s += `- **${m.name}**${tags}${desc}\n`;
      }
    }
    return `${s}\n`;
  };

  out += renderList("Properties", c.members.properties);
  out += renderList("Methods", c.members.methods);
  out += renderList("Events", c.members.events);
  out += renderList("Callbacks", c.members.callbacks);

  if (includeInherited) {
    out += `\n_Includes inherited members from ${c.inheritanceChain.slice(1).join(", ")}._\n`;
  } else if (c.inheritanceChain.length > 1) {
    out += `\n_Use include_inherited=true to see members from ${c.inheritanceChain.slice(1).join(", ")}._\n`;
  }
  return out;
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "roblox_api",
    {
      title: "Roblox Engine API",
      description:
        "Inspect the Roblox engine API (classes, members, enums, hierarchy) from Full-API-Dump.json. Replaces 'get_api_docs' + 'search_api_member' + 'get_class_hierarchy' + 'get_enum'.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (raw): Promise<ReturnType<typeof ok>> => {
      const input = raw as Input;
      try {
        const dump: ApiDump = await ctx.apiDump.load();

        if (input.kind === "class") {
          if (!input.name) return fail(new Error("name is required for kind='class'"));
          const cls = findClass(input.name, dump.Classes);
          if (!cls) {
            const partials = dump.Classes.filter((c) =>
              c.Name.toLowerCase().includes((input.name ?? "").toLowerCase())
            )
              .slice(0, 10)
              .map((c) => c.Name);
            const hint = partials.length > 0 ? ` Did you mean: ${partials.join(", ")}?` : "";
            return ok(`Class "${input.name}" not found.${hint}`, {
              kind: "class",
              apiVersion: dump.Version,
              list: partials,
            });
          }
          const summary = classToSummary(cls, dump.Classes, input.include_inherited);
          return ok(renderClass(summary, input.include_inherited), {
            kind: "class",
            apiVersion: dump.Version,
            class: summary,
          });
        }

        if (input.kind === "member") {
          if (!input.query) return fail(new Error("query is required for kind='member'"));
          const q = input.query.toLowerCase();
          const found: { className: string; member: ApiMemberSummary }[] = [];
          for (const cls of dump.Classes) {
            for (const m of cls.Members ?? []) {
              if (!m.Name.toLowerCase().includes(q)) continue;
              if (input.member_type && m.MemberType !== input.member_type) continue;
              found.push({ className: cls.Name, member: memberToSummary(m) });
              if (found.length >= input.limit) break;
            }
            if (found.length >= input.limit) break;
          }
          const text = found.length
            ? `Members matching "${input.query}":\n\n${found
                .map(
                  (r) =>
                    `• ${r.member.name} (${r.member.kind}) in ${r.className}${r.member.description ? ` — ${r.member.description}` : ""}`
                )
                .join("\n")}`
            : `No API member matching "${input.query}".`;
          return ok(text, {
            kind: "member",
            apiVersion: dump.Version,
            members: found,
          });
        }

        if (input.kind === "hierarchy") {
          if (!input.name) return fail(new Error("name is required for kind='hierarchy'"));
          const cls = findClass(input.name, dump.Classes);
          if (!cls) return ok(`Class "${input.name}" not found.`, { kind: "hierarchy" });
          const chain = buildChain(cls, dump.Classes);
          const directSubclasses = dump.Classes.filter(
            (c) => c.Superclass?.toLowerCase() === cls.Name.toLowerCase()
          )
            .map((c) => c.Name)
            .sort();
          const lower = chain.map((n) => n.toLowerCase());
          const totalDescendants = dump.Classes.filter(
            (c) => c.Superclass && lower.includes(c.Superclass.toLowerCase())
          ).length;
          const text = [
            `# ${cls.Name} Hierarchy`,
            `Chain: ${chain.join(" > ")}`,
            `Direct subclasses: ${directSubclasses.length ? directSubclasses.join(", ") : "none"}`,
            `Total inheriting classes: ${totalDescendants}`,
          ].join("\n");
          return ok(text, {
            kind: "hierarchy",
            apiVersion: dump.Version,
            hierarchy: {
              class: cls.Name,
              chain,
              directSubclasses,
              totalDescendants,
            },
          });
        }

        if (input.kind === "enum") {
          if (!input.name) return fail(new Error("name is required for kind='enum'"));
          const enumName = input.name;
          const match = dump.Enums.find((e) => e.Name.toLowerCase() === enumName.toLowerCase());
          if (!match) {
            const similar = dump.Enums.filter((e) =>
              e.Name.toLowerCase().includes(enumName.toLowerCase())
            )
              .slice(0, 5)
              .map((e) => e.Name);
            const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
            return ok(`Enum "${enumName}" not found.${hint}`, {
              kind: "enum",
              apiVersion: dump.Version,
              list: similar,
            });
          }
          const items = match.Items.map((i) => ({ name: i.Name, value: i.Value }));
          let text = `# Enum ${match.Name}\nItems: ${items.length}\n\n`;
          for (const it of items) text += `- **${it.name}** = ${it.value}\n`;
          return ok(text, {
            kind: "enum",
            apiVersion: dump.Version,
            enum: { name: match.Name, items },
          });
        }

        if (input.kind === "enums") {
          let names = dump.Enums.map((e) => e.Name).sort();
          if (input.query) {
            const q = input.query.toLowerCase();
            names = names.filter((n) => n.toLowerCase().includes(q));
          }
          const limited = names.slice(0, input.limit);
          return ok(
            `Roblox API Enums (${names.length} total${input.query ? ", filtered" : ""}):\n\n${limited.join(", ")}`,
            { kind: "enums", apiVersion: dump.Version, list: limited }
          );
        }

        // classes
        let names = dump.Classes.map((c) => c.Name).sort();
        if (input.query) {
          const q = input.query.toLowerCase();
          names = names.filter((n) => n.toLowerCase().includes(q));
        }
        const limited = names.slice(0, input.limit);
        return ok(
          `Roblox API Classes (${names.length} total${input.query ? ", filtered" : ""}):\n\n${limited.join(", ")}`,
          { kind: "classes", apiVersion: dump.Version, list: limited }
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
