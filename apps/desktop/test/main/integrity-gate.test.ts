import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperLauncher, type HelperRunState } from "../../src/main/helper-launcher.ts";
import { createIntegrityGate, gateShortcuts } from "../../src/main/integrity-gate.ts";
import type { Runner } from "../../src/main/supervisor.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const dir = mkdtempSync(join(tmpdir(), "psy-gate-"));
const appPath = join(dir, "PsycheHelper.app");
mkdirSync(appPath);
const tick = () => new Promise((r) => setImmediate(r));

describe("integrity gate", () => {
  it("is blocked while pending, open after a clean check, blocked after a failed one", async () => {
    const d = deferred<boolean>();
    const gate = createIntegrityGate(() => d.promise);
    expect(gate.blocked()).toBe(true);
    expect(gate.isSettled()).toBe(false);
    d.resolve(false);
    await gate.settled;
    expect(gate.blocked()).toBe(false);

    const bad = createIntegrityGate(async () => true);
    await bad.settled;
    expect(bad.isSettled()).toBe(true);
    expect(bad.blocked()).toBe(true);
  });

  it("a check that throws is warned about and does not block (as before)", async () => {
    const warned: string[] = [];
    const gate = createIntegrityGate(
      async () => {
        throw new Error("codesign missing");
      },
      (m) => warned.push(m),
    );
    await gate.settled;
    expect(gate.blocked()).toBe(false);
    expect(warned[0]).toMatch(/codesign missing/);
  });

  it("holds shortcuts until the check settles, and drops them when it fails", async () => {
    for (const blocked of [false, true]) {
      const d = deferred<boolean>();
      const gate = createIntegrityGate(() => d.promise);
      const registered: string[] = [];
      const reg = gateShortcuts(
        {
          register: (a) => {
            registered.push(a);
            return true;
          },
          unregister: () => {},
        },
        gate,
      );
      expect(reg.register("Alt+D", () => {})).toBe(true);
      expect(registered).toEqual([]);
      d.resolve(blocked);
      await gate.settled;
      await tick();
      expect(registered).toEqual(blocked ? [] : ["Alt+D"]);
    }
  });
});

describe("helper launch waits for the integrity check", () => {
  function launcher(gate: ReturnType<typeof createIntegrityGate>) {
    const opened: string[] = [];
    const states: HelperRunState[] = [];
    let launched = false;
    const run: Runner = async (file) => {
      opened.push(file);
      launched = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const l = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run,
      isPaired: async () => launched,
      onState: (s) => states.push(s),
      blocked: () => gate.blocked(),
      settled: gate.settled,
      pairTimeoutMs: 100,
      sleep: async () => {},
    });
    return { l, opened, states };
  }

  it("does not start the helper while pending, then starts it after a clean check", async () => {
    const d = deferred<boolean>();
    const gate = createIntegrityGate(() => d.promise);
    const { l, opened, states } = launcher(gate);
    const p = l.launch();
    await tick();
    expect(opened).toEqual([]);
    // Pending is not "modified": no offline state is shown for it.
    expect(states.some((s) => /modified/.test((s as { reason?: string }).reason ?? ""))).toBe(
      false,
    );
    d.resolve(false);
    await p;
    expect(opened.length).toBeGreaterThan(0);
  });

  it("never starts the helper when the check fails", async () => {
    const d = deferred<boolean>();
    const gate = createIntegrityGate(() => d.promise);
    const { l, opened, states } = launcher(gate);
    const p = l.launch();
    d.resolve(true);
    await p;
    expect(opened).toEqual([]);
    expect(states.at(-1)).toMatchObject({ kind: "offline" });
  });
});
