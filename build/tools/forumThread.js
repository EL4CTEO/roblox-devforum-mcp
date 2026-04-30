import * as z from "zod";
import { URLS } from "../config.js";
import { fail, ok } from "../lib/responses.js";
import { formatDate, stripHtml, truncate } from "../lib/sanitize.js";
const inputShape = {
    thread_id: z.string().describe("Thread numeric id or slug."),
    include_replies: z.boolean().default(true).describe("Include replies on the requested page."),
    page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("1-indexed page (Discourse paginates large threads)."),
    max_post_length: z
        .number()
        .int()
        .min(100)
        .max(8000)
        .optional()
        .describe("Truncate each post body at this many chars."),
};
const PostSchema = z.object({
    id: z.number(),
    username: z.string(),
    createdAt: z.string(),
    body: z.string(),
    isAcceptedAnswer: z.boolean(),
});
const outputShape = {
    id: z.number(),
    title: z.string(),
    url: z.string(),
    author: z.string(),
    createdAt: z.string(),
    tags: z.array(z.string()),
    replies: z.number(),
    views: z.number(),
    isSolved: z.boolean(),
    page: z.number(),
    totalPosts: z.number(),
    posts: z.array(PostSchema),
    acceptedAnswer: PostSchema.optional(),
};
export function register(server, ctx) {
    server.registerTool("forum_thread", {
        title: "Get DevForum Thread",
        description: "Fetch a DevForum thread: metadata, original post, accepted answer, and (optionally) replies on the given page. Replaces 'get_thread' + 'get_post_replies'.",
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (raw) => {
        const input = raw;
        try {
            const url = `${URLS.devforum}/t/${encodeURIComponent(input.thread_id)}.json?page=${input.page}`;
            const data = await ctx.http.getJson(url);
            const stream = data.post_stream?.stream ?? [];
            const posts = data.post_stream?.posts ?? [];
            const first = posts[0];
            const accepted = posts.find((p) => p.accepted_answer === true);
            const truncatePost = (cooked) => {
                const text = stripHtml(cooked);
                return input.max_post_length ? truncate(text, input.max_post_length) : text;
            };
            const postObjs = (input.include_replies ? posts : first ? [first] : []).map((p) => ({
                id: p.id,
                username: p.username ?? "unknown",
                createdAt: p.created_at,
                body: truncatePost(p.cooked ?? ""),
                isAcceptedAnswer: p.accepted_answer === true,
            }));
            const threadUrl = `${URLS.devforum}/t/${data.slug}/${data.id}`;
            let text = `# ${data.title}\n`;
            text += `Author: ${first?.username ?? "unknown"} | Date: ${formatDate(data.created_at)}\n`;
            text += `Tags: ${(data.tags ?? []).join(", ") || "none"}\n`;
            text += `Replies: ${Math.max(0, (data.posts_count ?? 1) - 1)} | Views: ${data.views ?? 0}\n`;
            text += `Solved: ${data.has_accepted_answer ? "Yes" : "No"}\n`;
            text += `URL: ${threadUrl}\n\n`;
            if (first) {
                text += `--- First Post by ${first.username} (${formatDate(first.created_at)}) ---\n`;
                text += `${truncatePost(first.cooked ?? "")}\n`;
            }
            if (accepted && accepted.id !== first?.id) {
                text += `\n✅ ACCEPTED ANSWER by ${accepted.username} (${formatDate(accepted.created_at)})\n`;
                text += `${truncatePost(accepted.cooked ?? "")}\n`;
            }
            else if (data.has_accepted_answer && !accepted && stream.length > posts.length) {
                text += `\n✅ This thread has an accepted answer on a later page. Call again with a higher 'page'.\n`;
            }
            if (input.include_replies && posts.length > 1) {
                text += `\n--- Replies (page ${input.page}) ---\n\n`;
                for (const p of posts.slice(1)) {
                    text += `[${p.username} • ${formatDate(p.created_at)}]\n${truncatePost(p.cooked ?? "")}\n\n`;
                }
            }
            const acceptedSummary = accepted
                ? {
                    id: accepted.id,
                    username: accepted.username ?? "unknown",
                    createdAt: accepted.created_at,
                    body: truncatePost(accepted.cooked ?? ""),
                    isAcceptedAnswer: true,
                }
                : undefined;
            const structured = {
                id: data.id,
                title: data.title,
                url: threadUrl,
                author: first?.username ?? "unknown",
                createdAt: data.created_at,
                tags: data.tags ?? [],
                replies: Math.max(0, (data.posts_count ?? 1) - 1),
                views: data.views ?? 0,
                isSolved: Boolean(data.has_accepted_answer),
                page: input.page,
                totalPosts: stream.length || posts.length,
                posts: postObjs,
            };
            if (acceptedSummary)
                structured.acceptedAnswer = acceptedSummary;
            return ok(text.trim(), structured);
        }
        catch (e) {
            return fail(e);
        }
    });
}
//# sourceMappingURL=forumThread.js.map