import { describe, expect, it } from "vitest";
import {
  buildSearchUserMap,
  buildUserMap,
  formatTopics,
  toForumHit,
  topicLine,
} from "../../src/lib/discourse.js";
import type { DiscourseTopic } from "../../src/types.js";

const sample: DiscourseTopic = {
  id: 42,
  slug: "how-to-x",
  title: "How to X",
  created_at: "2024-05-01T00:00:00Z",
  posts_count: 5,
  views: 100,
  has_accepted_answer: true,
  category_id: 6,
  posters: [{ user_id: 7 }],
};

describe("topicLine", () => {
  it("includes title, url, replies, views", () => {
    const line = topicLine(sample, new Map([[7, "alice"]]));
    expect(line).toContain("How to X");
    expect(line).toContain("/t/how-to-x/42");
    expect(line).toContain("Replies: 4");
    expect(line).toContain("Views: 100");
    expect(line).toContain("alice");
  });
});

describe("buildUserMap", () => {
  it("maps user id to username", () => {
    const m = buildUserMap([{ id: 1, username: "u" }]);
    expect(m.get(1)).toBe("u");
  });
});

describe("buildSearchUserMap", () => {
  it("falls back to posts when users missing", () => {
    const m = buildSearchUserMap({
      posts: [{ id: 1, topic_id: 7, username: "p", created_at: "", cooked: "" }],
    });
    expect(m.get(7)).toBe("p");
  });
});

describe("toForumHit", () => {
  it("produces structured output with score", () => {
    const hit = toForumHit(sample, new Map([[7, "alice"]]));
    expect(hit.id).toBe(42);
    expect(hit.author).toBe("alice");
    expect(hit.isSolved).toBe(true);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.url).toContain("/t/how-to-x/42");
  });
});

describe("formatTopics", () => {
  it("limits and joins", () => {
    const out = formatTopics([sample, { ...sample, id: 43 }], [], 1);
    expect(out.split("\n\n").length).toBe(1);
  });
});
