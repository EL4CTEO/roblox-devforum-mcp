export function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
export function truncate(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return `${text.slice(0, maxLen - 3)}...`;
}
export function formatDate(input) {
    if (!input)
        return "unknown";
    const d = new Date(input);
    if (Number.isNaN(d.getTime()))
        return "unknown";
    const iso = d.toISOString();
    return iso.split("T")[0] ?? iso;
}
export function fmtTags(tags) {
    if (!tags || tags.length === 0)
        return "";
    const flat = tags.map((t) => {
        if (typeof t === "string")
            return t;
        if (typeof t === "object" && t !== null) {
            return Object.entries(t)
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join("; ");
        }
        return String(t);
    });
    return ` [${flat.join(", ")}]`;
}
//# sourceMappingURL=sanitize.js.map