export function ok(text, structured) {
    const result = {
        content: [{ type: "text", text }],
    };
    if (structured)
        result.structuredContent = structured;
    return result;
}
export function fail(error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
    };
}
//# sourceMappingURL=responses.js.map