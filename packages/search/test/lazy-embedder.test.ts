import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEmbedder, lazyEmbedder } from "../src/index.ts";

/** The model loads on first use and is freed when idle, so idle RAM stays where it was. */

afterEach(() => {
  vi.useRealTimers();
});

describe("lazyEmbedder", () => {
  it("loads on the first embed, frees after the idle time, loads again when needed", async () => {
    vi.useFakeTimers();
    let loads = 0;
    let releases = 0;
    const lazy = lazyEmbedder({
      model: "fake/concepts-64",
      idleMs: 1_000,
      load: async () => {
        loads++;
        return { ...fakeEmbedder(), release: async () => void releases++ };
      },
    });
    expect(lazy.loaded()).toBe(false);
    expect(loads).toBe(0);
    await lazy.embed(["hello world"], "document");
    await lazy.embed(["again"], "query");
    expect(loads).toBe(1);
    expect(lazy.loaded()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(lazy.loaded()).toBe(false);
    expect(releases).toBe(1);
    await lazy.embed(["back"], "query");
    expect(loads).toBe(2);
  });

  it("does not cache a failed load", async () => {
    let fail = true;
    const lazy = lazyEmbedder({
      model: "fake/concepts-64",
      load: async () => {
        if (fail) throw new Error("no model");
        return fakeEmbedder();
      },
    });
    await expect(lazy.embed(["x"], "query")).rejects.toThrow("no model");
    fail = false;
    expect(await lazy.embed(["hello"], "query")).toHaveLength(1);
    await lazy.release();
  });
});
