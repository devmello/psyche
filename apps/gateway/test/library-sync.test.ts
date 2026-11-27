import { describe, expect, it, vi } from "vitest";
import { createLibrarySync, LIBRARY_FULL_RECONCILE_MS } from "../src/compose/library-sync.ts";

function harness(overrides: { reconcile?: () => Promise<boolean> } = {}) {
  let mark = "3|2026-11-01";
  let clock = 0;
  const reconcile = vi.fn(overrides.reconcile ?? (async () => false));
  const sync = createLibrarySync({
    watermark: () => mark,
    reconcile,
    now: () => clock,
  });
  return {
    sync,
    reconcile,
    setMark: (m: string) => {
      mark = m;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("library reconcile", () => {
  it("never overlaps: a second run while a pass is in flight does nothing", async () => {
    let release: (v: boolean) => void = () => undefined;
    let calls = 0;
    const h = harness({
      reconcile: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = h.sync.run();
    const second = h.sync.run();
    await second;
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    release(false);
    await first;
    // The in-flight guard is released: a later change is indexed again.
    h.sync.changed();
    const reconcileDone = h.sync.run();
    await reconcileDone;
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("skips the diff when the watermark is unchanged and no library event arrived", async () => {
    const h = harness();
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await h.sync.run();
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("a changed watermark runs a pass", async () => {
    const h = harness();
    await h.sync.run();
    h.setMark("4|2026-11-02");
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("a library event runs a pass even when the watermark is unchanged", async () => {
    const h = harness();
    await h.sync.run();
    h.sync.changed();
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("a full reconcile still runs at most once an hour when nothing changed", async () => {
    const h = harness();
    await h.sync.run();
    h.advance(LIBRARY_FULL_RECONCILE_MS - 1);
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("images left past the OCR budget keep the next pass due", async () => {
    let more = true;
    const h = harness({ reconcile: async () => more });
    await h.sync.run();
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    more = false;
    await h.sync.run();
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(3);
  });

  it("a failed pass is retried on the next run, never recorded as clean", async () => {
    let fail = true;
    const h = harness({
      reconcile: async () => {
        if (fail) throw new Error("disk full");
        return false;
      },
    });
    await expect(h.sync.run()).rejects.toThrow("disk full");
    fail = false;
    await h.sync.run();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });
});
