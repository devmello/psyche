import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBridgeDriver, FsQuarantineWriter, registerBrowserTools } from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import type { BrowserTeachStep } from "@psyche/protocol";
import { recordingTools } from "@psyche/skills";
import { FakeCredentialBroker, FakePermissionBroker, type GateTurn } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Int2Rig, prepareInt2, Registry } from "../injection/stack.ts";

/**
 * Teach by showing, replay (docs/design/teach-by-showing-2026.md §6). A skill made from a
 * recording is run by the agent loop with the normal browser tools, so every action goes to the
 * Permission Broker like any other tool call. This runs the calls such a skill makes through the
 * INT-2 gate (a transcription of the loop's own gate, over the real broker and the real `browser.*`
 * registrations) and checks the broker decided each one.
 */

const steps: BrowserTeachStep[] = [
  { id: "s1", kind: "navigate", url: "https://billing.example.com/reports" },
  { id: "s2", kind: "type", role: "textbox", name: "From", input: { name: "from_date" } },
  { id: "s3", kind: "click", role: "button", name: "Export" },
  { id: "s4", kind: "type", role: "textbox", name: "Password", sensitive: true },
];

let rig: Int2Rig;
let registry: Registry;
let dir: string;
let desktop: MockDesktop;
let driver: CdpBridgeDriver;

beforeAll(async () => {
  rig = await prepareInt2([]);
  dir = await mkdtemp(join(tmpdir(), "psyche-teach-int-"));
  desktop = new MockDesktop({ quarantineDir: dir });
  driver = new CdpBridgeDriver(await desktop.connect(), {
    library: new FsQuarantineWriter(join(dir, "lib")),
  });
  registry = new Registry();
  registerBrowserTools(registry, {
    driver,
    broker: FakePermissionBroker.policy({ default: "deny" }),
    credentials: new FakeCredentialBroker(),
    context: () => {
      throw new Error("not executed here");
    },
    session: async () => {
      throw new Error("not executed here");
    },
  });
});
afterAll(async () => {
  await rig.close();
  driver.dispose();
  desktop.disconnect();
  await rm(dir, { recursive: true, force: true });
});

describe("a skill made from a recording uses only real, brokered browser tools", () => {
  it("every tool it declares is registered, and none of them records or reads a recording", () => {
    const declared = recordingTools(steps);
    const registered = new Set(registry.list().map((s) => s.name));
    for (const tool of declared) expect(registered.has(tool)).toBe(true);
    for (const name of registered) expect(name).not.toMatch(/teach|record|demonstrat/i);
  });

  it("every call of a replay is decided by the broker", async () => {
    const stack = rig.int2Stack();
    const decide = vi.spyOn(stack.broker, "decide");
    const turn: GateTurn = {
      caseId: "teach-replay",
      mode: "balanced",
      threadId: "thr_1",
      runId: "run_1",
      taskId: "task_1",
      // The agent read page text this turn.
      taint: true,
      taintSources: ["web:https://billing.example.com"],
      unattended: false,
      newTarget: true,
    };
    const calls = [
      { tool: "browser.open_tab", args: { url: "https://billing.example.com/reports" } },
      {
        tool: "browser.check_target",
        args: { tabId: "tab_1", name: "Export", role: "button" },
      },
      { tool: "browser.type", args: { tabId: "tab_1", ref: "ref_2", text: "2026-11-01" } },
      { tool: "browser.click", args: { tabId: "tab_1", target: { ref: "ref_3" } } },
    ];
    const results = [];
    for (const c of calls) {
      results.push(
        await stack.gate.evaluate({ tool: c.tool, sideEffect: "write", args: c.args }, turn),
      );
    }
    // The broker saw every call, none ran on its own say-so.
    expect(decide).toHaveBeenCalledTimes(calls.length);
    expect(decide.mock.calls.map((c) => c[0].tool)).toEqual(calls.map((c) => c.tool));
    for (const r of results) expect(["executed", "asked", "blocked"]).toContain(r.decision);
    // A tainted turn does not get the writes for free: typing and clicking ask.
    expect(results[2]?.decision).not.toBe("executed");
    expect(results[3]?.decision).not.toBe("executed");
    // The check itself reads, and is never classed as a write.
    expect(registry.get("browser.check_target")?.spec.sideEffect).toBe("read");
  });

  it("a call nobody registered gets no free pass", async () => {
    const stack = rig.int2Stack();
    const turn: GateTurn = {
      caseId: "teach-replay-2",
      mode: "balanced",
      threadId: "thr_1",
      runId: "run_1",
      taskId: "task_1",
      taint: true,
      taintSources: [],
      unattended: false,
      newTarget: true,
    };
    const r = await stack.gate.evaluate(
      { tool: "browser.start_recording", sideEffect: "write", args: {} },
      turn,
    );
    expect(r.decision).not.toBe("executed");
    expect(registry.get("browser.start_recording")).toBeUndefined();
  });
});
