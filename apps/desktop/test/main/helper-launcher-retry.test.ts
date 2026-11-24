import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperLauncher } from "../../src/main/helper-launcher.ts";
import type { Runner } from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-helper-retry-"));
const appPath = join(dir, "PsycheHelper.app");
mkdirSync(appPath);

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

/** A launcher whose timers are captured, so a test fires each retry by hand. */
function retrying(opts: { pairsAfterOpen?: boolean; blocked?: () => boolean } = {}) {
  const calls: string[][] = [];
  let opened = false;
  let t = 0;
  const timers: Timer[] = [];
  const run: Runner = async (file, args) => {
    if (file === "/usr/bin/xattr") return { code: 0, stdout: "", stderr: "" };
    calls.push([file, ...args]);
    opened = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const launcher = new HelperLauncher({
    appPath,
    psycheHome: join(dir, "home"),
    platform: "darwin",
    run,
    isPaired: async () => opened && (opts.pairsAfterOpen ?? true),
    pairTimeoutMs: 3_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...(opts.blocked === undefined ? {} : { blocked: opts.blocked }),
    setTimer: (fn, ms) => {
      // Firing a timer retires it, as the real one does.
      const timer: Timer = {
        fn: () => {
          timer.cleared = true;
          fn();
        },
        ms,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => {
      (h as Timer).cleared = true;
    },
  });
  const pending = () => timers.filter((x) => !x.cleared);
  return { calls, launcher, pending, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("HelperLauncher retries while offline", () => {
  it("schedules a retry when the helper does not pair, and backs off each time", async () => {
    const f = retrying({ pairsAfterOpen: false });
    await f.launcher.launch();
    expect(f.launcher.getState()).toEqual({
      kind: "offline",
      reason: "it did not connect to the Gateway",
    });
    expect(f.pending().map((x) => x.ms)).toEqual([30_000]);

    f.pending()[0]?.fn();
    await tick();
    expect(f.calls).toHaveLength(2);
    expect(f.pending().map((x) => x.ms)).toEqual([60_000]);
  });

  it("never waits longer than the cap", async () => {
    const f = retrying({ pairsAfterOpen: false });
    await f.launcher.launch();
    for (let i = 0; i < 8; i++) {
      f.pending()[0]?.fn();
      await tick();
    }
    expect(Math.max(...f.timers.map((x) => x.ms))).toBe(10 * 60_000);
  });

  it("drops the pending retry once the helper pairs", async () => {
    const f = retrying({ pairsAfterOpen: false });
    await f.launcher.launch();
    expect(f.pending()).toHaveLength(1);
    await f.launcher.onPresence(true);
    expect(f.launcher.getState()).toEqual({ kind: "paired" });
    expect(f.pending()).toHaveLength(0);
  });

  it("does not retry a modified app", async () => {
    const f = retrying({ blocked: () => true });
    await f.launcher.launch();
    expect(f.launcher.getState()).toEqual({
      kind: "offline",
      reason: "this copy of Psyche was modified",
    });
    expect(f.timers).toHaveLength(0);
  });
});
