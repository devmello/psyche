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
function retrying(
  opts: { pairsAfterOpen?: boolean; pairs?: () => boolean; blocked?: () => boolean } = {},
) {
  const calls: string[][] = [];
  let opened = false;
  let t = 0;
  const timers: Timer[] = [];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    // A clean bundle: `xattr -p` exits 1 (no attribute), and that is not an open.
    if (file === "/usr/bin/xattr") return { code: 1, stdout: "", stderr: "" };
    opened = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const launcher = new HelperLauncher({
    appPath,
    psycheHome: join(dir, "home"),
    platform: "darwin",
    run,
    isPaired: async () => opened && (opts.pairs ? opts.pairs() : (opts.pairsAfterOpen ?? true)),
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
    // Each launch probes the quarantine, then opens.
    expect(f.calls.map((c) => c[0])).toEqual([
      "/usr/bin/xattr",
      "/usr/bin/open",
      "/usr/bin/xattr",
      "/usr/bin/open",
    ]);
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

describe("HelperLauncher.kick (the Gateway came back, or the Mac woke)", () => {
  it("starts the back-off over and tries now instead of waiting for the long retry", async () => {
    let gatewayUp = false;
    // The helper died while the Gateway was away: it pairs only once opened again after that.
    let opensAtUp = Number.POSITIVE_INFINITY;
    const opens = () => f.calls.filter((c) => c[0] === "/usr/bin/open").length;
    const f = retrying({ pairs: () => gatewayUp && opens() > opensAtUp });
    // While the Gateway is away every launch "did not connect": the back-off grows.
    await f.launcher.launch();
    for (let i = 0; i < 3; i++) {
      f.pending()[0]?.fn();
      await tick();
      await f.launcher.launch();
    }
    expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0]?.ms).toBeGreaterThanOrEqual(240_000);
    const opensBefore = opens();

    opensAtUp = opensBefore;
    gatewayUp = true;
    await f.launcher.kick();
    expect(f.launcher.getState()).toEqual({ kind: "paired" });
    // It opened once more, at once, and the 4-minute retry is gone.
    expect(f.calls.filter((c) => c[0] === "/usr/bin/open").length).toBe(opensBefore + 1);
    expect(f.pending()).toEqual([]);

    // The next drop starts at the base delay again, not at 8 minutes.
    gatewayUp = false;
    await f.launcher.onPresence(false);
    expect(f.pending().map((x) => x.ms)).toEqual([30_000]);
  });

  it("does nothing while paired, and never retries a modified copy", async () => {
    const f = retrying();
    await f.launcher.launch();
    const opens = f.calls.length;
    await f.launcher.kick();
    expect(f.calls.length).toBe(opens);

    const blocked = retrying({ blocked: () => true });
    await blocked.launcher.launch();
    await blocked.launcher.kick();
    expect(blocked.calls).toEqual([]);
  });
});
