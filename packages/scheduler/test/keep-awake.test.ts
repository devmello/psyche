import { describe, expect, it } from "vitest";
import { KeepAwake, type PowerProcess } from "../src/index.ts";

/** A fake power API: records each caffeinate start and lets the test end it. */
function fakePower() {
  const started: { command: string; args: string[]; proc: FakeProc }[] = [];
  const spawn = (command: string, args: string[]): PowerProcess => {
    const proc = new FakeProc();
    started.push({ command, args, proc });
    return proc;
  };
  return { started, spawn };
}

class FakeProc implements PowerProcess {
  killed = 0;
  readonly #listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  kill(): boolean {
    this.killed += 1;
    this.end();
    return true;
  }
  on(event: string, listener: (...a: unknown[]) => void): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }
  /** The process ends on its own (a crash, or caffeinate's own exit). */
  exit(): void {
    for (const l of this.#listeners.get("exit") ?? []) l(0);
    this.end();
  }
  private end(): void {
    this.#listeners.clear();
  }
}

function harness(opts: { enabled?: boolean; runs?: number; platform?: NodeJS.Platform } = {}) {
  const power = fakePower();
  const state = { enabled: opts.enabled ?? true, runs: opts.runs ?? 0 };
  const errors: unknown[] = [];
  const keep = new KeepAwake({
    spawn: power.spawn,
    pid: 4242,
    platform: opts.platform ?? "darwin",
    enabled: () => state.enabled,
    activeRuns: () => state.runs,
    onError: (e) => errors.push(e),
  });
  return { keep, power, state, errors };
}

describe("keep-awake hold", () => {
  it("holds with caffeinate -i (no display hold) tied to the Gateway pid while a run is active", () => {
    const { keep, power, state } = harness();
    keep.sync();
    expect(keep.holding()).toBe(false);
    state.runs = 1;
    keep.sync();
    expect(keep.holding()).toBe(true);
    expect(power.started).toHaveLength(1);
    expect(power.started[0]?.command).toBe("/usr/bin/caffeinate");
    expect(power.started[0]?.args).toEqual(["-i", "-w", "4242"]);
    // Another sync with the same run does not start a second assertion.
    keep.sync();
    expect(power.started).toHaveLength(1);
  });

  it("releases when the last run ends", () => {
    const { keep, power, state } = harness({ runs: 2 });
    keep.sync();
    state.runs = 1;
    keep.sync();
    expect(keep.holding()).toBe(true);
    state.runs = 0;
    keep.sync();
    expect(keep.holding()).toBe(false);
    expect(power.started[0]?.proc.killed).toBe(1);
  });

  it("does nothing while the toggle is off, even with runs active", () => {
    const { keep, power, state } = harness({ enabled: false, runs: 3 });
    keep.sync();
    expect(keep.holding()).toBe(false);
    expect(power.started).toHaveLength(0);
    // Turning it off mid-run releases the hold.
    state.enabled = true;
    keep.sync();
    expect(keep.holding()).toBe(true);
    state.enabled = false;
    keep.sync();
    expect(keep.holding()).toBe(false);
  });

  it("never holds off macOS", () => {
    const { keep, power } = harness({ runs: 1, platform: "linux" });
    keep.sync();
    expect(keep.holding()).toBe(false);
    expect(power.started).toHaveLength(0);
  });

  it("releases on stop", () => {
    const { keep, power } = harness({ runs: 1 });
    keep.sync();
    keep.stop();
    expect(keep.holding()).toBe(false);
    expect(power.started[0]?.proc.killed).toBe(1);
  });

  it("drops the hold when caffeinate ends on its own, and asks again on the next sync", () => {
    const { keep, power } = harness({ runs: 1 });
    keep.sync();
    power.started[0]?.proc.exit();
    expect(keep.holding()).toBe(false);
    keep.sync();
    expect(keep.holding()).toBe(true);
    expect(power.started).toHaveLength(2);
  });

  it("reports a spawn failure and holds nothing", () => {
    const errors: unknown[] = [];
    const keep = new KeepAwake({
      spawn: () => {
        throw new Error("ENOENT caffeinate");
      },
      platform: "darwin",
      enabled: () => true,
      activeRuns: () => 1,
      onError: (e) => errors.push(e),
    });
    keep.sync();
    expect(keep.holding()).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("keep-awake acquire (Night shift's own hold)", () => {
  it("holds for the caller's run even with the setting off, with the same caffeinate -i, and releases once", () => {
    const { keep, power } = harness({ enabled: false });
    const release = keep.acquire();
    expect(keep.holding()).toBe(true);
    expect(power.started).toHaveLength(1);
    expect(power.started[0]?.args).toEqual(["-i", "-w", "4242"]);
    release();
    release();
    expect(keep.holding()).toBe(false);
    expect(power.started[0]?.proc.killed).toBe(1);
  });

  it("another run's release does not drop it, and its release does not drop the other's hold", () => {
    const { keep, state } = harness({ enabled: true, runs: 1 });
    keep.sync();
    const release = keep.acquire();
    state.runs = 0;
    keep.sync();
    expect(keep.holding()).toBe(true);
    release();
    expect(keep.holding()).toBe(false);
  });

  it("is a no-op off macOS (positive control: darwin holds above)", () => {
    const { keep } = harness({ platform: "linux" });
    keep.acquire();
    expect(keep.holding()).toBe(false);
  });
});
