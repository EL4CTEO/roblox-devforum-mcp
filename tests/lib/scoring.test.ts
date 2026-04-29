import { describe, expect, it } from "vitest";
import { scoreTopic, sortByRelevance } from "../../src/lib/scoring.js";
import type { DiscourseTopic } from "../../src/types.js";

const base: DiscourseTopic = { id: 1, created_at: new Date().toISOString() };

describe("scoreTopic", () => {
  it("adds boost for accepted answer", () => {
    const a = scoreTopic({ ...base, has_accepted_answer: true });
    const b = scoreTopic(base);
    expect(a - b).toBeGreaterThanOrEqual(50);
  });

  it("weighs scripting-support category higher than help-and-feedback", () => {
    const scripting = scoreTopic({ ...base, category_id: 6 });
    const help = scoreTopic({ ...base, category_id: 35 });
    expect(scripting).toBeGreaterThan(help);
  });

  it("decays with age", () => {
    const fresh = scoreTopic({ ...base, created_at: new Date().toISOString() });
    const old = scoreTopic({
      ...base,
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(fresh).toBeGreaterThan(old);
  });
});

describe("sortByRelevance", () => {
  it("places solved threads first", () => {
    const list: DiscourseTopic[] = [
      { id: 1, created_at: base.created_at, views: 100 },
      { id: 2, created_at: base.created_at, has_accepted_answer: true, views: 1 },
    ];
    const sorted = sortByRelevance(list);
    expect(sorted[0]?.id).toBe(2);
  });
});
