/** "What did Roblox ship recently?" — the weekly recap, release notes and announcements. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WEEKLY_RECAP_TAG,
  getTopic,
  listTopics,
  topicUrl,
  type RawTopic,
} from "../discourse.js";
import { htmlToMarkdown, relativeDate, truncate } from "../format.js";
import { ok, toToolError } from "./util.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

function withinDays(topic: RawTopic, days: number): boolean {
  const iso = topic.created_at ?? topic.bumped_at;
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && Date.now() - t <= days * 86_400_000;
}

function line(topic: RawTopic): string {
  return `- ${topic.title}\n  ${relativeDate(topic.created_at ?? topic.bumped_at)} · ${topicUrl(topic.id, topic.slug)}  (topic_id: ${topic.id})`;
}

/** The recap archive, newest first, paged until `needed` are collected or the tag runs out. */
async function recapArchive(needed: number): Promise<RawTopic[]> {
  const all: RawTopic[] = [];
  for (let page = 0; page < 6 && all.length < needed; page += 1) {
    const batch = await listTopics("latest", undefined, WEEKLY_RECAP_TAG, undefined, page);
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all.sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
}

export function registerUpdateTools(server: McpServer): void {
  server.registerTool(
    "get_weekly_recap",
    {
      title: "Read a Roblox Weekly Recap",
      description:
        "Read any Roblox Weekly Recap, current or historical. Roblox publishes one every Friday summarising what shipped that week: betas, engine updates, Marketplace and Studio changes. Use `week` to step back through the archive (0 = newest, 1 = the week before, …), `before` to jump to the recap covering a past date, or `list` to see the archive index. To find when a specific feature or regression landed, list the archive and read the recaps around that date.",
      inputSchema: {
        week: z
          .number()
          .int()
          .min(0)
          .max(120)
          .default(0)
          .describe("How many weeks back, 0 = most recent recap."),
        before: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Read the newest recap published on or before this date (YYYY-MM-DD). Overrides `week`."),
        list: z.boolean().default(false).describe("Return the archive index instead of a recap body."),
        limit: z.number().int().min(1).max(60).default(20).describe("Archive entries to list when `list` is true."),
        max_tokens: z.number().int().min(300).max(12000).default(4000),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const needed = args.list ? args.limit : args.before ? 90 : args.week + 1;
        const archive = await recapArchive(needed);
        if (archive.length === 0) return ok("No Weekly Recap posts found on the DevForum right now.");

        if (args.list) {
          const body = archive.slice(0, args.limit).map(line).join("\n");
          return ok(
            truncate(
              `${Math.min(archive.length, args.limit)} Weekly Recaps (newest first):\n\n${body}\n\nRead one with get_weekly_recap using its \`week\` index, or get_thread with its topic_id.`,
              args.max_tokens,
              "lower `limit`",
            ),
          );
        }

        let chosen: RawTopic | undefined;
        if (args.before) {
          const cutoff = Date.parse(`${args.before}T23:59:59Z`);
          chosen = archive.find((t) => Date.parse(t.created_at ?? "") <= cutoff);
          if (!chosen) {
            const oldest = archive[archive.length - 1];
            return ok(
              `No Weekly Recap published on or before ${args.before}. The archive goes back to ${(oldest?.created_at ?? "").slice(0, 10)} — try a later date.`,
            );
          }
        } else {
          chosen = archive[args.week];
          if (!chosen) {
            return ok(
              `Only ${archive.length} Weekly Recaps are available (week 0-${archive.length - 1}); week ${args.week} is further back than the archive goes.`,
            );
          }
        }

        const topic = await getTopic(chosen.id);
        const body = htmlToMarkdown(topic.post_stream?.posts?.[0]?.cooked ?? "", { keepQuotes: true });
        const head = `# ${chosen.title}\npublished ${(chosen.created_at ?? "").slice(0, 10)} (${relativeDate(chosen.created_at)}) · ${topicUrl(chosen.id, chosen.slug)}`;
        return ok(truncate(`${head}\n\n${body}`, args.max_tokens, "open the recap"));
      } catch (err) {
        return toToolError("get_weekly_recap failed", err);
      }
    },
  );

  server.registerTool(
    "get_whats_new",
    {
      title: "What Roblox shipped recently",
      description:
        "A digest of recent Roblox platform changes: the official Weekly Recap, engine Release Notes, and Announcements. Use this when a game regressed for no obvious reason (\"this worked last week\"), when checking whether a Roblox update explains new behaviour, or when the user asks what is new on the platform. Returns the latest Weekly Recap body plus everything else published inside the time window.",
      inputSchema: {
        days: z.number().int().min(1).max(120).default(14).describe("How far back to look, in days."),
        include_recap_body: z
          .boolean()
          .default(true)
          .describe("Include the text of the newest Weekly Recap, not just its link."),
        limit: z.number().int().min(1).max(30).default(8).describe("Maximum items per section."),
        max_tokens: z.number().int().min(300).max(12000).default(3500),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const [recaps, notes, announcements] = await Promise.all([
          listTopics("latest", undefined, WEEKLY_RECAP_TAG),
          listTopics("latest", "release-notes"),
          listTopics("latest", "announcements"),
        ]);

        const sections: string[] = [];

        const latestRecap = recaps[0];
        if (latestRecap) {
          let block = `## Weekly Recap\n${latestRecap.title}\n${relativeDate(latestRecap.created_at)} · ${topicUrl(latestRecap.id, latestRecap.slug)}`;
          if (args.include_recap_body) {
            const topic = await getTopic(latestRecap.id);
            const body = htmlToMarkdown(topic.post_stream?.posts?.[0]?.cooked ?? "", { keepQuotes: true });
            if (body) block += `\n\n${truncate(body, Math.floor(args.max_tokens * 0.55), "open the recap")}`;
          }
          const older = recaps.slice(1).filter((t) => withinDays(t, args.days));
          if (older.length) block += `\n\nEarlier recaps in range:\n${older.slice(0, args.limit).map(line).join("\n")}`;
          sections.push(block);
        }

        const recentNotes = notes.filter((t) => withinDays(t, args.days)).slice(0, args.limit);
        if (recentNotes.length) {
          sections.push(`## Release notes (last ${args.days} days)\n${recentNotes.map(line).join("\n")}`);
        }

        const recapIds = new Set(recaps.map((t) => t.id));
        const recentAnnouncements = announcements
          .filter((t) => withinDays(t, args.days) && !recapIds.has(t.id))
          .slice(0, args.limit);
        if (recentAnnouncements.length) {
          sections.push(`## Announcements (last ${args.days} days)\n${recentAnnouncements.map(line).join("\n")}`);
        }

        if (sections.length === 0) {
          return ok(`Roblox published nothing in the last ${args.days} days. Try a longer window.`);
        }

        const footer = "\n\nUse get_thread on any topic_id above to read the full post.";
        return ok(truncate(sections.join("\n\n"), args.max_tokens, "lower `days` or `limit`") + footer);
      } catch (err) {
        return toToolError("get_whats_new failed", err);
      }
    },
  );
}
