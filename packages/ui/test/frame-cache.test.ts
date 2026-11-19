import { describe, expect, it } from "vitest";
import { FrameCache } from "../src/agent/timeline/frame-cache.ts";

const frame = (n: number) => "x".repeat(n);

describe("FrameCache", () => {
  it("evicts the least recently used entry past the byte budget", () => {
    const c = new FrameCache(100);
    c.set("r/1/full", frame(40));
    c.set("r/2/full", frame(40));
    c.get("r/1/full");
    c.set("r/3/full", frame(40));
    expect(c.get("r/2/full")).toBeUndefined();
    expect(c.get("r/1/full")).toBeDefined();
    expect(c.totalBytes).toBeLessThanOrEqual(100);
  });

  it("holds at most the budget after loading 100 frames", () => {
    const c = new FrameCache(1000);
    for (let i = 0; i < 100; i++) c.set(`r/${i}/full`, frame(100));
    expect(c.size).toBe(10);
    expect(c.totalBytes).toBe(1000);
  });

  it("keeps the newest entry even when it alone is over budget", () => {
    const c = new FrameCache(10);
    c.set("r/1/full", frame(50));
    expect(c.size).toBe(1);
  });

  it("tracks bytes when a key is replaced", () => {
    const c = new FrameCache(100);
    c.set("a/1/full", frame(30));
    c.set("a/1/full", frame(10));
    expect(c.totalBytes).toBe(10);
  });

  it("drops a run's frames when the last view releases it", () => {
    const c = new FrameCache(1000);
    c.retain("a");
    c.retain("a");
    c.set("a/1/full", frame(10));
    c.set("b/1/full", frame(10));
    c.release("a");
    expect(c.get("a/1/full")).toBeDefined();
    c.release("a");
    expect(c.get("a/1/full")).toBeUndefined();
    expect(c.get("b/1/full")).toBeDefined();
    expect(c.totalBytes).toBe(10);
  });
});
