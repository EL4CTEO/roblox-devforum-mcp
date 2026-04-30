import * as z from "zod";
export function registerAllPrompts(server) {
    server.registerPrompt("research-feature", {
        title: "Research a Roblox feature",
        description: "Pipeline: look up the relevant API class, find recent DevForum threads (latest + solved), and check open bug reports. Use this when an agent needs deep context on how a Roblox feature works in practice.",
        argsSchema: {
            feature: z
                .string()
                .describe("Class, member, or concept name (e.g. 'Workspace.StreamingEnabled', 'DataStore', 'Pathfinding')."),
        },
    }, ({ feature }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `I need a complete picture of "${feature}" in Roblox.`,
                        "",
                        "Please run, in this order, and synthesize a single answer:",
                        `1. roblox_api with kind="class" name="${feature}" (or kind="member" query="${feature}" if it's a member).`,
                        `2. forum_search with query="${feature}" status="solved" limit=8 — extract working patterns.`,
                        `3. forum_search with query="${feature}" tag="studio-bugs" limit=5 (and again with tag="engine-bugs") — flag known issues.`,
                        `4. roblox_docs with source="creator" query="${feature}" limit=5 — find official guides.`,
                        "",
                        "Then summarize: what it does, current best practices, known gotchas, and links.",
                    ].join("\n"),
                },
            },
        ],
    }));
    server.registerPrompt("explain-error", {
        title: "Diagnose a Roblox error",
        description: "Given an error message or symptom, search solved DevForum threads, related bugs, and the relevant API. Designed for an AI agent debugging a Roblox script.",
        argsSchema: {
            error_message: z.string().describe("The error string or short description of the symptom."),
            context: z
                .string()
                .optional()
                .describe("Optional surrounding context (script type, class involved)."),
        },
    }, ({ error_message, context }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Help me diagnose this Roblox error: "${error_message}".`,
                        context ? `Context: ${context}.` : "",
                        "",
                        "Search plan:",
                        `1. forum_search status="solved" query="${error_message}" limit=8.`,
                        `2. forum_search tag="engine-bugs" query="${error_message}" limit=5 and tag="studio-bugs" similarly.`,
                        `3. If a class is mentioned, roblox_api with kind="class" or kind="member".`,
                        "",
                        "Output: most likely cause, validated fix from a [SOLVED] thread (cite URL), and any related open bug.",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                },
            },
        ],
    }));
    server.registerPrompt("find-implementation-pattern", {
        title: "Find an implementation pattern",
        description: "Given a goal, gather Creator Docs guides, top community tutorials, and the relevant API surface so the agent can implement it correctly.",
        argsSchema: {
            goal: z
                .string()
                .describe("What the user wants to build (e.g. 'leaderstats with DataStore persistence', 'matchmaking for round-based game')."),
        },
    }, ({ goal }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Goal: ${goal}.`,
                        "",
                        "Discovery plan:",
                        `1. roblox_docs source="creator" query="${goal}" limit=5.`,
                        `2. roblox_docs source="community" query="${goal}" limit=5 — top tutorials.`,
                        `3. forum_search query="${goal}" sort="top" period="yearly" limit=8 — battle-tested patterns.`,
                        `4. roblox_api with kind="class" for any classes that surface repeatedly.`,
                        "",
                        "Output: an implementation outline with linked references and the API names you'd use.",
                    ].join("\n"),
                },
            },
        ],
    }));
    server.registerPrompt("audit-deprecated-api", {
        title: "Audit deprecated/changed API",
        description: "Check if a Roblox class or member is deprecated, has breaking changes, or has been called out in engine updates / announcements.",
        argsSchema: {
            target: z
                .string()
                .describe("Class or member name to audit (e.g. 'BodyVelocity', 'Workspace:FindPartOnRay')."),
        },
    }, ({ target }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Audit "${target}" for deprecation or breaking changes.`,
                        "",
                        "Steps:",
                        `1. roblox_api kind="member" query="${target}" — inspect Tags for 'Deprecated' or 'NotReplicated'.`,
                        `2. forum_search category="updates" query="${target}" limit=8 — engine announcements.`,
                        `3. forum_search status="solved" query="${target} deprecated" limit=5 — migration guides.`,
                        "",
                        "Output: deprecation status (Yes/No), recommended replacement (if any), and links.",
                    ].join("\n"),
                },
            },
        ],
    }));
}
//# sourceMappingURL=index.js.map