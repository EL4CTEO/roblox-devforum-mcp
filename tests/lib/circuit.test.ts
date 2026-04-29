import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, hostOf } from "../../src/lib/circuit.js";

describe("CircuitBreaker", () => {
  it("opens after threshold failures within window", () => {
    const cb = new CircuitBreaker(3, 1000, 500);
    expect(cb.isOpen("h")).toBe(false);
    cb.recordFailure("h");
    cb.recordFailure("h");
    expect(cb.isOpen("h")).toBe(false);
    cb.recordFailure("h");
    expect(cb.isOpen("h")).toBe(true);
  });

  it("recovers after cooldown", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(2, 1000, 200);
    cb.recordFailure("h");
    cb.recordFailure("h");
    expect(cb.isOpen("h")).toBe(true);
    vi.advanceTimersByTime(250);
    expect(cb.isOpen("h")).toBe(false);
    vi.useRealTimers();
  });

  it("recordSuccess resets state", () => {
    const cb = new CircuitBreaker(2, 1000, 200);
    cb.recordFailure("h");
    cb.recordSuccess("h");
    cb.recordFailure("h");
    expect(cb.isOpen("h")).toBe(false);
  });
});

describe("hostOf", () => {
  it("returns host", () => {
    expect(hostOf("https://devforum.roblox.com/x")).toBe("devforum.roblox.com");
  });
  it("returns input on parse failure", () => {
    expect(hostOf("not-a-url")).toBe("not-a-url");
  });
});
