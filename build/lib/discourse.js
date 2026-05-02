import { URLS } from "../config.js";
import { formatDate, stripHtml } from "./sanitize.js";
import { scoreTopic } from "./scoring.js";
export function buildUserMap(users) {
    const map = new Map();
    if (users)
        for (const u of users)
            map.set(u.id, u.username);
    return map;
}
export function isStaffUser(u) {
    return Boolean(u.admin === true ||
        u.moderator === true ||
        (typeof u.trust_level === "number" && u.trust_level >= 4) ||
        (typeof u.primary_group_name === "string" && /staff|roblox/i.test(u.primary_group_name)));
}
export function staffUsernames(users) {
    const out = new Set();
    if (!users)
        return out;
    for (const u of users)
        if (isStaffUser(u))
            out.add(u.username);
    return out;
}
export function staffUserIds(users) {
    const out = new Set();
    if (!users)
        return out;
    for (const u of users)
        if (isStaffUser(u))
            out.add(u.id);
    return out;
}
export function buildSearchUserMap(data) {
    const map = buildUserMap(data.users);
    if (map.size === 0 && data.posts) {
        for (const p of data.posts) {
            if (p.topic_id !== undefined && p.username && !map.has(p.topic_id)) {
                map.set(p.topic_id, p.username);
            }
        }
    }
    return map;
}
export function topicAuthor(t, users) {
    if (t.last_poster_username)
        return t.last_poster_username;
    const first = t.posters?.[0];
    if (first?.user_id !== undefined) {
        const name = users.get(first.user_id);
        if (name)
            return name;
    }
    if (t.id !== undefined) {
        const fromTopic = users.get(t.id);
        if (fromTopic)
            return fromTopic;
    }
    return "unknown";
}
export function topicUrl(t) {
    return `${URLS.devforum}/t/${t.slug ?? t.id}/${t.id}`;
}
export function topicTitle(t) {
    return t.title ?? t.fancy_title ?? "Untitled";
}
export function topicReplyCount(t) {
    if (typeof t.posts_count === "number")
        return Math.max(0, t.posts_count - 1);
    return t.reply_count ?? 0;
}
export function topicLine(t, users = new Map()) {
    const date = formatDate(t.created_at);
    const title = topicTitle(t);
    const url = topicUrl(t);
    const views = t.views ?? 0;
    const replies = topicReplyCount(t);
    const author = topicAuthor(t, users);
    return `• ${title}\n  Author: ${author} | Date: ${date} | Replies: ${replies} | Views: ${views}\n  ${url}`;
}
export function formatTopics(topics, users, limit) {
    const userMap = buildUserMap(users);
    return topics
        .slice(0, limit)
        .map((t) => topicLine(t, userMap))
        .join("\n\n");
}
export function toForumHit(t, users) {
    const hit = {
        id: t.id,
        title: topicTitle(t),
        url: topicUrl(t),
        author: topicAuthor(t, users),
        tags: t.tags ?? [],
        replies: topicReplyCount(t),
        views: t.views ?? 0,
        likes: t.like_count ?? 0,
        createdAt: t.created_at ?? "",
        isSolved: Boolean(t.has_accepted_answer || t.solved),
        score: scoreTopic(t),
    };
    if (t.category_id !== undefined)
        hit.category_id = t.category_id;
    const last = t.last_posted_at ?? t.bumped_at;
    if (last !== undefined)
        hit.lastActivityAt = last;
    if (t.excerpt)
        hit.excerpt = stripHtml(t.excerpt);
    return hit;
}
//# sourceMappingURL=discourse.js.map