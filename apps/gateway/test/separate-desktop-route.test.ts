import type { CallContext } from "@psyche/browser";
import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createComputerUse } from "../src/compose/computer.ts";
import { asksInSeparateDesktop } from "../src/compose/separate-desktop.ts";
import { type DesktopLike, separateDesktopRouter } from "../src/compose/separate-desktop-route.ts";

/** A helper node that records every call it gets and answers like the Linux helper would. */
class RecordingNode implements NodeClient {
  readonly calls: { capability: string; params: Record<string, unknown>; approvalId?: string }[] =
    [];
  /** Labels the helper asks about (`approval_required/risky_label`) until it gets an approval. */
  risky = new Set<string>();
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
    const label = (p.expect as { label?: string } | undefined)?.label;
    if (label !== undefined && this.risky.has(label) && options.approvalId === undefined) {
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

/** The separate desktop, as the route sees it: one task at a time, risky words per its rules. */
class FakeDesktop implements DesktopLike {
  ready = false;
  used: string[] = [];
  released: string[] = [];
  readonly guest: RecordingNode;
  constructor(guest: RecordingNode) {
    this.guest = guest;
  }
  clientFor(): NodeClient {
    return this.guest;
  }
  async use(taskId: string): Promise<void> {
    this.used.push(taskId);
    this.ready = true;
  }
  async release(taskId: string): Promise<void> {
    this.released.push(taskId);
  }
  asks(_taskId: string, text: string | undefined, target: { app?: string }): boolean {
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
const contexts = new Map<string, CallContext>();

beforeEach(() => {
  host = new RecordingNode("host");
  guest = new RecordingNode("guest");
  desktop = new FakeDesktop(guest);
  contexts.clear();
  const cu = createComputerUse({
    broker: new FakePermissionBroker({ armDelayMs: 0 }),
    helper: () => ({ nodeId: "node-host", client: host, kind: "host-helper" }),
    context: (id) => {
      const c = contexts.get(id);
      if (c === undefined) throw new Error(`no context ${id}`);
      return c;
    },
    cancelRun: () => undefined,
    surfaces: { separate_desktop: separateDesktopRouter(desktop) },
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
    // Separate desktop: a file-local word passes the Gateway; the guest's own ask is answered once.
    const sd = await call("computer.act", click("Delete", "separate_desktop"));
    expect(sd.isError).toBeUndefined();
    expect(
      guest.calls
        .filter((c) => c.capability === "computer.click")
        .map((c) => c.approvalId ?? "none"),
    ).toEqual(["none", "separate-desktop:task_1"]);
    expect(guest.calls.at(-1)?.params.approval).toEqual({ app: editor, tier: "interact" });
    // The Host's desktop keeps asking: the helper's ask reaches the owner as a card, never auto-approved.
    const description = tools
      .get("computer.act")
      ?.describeCall?.({ ...click("Delete", "separate_desktop") });
    const direct = tools.get("computer.act")?.describeCall?.({ ...click("Delete", "direct") });
    expect(description?.sideEffect).not.toBe("destructive");
    expect(direct?.sideEffect).toBe("destructive");
    await call("computer.act", { ...click("Delete", "direct"), surface: undefined });
    expect(
      host.calls.every(
        (c) => c.approvalId === undefined || !c.approvalId.startsWith("separate-desktop"),
      ),
    ).toBe(true);
  });

  it("still asks for words that reach the outside world, and for a browser", async () => {
    guest.risky.add("Send");
    await call("computer.snapshot", { app: editor, surface: "separate_desktop" });
    const send = await call("computer.act", click("Send", "separate_desktop"));
    // The guest's ask is not answered by the route: it becomes the owner's card (unattended: queued).
    expect(guest.calls.every((c) => !(c.approvalId ?? "").startsWith("separate-desktop"))).toBe(
      true,
    );
    expect(send.isError).toBe(true);
    const d = tools.get("computer.act")?.describeCall?.({
      app: "firefox",
      action: "click",
      ref: "e1",
      expect: { role: "button", label: "Delete" },
      surface: "separate_desktop",
    });
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
