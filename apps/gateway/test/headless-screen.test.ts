import type { CallContext } from "@psyche/browser";
import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ComputerDeps,
  type ComputerUse,
  createComputerUse,
  type SurfaceRouter,
} from "../src/compose/computer.ts";
import { gateHeadlessRouter, type HeadlessScreen } from "../src/compose/headless-screen.ts";
import { type ComposedVirtualScreen, composeVirtualScreen } from "../src/compose/virtual-screen.ts";

/**
 * B3 on B0's headless Host router: the agent's computer use on the Host's private screen keeps
 * the take-over gate and the Task-end handling that `virtual-screen.ts` gives every other use of
 * that screen (linux-helper-only design §7.4).
 */

const STATUS = {
  state: "running",
  display: ":90",
  width: 1280,
  height: 800,
  apps: [] as Record<string, unknown>[],
  takenOver: false,
  frameSeq: 1,
  startedAt: "2026-11-20T10:00:00.000Z",
};

/** The headless Host helper: computer.* for the agent, vscreen.* for the watch pane. */
class FakeHeadlessHelper implements NodeClient {
  readonly nodeId = "node-headless";
  readonly calls: { capability: string; params: Record<string, unknown> }[] = [];
  /** Apps left on the screen; one with unsaved changes refuses a polite close. */
  apps: Record<string, unknown>[] = [];

  async info(): Promise<NodeInfo> {
    throw new Error("unused");
  }
  async capabilities(): Promise<NodeCapability[]> {
    return [];
  }
  async invoke(capability: string, params: unknown): Promise<NodeInvokeResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({ capability, params: p });
    switch (capability) {
      case "vscreen.stop": {
        const unsaved = this.apps.some((a) => a.hasUnsavedChanges === true);
        const ok = p.force === true || !unsaved;
        if (ok) this.apps = [];
        return { ok: true, result: { ok } };
      }
      case "vscreen.status":
        return { ok: true, result: { ...STATUS, apps: this.apps } };
      case "vscreen.input":
        return { ok: true, result: { ok: true } };
      case "computer.ax_tree":
        return {
          ok: true,
          result: { text: `window "Editor"\n  [e1] textarea "Body"`, tier: "interact" },
        };
      default:
        return { ok: true, result: { status: "ok", app: p.app ?? p.bundleId } };
    }
  }
  used(capability: string) {
    return this.calls.filter((c) => c.capability === capability);
  }
}

const editor = "org.gnome.TextEditor";

let helper: FakeHeadlessHelper;
let broker: FakePermissionBroker;
let vs: ComposedVirtualScreen;
let published: { event: string; payload: unknown }[];
let cu: ComputerUse;
let tools: Map<string, ToolRegistration>;
const contexts = new Map<string, CallContext>();
let n = 0;

function make(extra: Partial<ComputerDeps> = {}): void {
  cu = createComputerUse({
    broker,
    helper: () => ({ nodeId: helper.nodeId, client: helper, kind: "host-helper" }),
    context: (callId) => {
      const c = contexts.get(callId);
      if (c === undefined) throw new Error(`no context ${callId}`);
      return c;
    },
    cancelRun: () => undefined,
    // B0: a Linux Host without a graphical session.
    startHelper: async () => undefined,
    graphicalSession: async () => false,
    headlessScreen: () => vs.screen,
    ...extra,
  });
  tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
}

beforeEach(() => {
  helper = new FakeHeadlessHelper();
  broker = new FakePermissionBroker({ armDelayMs: 0 });
  published = [];
  vs = composeVirtualScreen({
    attention: { paneHidden: () => false },
    publish: (event: string, payload: unknown) => published.push({ event, payload }),
    clock: { now: () => Date.now() },
  } as never);
  vs.start?.({ context: { nodes: { hostHelper: () => ({ client: helper }) } } } as never);
  contexts.clear();
  make();
});

afterEach(() => {
  vi.useRealTimers();
});

async function call(tool: string, params: unknown, ctx: Partial<CallContext> = {}) {
  const callId = `hcall_${++n}`;
  contexts.set(callId, {
    toolCallId: callId,
    threadId: "th_1",
    runId: "run_1",
    permissionMode: "balanced",
    taint: false,
    ...ctx,
  });
  const reg = tools.get(tool);
  if (reg === undefined) throw new Error(`no tool ${tool}`);
  return reg.execute(callId, params, new AbortController().signal, () => undefined);
}

/** The watch pane on the Host's own desktop shell: the owner's tap. */
function ownerTap(method: string, params: unknown) {
  const h = (vs.handlers as Record<string, { run: (c: unknown, p: unknown) => unknown }>)[method];
  if (h === undefined) throw new Error(`no handler ${method}`);
  return h.run({ identity: { desktopShell: true }, method }, params);
}

const snapshot = (ctx: Partial<CallContext> = {}) =>
  call("computer.snapshot", { app: editor, surface: "virtual_screen" }, ctx);
const agentCalls = () => helper.calls.filter((c) => c.capability.startsWith("computer."));

describe("take-over on the headless Host's private screen", () => {
  it("without the owner's tap, the agent's session uses the screen", async () => {
    const r = await snapshot();
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(agentCalls().length).toBeGreaterThan(0);
    for (const c of agentCalls()) expect(c.params).toMatchObject({ surface: "virtual_screen" });
  });

  it("refuses the agent while the owner has taken over, and reaches no helper", async () => {
    // The agent's session already holds the screen.
    await snapshot();
    const before = agentCalls().length;
    await ownerTap("computerWatch.takeOver", { on: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = snapshot();
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await pending;
    expect(r.output).toMatchObject({
      error: { code: "user_in_control", retryable: true, details: { reason: "taken_over" } },
    });
    expect(agentCalls()).toHaveLength(before);
  });

  it("lets the agent go on once the owner gives control back", async () => {
    await ownerTap("computerWatch.takeOver", { on: true });
    let done = false;
    const pending = snapshot().then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(agentCalls()).toHaveLength(0);
    await ownerTap("computerWatch.takeOver", { on: false });
    const r = await pending;
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(agentCalls().length).toBeGreaterThan(0);
  });

  it("only the owner's tap takes over: nothing else can turn it on", async () => {
    // Not the desktop shell or a paired desktop app: a node, a phone, an agent's own call.
    for (const identity of [{ role: "node" }, { role: "client", hostHelper: true }]) {
      const h = (vs.handlers as Record<string, { run: (c: unknown, p: unknown) => unknown }>)[
        "computerWatch.takeOver"
      ];
      expect(() =>
        h?.run({ identity, method: "computerWatch.takeOver", ctx: {} }, { on: true }),
      ).toThrow(/only the Psyche desktop app/);
    }
    expect(vs.screen.isTakenOver()).toBe(false);
    const r = await snapshot();
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
  });
});

describe("Task end on the headless Host's private screen", () => {
  it("ends the helper's session and closes the screen's apps", async () => {
    helper.apps = [{ appId: editor, pid: 5, windowTitle: "Notes" }];
    await snapshot({ taskId: "task_1" });
    await cu.taskEnded("task_1");
    const order = helper.calls.map((c) => c.capability);
    expect(order).toContain("computer.end_session");
    expect(helper.used("vscreen.stop")).toEqual([
      { capability: "vscreen.stop", params: { closeApps: true } },
    ]);
    expect(order.indexOf("computer.end_session")).toBeLessThan(order.indexOf("vscreen.stop"));
    expect(helper.apps).toEqual([]);
    expect(published.filter((p) => p.event === "computerWatch.parked")).toEqual([]);
  });

  it("parks the Task with the unsaved-changes card instead of discarding work", async () => {
    const unsaved = { appId: editor, pid: 5, windowTitle: "Notes", hasUnsavedChanges: true };
    helper.apps = [unsaved];
    await snapshot({ taskId: "task_1" });
    await cu.taskEnded("task_1");
    // Never forced: the app is still there, and the owner gets the card.
    expect(helper.used("vscreen.stop").map((c) => c.params)).toEqual([{ closeApps: true }]);
    expect(helper.apps).toEqual([unsaved]);
    expect(published).toContainEqual({
      event: "computerWatch.parked",
      payload: { apps: [unsaved] },
    });
    const status = (await ownerTap("computerWatch.status", {})) as { parked: boolean };
    expect(status.parked).toBe(true);
    // The card's Discard is the owner's: only then is the app closed.
    await ownerTap("computerWatch.resolveParked", { action: "discard" });
    expect(helper.used("vscreen.stop").at(-1)?.params).toEqual({ closeApps: true, force: true });
    expect(helper.apps).toEqual([]);
  });

  it("a chat turn's session closes the apps when its run ends", async () => {
    await snapshot({ runId: "run_chat" });
    await cu.runEnded("run_chat");
    expect(helper.used("vscreen.stop")).toHaveLength(1);
  });

  it("another Task cannot use the screen while one holds it, so its end closes only its own apps", async () => {
    await snapshot({ taskId: "task_1", runId: "run_a" });
    const other = await snapshot({ taskId: "task_2", runId: "run_b" });
    expect(other.output).toMatchObject({ error: { details: { reason: "computer_busy" } } });
    await cu.taskEnded("task_2");
    expect(helper.used("vscreen.stop")).toHaveLength(0);
    await cu.taskEnded("task_1");
    expect(helper.used("vscreen.stop")).toHaveLength(1);
  });

  it("leaves the apps to the owner while they hold control", async () => {
    await snapshot({ taskId: "task_1" });
    await ownerTap("computerWatch.takeOver", { on: true });
    await cu.taskEnded("task_1");
    expect(helper.used("computer.end_session")).toHaveLength(1);
    expect(helper.used("vscreen.stop")).toHaveLength(0);
  });

  it("tells the browser on the same screen that it stopped", async () => {
    let stops = 0;
    const off = vs.takeOver.onStopped(() => stops++);
    await snapshot({ taskId: "task_1" });
    await cu.taskEnded("task_1");
    expect(stops).toBe(1);
    off();
    await snapshot({ taskId: "task_2" });
    await cu.taskEnded("task_2");
    expect(stops).toBe(1);
  });
});

describe("gateHeadlessRouter", () => {
  const router = (log: string[]): SurfaceRouter => ({
    async invoke(c) {
      log.push(`invoke:${c.capability}`);
      return { ok: true, result: {} };
    },
    async endSession(session) {
      log.push(`end:${session}`);
    },
  });
  const sc = (over: Partial<HeadlessScreen> = {}, log: string[] = []): HeadlessScreen => ({
    isTakenOver: () => false,
    agentGate: async () => undefined,
    async taskEnded() {
      log.push("taskEnded");
    },
    ...over,
  });
  const surfaceCall = (session?: string) =>
    ({
      surface: "virtual_screen",
      tool: "computer.snapshot",
      capability: "computer.ax_tree",
      params: {},
      ...(session === undefined ? {} : { session }),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      context: {} as CallContext,
    }) as const;

  it("a refused gate never reaches the router", async () => {
    const log: string[] = [];
    const gated = gateHeadlessRouter(router(log), () =>
      sc({
        agentGate: async () => {
          throw new Error("taken over");
        },
      }),
    );
    await expect(gated.invoke(surfaceCall("s1"))).rejects.toThrow("taken over");
    expect(log).toEqual([]);
  });

  it("without a screen nothing waits and Task end only ends the session", async () => {
    const log: string[] = [];
    const gated = gateHeadlessRouter(router(log), () => undefined);
    await gated.invoke(surfaceCall("s1"));
    await gated.endSession?.("s1");
    expect(log).toEqual(["invoke:computer.ax_tree", "end:s1"]);
  });

  it("closes the apps only when the last live session ends", async () => {
    const log: string[] = [];
    const gated = gateHeadlessRouter(router(log), () => sc({}, log));
    await gated.invoke(surfaceCall("s1"));
    await gated.invoke(surfaceCall("s2"));
    await gated.endSession?.("s1");
    expect(log).not.toContain("taskEnded");
    await gated.endSession?.("s2");
    expect(log.at(-1)).toBe("taskEnded");
  });

  it("a failed close is logged, never thrown at the ending Task", async () => {
    const logged: string[] = [];
    const gated = gateHeadlessRouter(
      router([]),
      () =>
        sc({
          taskEnded: async () => {
            throw new Error("helper gone");
          },
        }),
      (message) => logged.push(message),
    );
    await gated.invoke(surfaceCall("s1"));
    await expect(gated.endSession?.("s1")).resolves.toBeUndefined();
    expect(logged).toEqual(["closing the private screen's apps"]);
  });
});
