import type { CallContext } from "@psyche/browser";
import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { APPROVAL_TTL_MS, PsycheError } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ComputerUse,
  createComputerUse,
  type SurfaceCall,
  surfaceNodeId,
} from "../src/compose/computer.ts";
import { asksInSeparateDesktop } from "../src/compose/separate-desktop.ts";
import { type DesktopLike, separateDesktopRouter } from "../src/compose/separate-desktop-route.ts";

/** A helper node that records every call it gets and answers like the Linux helper would. */
class RecordingNode implements NodeClient {
  readonly calls: { capability: string; params: Record<string, unknown>; approvalId?: string }[] =
    [];
  /** Labels the helper asks about (`approval_required/risky_label`) until it gets an approval. */
  risky = new Set<string>();
  /** The guest honours `fileLocalLabel` for that exact label (the Host helper never does). */
  honoursFileLocal = false;
  /** What `computer.resolve_target` answers; undefined: the method is unknown (an old helper). */
  resolve: Record<string, unknown> | undefined;
  /** The next mutating call answers as if the owner pressed Stop. */
  stopNext = false;
  /** Every mutating call asks for the owner first (the app is on Ask: `tier_ask`). */
  tierAsk = false;
  readonly nodeId: string;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    this.nodeId = `node-${name}`;
  }
  async info(): Promise<NodeInfo> {
    throw new Error("unused");
  }
  async capabilities(): Promise<NodeCapability[]> {
    return [];
  }
  async invoke(
    capability: string,
    params: unknown,
    options: NodeInvokeOptions = {},
  ): Promise<NodeInvokeResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({
      capability,
      params: p,
      ...(options.approvalId === undefined ? {} : { approvalId: options.approvalId }),
    });
    if (capability === "computer.ax_tree") {
      return {
        ok: true,
        result: {
          text: '[e1] button "Delete"\n[e2] button "Send"\n',
          header: {},
          tier: "interact",
        },
      };
    }
    if (capability === "computer.resolve_target") {
      if (this.resolve === undefined) {
        return { ok: false, error: { code: "unknown_method", message: "no such capability" } };
      }
      return { ok: true, result: { app: p.app, provenance: "untrusted", ...this.resolve } };
    }
    if (this.stopNext && capability !== "computer.end_session") {
      this.stopNext = false;
      return {
        ok: false,
        error: { code: "cancelled", message: "stopped", details: { reason: "user_stopped" } },
      };
    }
    if (this.tierAsk && options.approvalId === undefined && capability !== "computer.end_session") {
      return {
        ok: false,
        error: {
          code: "approval_required",
          message: "the app is on Ask",
          details: { reason: "tier_ask", app: p.app, tierRequired: "interact" },
        },
      };
    }
    const label = (p.expect as { label?: string } | undefined)?.label;
    const fileLocal = this.honoursFileLocal && label !== undefined && p.fileLocalLabel === label;
    if (
      label !== undefined &&
      this.risky.has(label) &&
      options.approvalId === undefined &&
      !fileLocal
    ) {
      return {
        ok: false,
        error: {
          code: "approval_required",
          message: "needs approval",
          details: { reason: "risky_label", label, app: p.app },
        },
      };
    }
    return { ok: true, result: { status: "ok", app: p.app, from: this.name } };
  }
}

/**
 * The separate desktop, as the route sees it, with the rules of `SeparateDesktop`: one task at a
 * time (`use` refuses another), a release leaves the container up while a watch view is open, and
 * a Task whose grants differ from the last one's gets a reset workspace.
 */
class FakeDesktop implements DesktopLike {
  ready = false;
  task: string | undefined;
  used: string[] = [];
  released: string[] = [];
  resets: string[] = [];
  /** Grants per task (shares and internet), as `grantsKey` would say. */
  grants = new Map<string, string>();
  #lastGrants: string | undefined;
  readonly guest: RecordingNode;
  constructor(guest: RecordingNode) {
    this.guest = guest;
  }
  owner(): string | undefined {
    return this.task;
  }
  clientFor(): NodeClient {
    return this.guest;
  }
  async use(taskId: string): Promise<void> {
    if (this.task !== undefined && this.task !== taskId) {
      throw new PsycheError("conflict", "busy", { details: { reason: "separate_desktop_busy" } });
    }
    this.used.push(taskId);
    const grants = this.grants.get(taskId) ?? "";
    if (this.#lastGrants !== grants) this.resets.push(taskId);
    this.#lastGrants = grants;
    this.task = taskId;
    this.ready = true;
  }
  async release(taskId: string): Promise<void> {
    this.released.push(taskId);
    // The container stays up (a watch view is open): `ready` does not change.
    if (this.task === taskId) this.task = undefined;
  }
  asks(taskId: string, text: string | undefined, target: { app?: string }): boolean {
    if (taskId !== this.task) return asksInSeparateDesktop(text);
    return asksInSeparateDesktop(text, {
      internetUsed: false,
      credentialFilled: false,
      readWriteShareMounted: false,
      app: target.app,
    });
  }
}

const editor = "org.gnome.TextEditor";
let host: RecordingNode;
let guest: RecordingNode;
let desktop: FakeDesktop;
let tools: Map<string, ToolRegistration>;
let cu: ComputerUse;
let broker: FakePermissionBroker;
let clock = 1_000_000;
const contexts = new Map<string, CallContext>();

beforeEach(() => {
  host = new RecordingNode("host");
  guest = new RecordingNode("guest");
  guest.honoursFileLocal = true;
  desktop = new FakeDesktop(guest);
  contexts.clear();
  clock = 1_000_000;
  broker = new FakePermissionBroker({ armDelayMs: 0 });
  cu = createComputerUse({
    broker,
    helper: () => ({ nodeId: "node-host", client: host, kind: "host-helper" }),
    context: (id) => {
      const c = contexts.get(id);
      if (c === undefined) throw new Error(`no context ${id}`);
      return c;
    },
    cancelRun: () => undefined,
    surfaces: { separate_desktop: separateDesktopRouter(desktop) },
    now: () => clock,
  });
  tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
});

let n = 0;
async function call(tool: string, params: unknown, taskId = "task_1") {
  const callId = `call_${++n}`;
  contexts.set(callId, {
    toolCallId: callId,
    threadId: "th_1",
    runId: "run_1",
    taskId,
    permissionMode: "balanced",
    taint: false,
    // Nobody is there to answer a card: an ask becomes a queued approval and the call fails.
    unattended: true,
  });
  const reg = tools.get(tool);
  if (reg === undefined) throw new Error(`no tool ${tool}`);
  return reg.execute(callId, params, new AbortController().signal, () => undefined);
}

const errorOf = (r: { output: unknown }) =>
  (r.output as { error?: { code: string; details?: Record<string, unknown> } }).error;

/** A router call as `computer.ts` makes it, for the router's own checks. */
function routerCall(taskId: string, extra: Partial<SurfaceCall> = {}): SurfaceCall {
  return {
    surface: "separate_desktop",
    tool: "computer.snapshot",
    capability: "computer.ax_tree",
    params: { app: editor },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    context: {
      toolCallId: "c",
      threadId: "t",
      runId: "r",
      taskId,
      permissionMode: "balanced",
      taint: false,
    },
    ...extra,
  };
}

const click = (label: string, surface: string) => ({
  app: editor,
  action: "click",
  ref: "e1",
  expect: { role: "button", label },
  surface,
});

describe("the separate desktop route", () => {
  it("sends a separate_desktop call to the guest node and not to the Host helper", async () => {
    const r = await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    expect(r.isError).toBeUndefined();
    expect(guest.calls.map((c) => c.capability)).toEqual(["computer.ax_tree"]);
    expect(host.calls).toEqual([]);
    expect(desktop.used).toEqual(["task_1"]);
    // The desktop is started once; the second call reuses it.
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    expect(desktop.used).toEqual(["task_1"]);
  });

  it("never sends a direct or virtual_screen call to the guest", async () => {
    await call("computer.snapshot", { app: editor });
    await call("computer.snapshot", { app: editor, surface: "direct" });
    const v = await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    expect(v.output).toMatchObject({
      error: { code: "unavailable", details: { reason: "surface_unavailable" } },
    });
    await call("apps.list", {});
    await call("apps.open", { app: editor });
    expect(guest.calls).toEqual([]);
    expect(desktop.used).toEqual([]);
    expect(host.calls.length).toBeGreaterThan(0);
    // The Host helper is never asked for the separate desktop's session either.
    for (const c of host.calls) expect(c.params).not.toHaveProperty("surface");
  });

  it("refuses to route any other surface through it", async () => {
    const router = separateDesktopRouter(desktop);
    await expect(
      router.invoke({
        surface: "virtual_screen",
        tool: "computer.snapshot",
        capability: "computer.ax_tree",
        params: {},
        timeoutMs: 1000,
        signal: new AbortController().signal,
        context: {
          toolCallId: "c",
          threadId: "t",
          runId: "r",
          permissionMode: "balanced",
          taint: false,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(guest.calls).toEqual([]);
  });

  it("relaxes file-local words on this route only", async () => {
    guest.risky.add("Delete");
    host.risky.add("Delete");
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    await call("computer.snapshot", { app: editor });
    // Separate desktop: a file-local word passes the Gateway; the guest's own ask is repeated once
    // naming that label, with no approval id and no approval scope.
    const sd = await call("computer.act", click("Delete", "separate_desktop"));
    expect(sd.isError).toBeUndefined();
    const clicks = guest.calls.filter((c) => c.capability === "computer.click");
    expect(clicks.map((c) => c.approvalId ?? "none")).toEqual(["none", "none"]);
    expect(clicks.map((c) => c.params.fileLocalLabel ?? "none")).toEqual(["none", "Delete"]);
    expect(clicks.at(-1)?.params).not.toHaveProperty("approval");
    // The Host's desktop keeps asking: the helper's ask reaches the owner as a card, never auto-approved.
    const owner = { runId: "run_1", taskId: "task_1" };
    const description = tools
      .get("computer.act")
      ?.describeCall?.({ ...click("Delete", "separate_desktop") }, owner);
    const direct = tools
      .get("computer.act")
      ?.describeCall?.({ ...click("Delete", "direct") }, owner);
    expect(description?.sideEffect).not.toBe("destructive");
    expect(direct?.sideEffect).toBe("destructive");
    await call("computer.act", { ...click("Delete", "direct"), surface: undefined });
    expect(host.calls.every((c) => c.params.fileLocalLabel === undefined)).toBe(true);
  });

  it("still asks for words that reach the outside world, and for a browser", async () => {
    guest.risky.add("Send");
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const send = await call("computer.act", click("Send", "separate_desktop"));
    // The guest's ask is not answered by the route: it becomes the owner's card (unattended: queued).
    expect(guest.calls.every((c) => c.params.fileLocalLabel === undefined)).toBe(true);
    expect(send.isError).toBe(true);
    const d = tools.get("computer.act")?.describeCall?.(
      {
        app: "firefox",
        action: "click",
        ref: "e1",
        expect: { role: "button", label: "Delete" },
        surface: "separate_desktop",
      },
      { runId: "run_1", taskId: "task_1" },
    );
    expect(d?.sideEffect).toBe("destructive");
  });

  it("ends the guest session and releases the desktop with the last session", async () => {
    const router = separateDesktopRouter(desktop);
    const ctx: CallContext = {
      toolCallId: "c",
      threadId: "t",
      runId: "r",
      taskId: "task_9",
      permissionMode: "balanced",
      taint: false,
    };
    const base = {
      surface: "separate_desktop" as const,
      tool: "computer.snapshot",
      capability: "computer.ax_tree",
      params: { app: editor },
      timeoutMs: 1000,
      signal: new AbortController().signal,
      context: ctx,
    };
    await router.invoke({ ...base, session: "task_9:r1@separate_desktop" });
    await router.invoke({ ...base, session: "task_9:r2@separate_desktop" });
    await router.endSession?.("task_9:r1@separate_desktop");
    expect(desktop.released).toEqual([]);
    await router.endSession?.("task_9:r2@separate_desktop");
    expect(desktop.released).toEqual(["task_9"]);
    expect(guest.calls.filter((c) => c.capability === "computer.end_session")).toHaveLength(2);
    expect(host.calls).toEqual([]);
  });
});

/** Review of #1294, finding 1: the desktop's owner Task is checked on every call. */
describe("one Task owns the separate desktop, on every call", () => {
  const openInShare = {
    app: "org.gnome.Nautilus",
    url: "file:///workspace/share-of-task_1/notes.txt",
    surface: "separate_desktop",
  };

  it("(a) refuses another Task's session-less apps.* calls while a Task is working", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    expect(desktop.owner()).toBe("task_1");
    const before = guest.calls.length;
    for (const [tool, params] of [
      ["apps.open", openInShare],
      ["apps.focus", { app: editor, surface: "separate_desktop" }],
      ["apps.list", { surface: "separate_desktop" }],
    ] as const) {
      const r = await call(tool, params, "task_2");
      expect(r.isError, tool).toBe(true);
      expect(errorOf(r)?.code, tool).toBe("conflict");
    }
    expect(guest.calls.length).toBe(before);
    expect(desktop.used).toEqual(["task_1"]);
  });

  it("(a) the router itself refuses another Task while the desktop is up and owned", async () => {
    const router = separateDesktopRouter(desktop);
    await router.invoke(routerCall("task_1", { session: "task_1:r@separate_desktop" }));
    const before = guest.calls.length;
    // No session (as an `apps.open` would come from an older caller), desktop ready: still refused.
    await expect(
      router.invoke(
        routerCall("task_2", {
          tool: "apps.open",
          capability: "apps.open",
          params: { app: "org.gnome.Nautilus", url: openInShare.url },
        }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "separate_desktop_busy" },
    });
    expect(guest.calls.length).toBe(before);
    expect(desktop.used).toEqual(["task_1"]);
  });

  it("(b) a stale session yields through the router: the old Task's desktop is released first", async () => {
    desktop.grants.set("task_1", "share:/home/owner/Taxes:rw|internet");
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    // While task_1 is fresh, task_2 is refused.
    const busy = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(errorOf(busy)?.details).toMatchObject({ reason: "computer_busy" });
    // task_1 waits on a parked card for longer than the idle limit.
    clock += 3 * 60_000;
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(r.isError).toBeUndefined();
    // task_1's session ended on the guest and its desktop (shares, tunnel) was released before
    // task_2 claimed it, and task_2's different grants reset the workspace.
    expect(desktop.released).toEqual(["task_1"]);
    expect(desktop.used).toEqual(["task_1", "task_2"]);
    expect(desktop.resets).toContain("task_2");
    expect(
      guest.calls.some(
        (c) =>
          c.capability === "computer.end_session" &&
          c.params.session === "task_1:run_1@separate_desktop",
      ),
    ).toBe(true);
    expect(cu.sessions().map((s) => s.id)).toEqual(["task_2:run_1@separate_desktop"]);
  });

  it("(c) a desktop kept up by the watch view is claimed (and reset) by the next Task, not reused", async () => {
    desktop.grants.set("task_1", "share:/home/owner/Taxes:rw");
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    await cu.taskEnded("task_1");
    expect(desktop.released).toEqual(["task_1"]);
    // The watch view keeps the container up with task_1's mounts.
    expect(desktop.ready).toBe(true);
    expect(desktop.owner()).toBeUndefined();
    const r = await call("apps.open", openInShare, "task_2");
    expect(r.isError).toBeUndefined();
    expect(desktop.used).toEqual(["task_1", "task_2"]);
    expect(desktop.resets).toEqual(["task_1", "task_2"]);
  });

  it("releases the desktop when the owner presses Stop (user_stopped)", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    guest.stopNext = true;
    const r = await call("computer.act", click("Save", "separate_desktop"));
    expect(errorOf(r)?.details).toMatchObject({ reason: "user_stopped" });
    expect(desktop.released).toEqual(["task_1"]);
    expect(cu.sessions()).toEqual([]);
    const next = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(next.isError).toBeUndefined();
  });

  it("releases the desktop when its guest helper goes away", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    cu.nodeGone(surfaceNodeId("separate_desktop"));
    await new Promise((r) => setTimeout(r, 0));
    expect(desktop.released).toEqual(["task_1"]);
    expect(cu.sessions()).toEqual([]);
  });

  it("releases a desktop claimed only by apps.* calls when the Task ends", async () => {
    const r = await call("apps.open", { app: editor, surface: "separate_desktop" });
    expect(r.isError).toBeUndefined();
    expect(desktop.owner()).toBe("task_1");
    await cu.taskEnded("task_1");
    expect(desktop.released).toEqual(["task_1"]);
    expect(desktop.owner()).toBeUndefined();
  });
});

/** Review of #1294, finding 9: the relaxation is judged for the calling Task. */
describe("file-local words relax only for the Task that owns the desktop", () => {
  it("judges a description with the caller's Task, and asks without one", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const act = tools.get("computer.act");
    const del = click("Delete", "separate_desktop");
    expect(act?.describeCall?.(del, { runId: "run_1", taskId: "task_1" })?.sideEffect).not.toBe(
      "destructive",
    );
    expect(act?.describeCall?.(del, { runId: "run_2", taskId: "task_2" })?.sideEffect).toBe(
      "destructive",
    );
    expect(act?.describeCall?.(del)?.sideEffect).toBe("destructive");
  });
});

/** Review of #1294, finding 7: the retry names the label; it is never an approval. */
describe("the file-local retry", () => {
  it("drops a fileLocalLabel the call brought and sends none for words that ask", async () => {
    const router = separateDesktopRouter(desktop);
    guest.risky.add("Send");
    const res = await router.invoke(
      routerCall("task_1", {
        tool: "computer.act",
        capability: "computer.click",
        params: {
          app: editor,
          ref: "e2",
          expect: { role: "button", label: "Send" },
          fileLocalLabel: "Send",
        },
      }),
    );
    expect(res.ok).toBe(false);
    const clicks = guest.calls.filter((c) => c.capability === "computer.click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.params).not.toHaveProperty("fileLocalLabel");
    expect(clicks[0]?.approvalId).toBeUndefined();
  });
});

/** Review of #1294, findings 2 and 14: money checks reach the guest and fail closed. */
describe("money checks on the separate desktop", () => {
  it("asks the guest, never the Host helper, what a point click lands on", async () => {
    guest.resolve = { role: "button", labels: ["Pay $49.00"], window: "Checkout" };
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const r = await call("computer.act", {
      app: editor,
      action: "click",
      x: 10,
      y: 20,
      surface: "separate_desktop",
    });
    // A payment: the financial card is asked (unattended, so it is queued and the call stops).
    expect(r.isError).toBe(true);
    expect(errorOf(r)?.code).toBe("approval_required");
    expect(guest.calls.some((c) => c.capability === "computer.resolve_target")).toBe(true);
    expect(guest.calls.some((c) => c.capability === "computer.click")).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it("refuses a point click and Return when the guest cannot say what they land on", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const point = await call("computer.act", {
      app: editor,
      action: "click",
      x: 10,
      y: 20,
      surface: "separate_desktop",
    });
    expect(errorOf(point)).toMatchObject({
      code: "policy_denied",
      details: { reason: "point_unchecked" },
    });
    const key = await call("computer.act", {
      app: editor,
      action: "key",
      keys: "Return",
      surface: "separate_desktop",
    });
    expect(errorOf(key)).toMatchObject({
      code: "policy_denied",
      details: { reason: "focus_unchecked" },
    });
    expect(guest.calls.some((c) => ["computer.click", "computer.key"].includes(c.capability))).toBe(
      false,
    );
  });

  it("keeps money seen on one surface apart from the same app id on another", async () => {
    // A payment page in the guest's app...
    guest.resolve = { role: "button", labels: ["Confirm"], window: "Checkout - Pay now" };
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    await call("computer.act", {
      app: editor,
      action: "click",
      x: 1,
      y: 1,
      surface: "separate_desktop",
    });
    // ...does not make a bare "Confirm" on the Host's app of the same id a payment.
    host.resolve = { role: "button", labels: ["Confirm"], window: "Untitled document" };
    await call("computer.snapshot", { app: editor });
    const r = await call("computer.act", { app: editor, action: "click", x: 1, y: 1 });
    expect(r.isError).toBeUndefined();
    expect(host.calls.some((c) => c.capability === "computer.click")).toBe(true);
  });
});

/** Review of #1294 round 2, finding 2: every computer card names where the action happens. */
describe("cards name the surface", () => {
  const owner = { runId: "run_1", taskId: "task_1" };
  const describeFor = (tool: string, params: unknown) =>
    tools.get(tool)?.describeCall?.(params, owner);

  it("prefixes every separate-desktop card and puts the surface in its details", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const sd = { app: editor, surface: "separate_desktop" };
    const cards = [
      describeFor("computer.act", click("Save", "separate_desktop")),
      describeFor("computer.snapshot", sd),
      describeFor("computer.check_target", { ...sd, role: "button", name: "Save" }),
      describeFor("computer.screenshot", { ...sd, reason: "a chart" }),
      describeFor("apps.open", { ...sd, url: "file:///workspace/notes.txt" }),
      describeFor("apps.focus", sd),
    ];
    for (const c of cards) {
      expect(c?.summary).toMatch(/^In the separate desktop: /);
      expect(c?.details).toMatchObject({ surface: "separate_desktop" });
    }
    expect(cards[0]?.summary).toBe("In the separate desktop: click “Save” in org.gnome.TextEditor");
  });

  it("names the separate desktop on the helper's own ask and on the payment card", async () => {
    const broker = new FakePermissionBroker({ armDelayMs: 0 });
    const issued: { summary: string; details: Record<string, unknown>; sideEffect: string }[] = [];
    const request = broker.requestApproval.bind(broker);
    broker.requestApproval = async (input) => {
      issued.push({
        summary: input.summary,
        details: input.details as Record<string, unknown>,
        sideEffect: input.sideEffect,
      });
      return request(input);
    };
    const cu2 = createComputerUse({
      broker,
      helper: () => ({ nodeId: "node-host", client: host, kind: "host-helper" }),
      context: (id) => {
        const c = contexts.get(id);
        if (c === undefined) throw new Error(`no context ${id}`);
        return c;
      },
      cancelRun: () => undefined,
      surfaces: { separate_desktop: separateDesktopRouter(desktop) },
    });
    tools = new Map(cu2.registrations().map((r) => [r.spec.name, r]));
    // The guest's app is on Ask: its own ask becomes the owner's card.
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    guest.tierAsk = true;
    await call("computer.act", click("Save", "separate_desktop"));
    guest.tierAsk = false;
    // A point that lands on a payment.
    guest.resolve = { role: "button", labels: ["Pay $49.00"], window: "Checkout" };
    await call("computer.act", {
      app: editor,
      action: "click",
      x: 5,
      y: 6,
      surface: "separate_desktop",
    });
    expect(issued.length).toBeGreaterThanOrEqual(2);
    for (const i of issued) {
      expect(i.summary).toMatch(/^In the separate desktop: /);
      expect(i.details).toMatchObject({ surface: "separate_desktop" });
    }
    expect(issued.some((i) => i.sideEffect === "financial")).toBe(true);
  });

  it("leaves a Mac's own desktop unnamed, and names this computer on a Linux Host", () => {
    const mac = describeFor("computer.act", { ...click("Save", "direct"), surface: undefined });
    expect(mac?.summary).toBe("click “Save” in org.gnome.TextEditor");
    expect(mac?.details).not.toHaveProperty("surface");
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const linux = describeFor("computer.act", { ...click("Save", "direct"), surface: undefined });
      expect(linux?.summary).toBe("On this computer: click “Save” in org.gnome.TextEditor");
      expect(linux?.details).toMatchObject({ surface: "direct" });
      expect(describeFor("apps.open", { app: editor })?.summary).toBe(
        "On this computer: Open org.gnome.TextEditor",
      );
    } finally {
      if (real !== undefined) Object.defineProperty(process, "platform", real);
    }
  });
});

/** Review of #1294 round 2, findings 5 and 6: taking a stale session's place. */
describe("a stale separate-desktop session", () => {
  it("yields to one Task only when two arrive together", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    clock += 3 * 60_000;
    const [b, c] = await Promise.all([
      call("computer.snapshot", { app: editor, surface: "separate_desktop" }, "task_2"),
      call("computer.snapshot", { app: editor, surface: "separate_desktop" }, "task_3"),
    ]);
    const ok = [b, c].filter((r) => r.isError === undefined);
    expect(ok).toHaveLength(1);
    const refused = [b, c].find((r) => r.isError === true);
    expect(refused === undefined ? undefined : errorOf(refused)?.code).toBe("conflict");
    expect(desktop.released).toEqual(["task_1"]);
    expect(cu.sessions()).toHaveLength(1);
  });

  it("is kept while its Task waits on the owner's card", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    // task_1 parks on a card the owner has not answered (its app is on Ask).
    guest.tierAsk = true;
    const parked = await call("computer.act", click("Save", "separate_desktop"));
    guest.tierAsk = false;
    expect(errorOf(parked)?.code).toBe("approval_required");
    clock += 3 * 60_000;
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(errorOf(r)).toMatchObject({ code: "conflict", details: { reason: "computer_busy" } });
    // No yield, no release, no reset: task_1's workspace is intact for its approved action.
    expect(desktop.released).toEqual([]);
    expect(desktop.owner()).toBe("task_1");
  });
});

/** Review of #1294, round 3, finding 2: only the session's own cards hold it, for one card's life. */
describe("what keeps a stale separate-desktop session", () => {
  it("is not held by another kind of card of the same Task", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    await broker.requestApproval({
      kind: "send_email",
      summary: "Send the report",
      details: {},
      bindingHash: `sha256:${"0".repeat(64)}`,
      grantKey: "mail",
      requestedBy: { runId: "run_1", taskId: "task_1", threadId: "th_1" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    clock += 3 * 60_000;
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(r.isError).toBeUndefined();
    expect(desktop.released).toEqual(["task_1"]);
  });

  it("is not held by a Host card of the same Task", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    // The loop's card for a call on the Host's own desktop (no surface in its details).
    await broker.requestApproval({
      kind: "computer_action",
      summary: "click “Save” in org.gnome.TextEditor",
      details: { app: editor, action: "click" },
      bindingHash: `sha256:${"1".repeat(64)}`,
      grantKey: "host",
      requestedBy: { runId: "run_1", taskId: "task_1", threadId: "th_1" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    clock += 3 * 60_000;
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(r.isError).toBeUndefined();
  });

  it("is held by the loop's card for this Task on this surface, for one card's lifetime", async () => {
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    await broker.requestApproval({
      kind: "computer_action",
      summary: "In the separate desktop: click “Save” in org.gnome.TextEditor",
      details: { app: editor, action: "click", surface: "separate_desktop" },
      bindingHash: `sha256:${"2".repeat(64)}`,
      grantKey: "sd",
      requestedBy: { runId: "run_1", taskId: "task_1", threadId: "th_1" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
      ttlMs: 24 * 60 * 60_000,
    });
    clock += 3 * 60_000;
    const held = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(errorOf(held)?.details).toMatchObject({ reason: "computer_busy" });
    // Past one card's lifetime from the session's last use, the card no longer holds it.
    clock += APPROVAL_TTL_MS;
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "separate_desktop" },
      "task_2",
    );
    expect(r.isError).toBeUndefined();
    expect(desktop.released).toEqual(["task_1"]);
  });
});
