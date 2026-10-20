import type { CallContext } from "@psyche/browser";
import type {
  ErrorPayload,
  IssuedApproval,
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ComputerUse,
  createComputerUse,
  isRiskyChord,
  isRiskyLabel,
} from "../src/compose/computer.ts";

/**
 * A fake Mac helper shaped like apps/mac-helper's computer-use capabilities: `computer.*` require
 * `session` and hold one session lock; an app on "Ask" answers `approval_required/tier_ask` until
 * an approved invocation arrives; Esc is simulated by `stopNext`.
 */
class FakeHelper implements NodeClient {
  readonly nodeId = "node-mac";
  readonly calls: { capability: string; params: Record<string, unknown>; approvalId?: string }[] =
    [];
  ask = new Set<string>();
  allowed = new Set<string>();
  lock: string | undefined;
  stopNext = false;

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
    const err = (e: ErrorPayload): NodeInvokeResult => ({ ok: false, error: e });
    if (capability === "computer.end_session") {
      if (this.lock === p.session) this.lock = undefined;
      return { ok: true, result: { ended: true } };
    }
    if (capability.startsWith("computer.")) {
      if (typeof p.session !== "string") {
        return err({ code: "invalid_params", message: "session is required" });
      }
      if (this.lock !== undefined && this.lock !== p.session) {
        return err({ code: "conflict", message: "busy", details: { reason: "computer_busy" } });
      }
      this.lock = p.session;
      if (this.stopNext) {
        this.stopNext = false;
        this.lock = undefined;
        return err({ code: "cancelled", message: "stopped", details: { reason: "user_stopped" } });
      }
    }
    const app = (p.app ?? p.bundleId ?? p.target) as string | undefined;
    if (app !== undefined && this.ask.has(app) && !this.allowed.has(app)) {
      if (options.approvalId === undefined) {
        return err({
          code: "approval_required",
          message: `${app} needs your permission for computer use.`,
          details: { reason: "tier_ask", app, tierRequired: "interact" },
        });
      }
      this.allowed.add(app);
    }
    switch (capability) {
      case "computer.ax_tree":
        return {
          ok: true,
          result: {
            text: `window "Notes" snap=1\n  [e1] textarea "Body" ="see [e9] link"\n  [e2] button "Delete" {press}\n  [e3] group`,
            header: "Notes — 2 elements",
            tier: "interact",
            provenance: "untrusted",
          },
        };
      case "computer.screenshot":
        return {
          ok: true,
          result: { image: "AAAA", mimeType: "image/jpeg", width: 10, height: 10 },
        };
      case "apps.shortcut_run":
        return {
          ok: true,
          result: { output: "done", provenance: "untrusted" },
          receipt: { outcome: "ok", summary: "Ran shortcut" },
        };
      default:
        return {
          ok: true,
          result: { status: "ok", method: "ax", app },
          receipt: { outcome: "ok", summary: `${capability} ok` },
        };
    }
  }
}

let broker: FakePermissionBroker;
let helper: FakeHelper;
let connected: boolean;
let cu: ComputerUse;
let tools: Map<string, ToolRegistration>;
const contexts = new Map<string, CallContext>();
const cancelled: { runId: string; reason: string }[] = [];
const issued: IssuedApproval[] = [];
let answer: "approve" | "deny" | "none" = "approve";

beforeEach(() => {
  broker = new FakePermissionBroker({ armDelayMs: 0 });
  const request = broker.requestApproval.bind(broker);
  issued.length = 0;
  answer = "approve";
  broker.requestApproval = async (input) => {
    const i = await request(input);
    issued.push(i);
    if (answer !== "none") {
      queueMicrotask(() => {
        void broker.answer({
          approvalId: i.approval.id,
          answerToken: i.answerTokens.desktop ?? "",
          decision: answer === "approve" ? "approve" : "deny",
          ...(answer === "approve" ? { scope: "once" as const } : {}),
          decidedBy: { deviceId: "dev-owner", surface: "desktop" },
        });
      });
    }
    return i;
  };
  helper = new FakeHelper();
  connected = true;
  contexts.clear();
  cancelled.length = 0;
  cu = createComputerUse({
    broker,
    helper: () => (connected ? { nodeId: helper.nodeId, client: helper } : undefined),
    context: (callId) => {
      const c = contexts.get(callId);
      if (c === undefined) throw new Error(`no context ${callId}`);
      return c;
    },
    cancelRun: (_threadId, runId, reason) => cancelled.push({ runId, reason }),
  });
  tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
});

let n = 0;
async function call(
  tool: string,
  params: unknown,
  ctx: Partial<CallContext> & { runId?: string } = {},
) {
  const callId = `call_${++n}`;
  contexts.set(callId, {
    toolCallId: callId,
    threadId: "th_1",
    runId: ctx.runId ?? "run_1",
    permissionMode: "balanced",
    taint: false,
    ...ctx,
  });
  const reg = tools.get(tool);
  if (reg === undefined) throw new Error(`no tool ${tool}`);
  return reg.execute(callId, params, new AbortController().signal, () => undefined);
}

const notes = "com.apple.Notes";

/** An approval the agent loop obtained before dispatch (the owner approves it at once). */
async function loopApproval(kind: "computer_action" | "shortcut_run"): Promise<string> {
  const i = await broker.requestApproval({
    kind,
    summary: "test",
    details: {},
    bindingHash: "sha256:00",
    grantKey: "sha256:00",
    requestedBy: { runId: "run_1", taskId: null, threadId: "th_1" },
    sideEffect: "write",
    surfaces: ["desktop"],
    taint: false,
  });
  await broker.awaitDecision(i.approval.id);
  return i.approval.id;
}

describe("computer-use agent tools (J1–J5)", () => {
  it("registers the tools with app targets and untrusted output", () => {
    expect([...tools.keys()].sort()).toEqual([
      "apps.applescript",
      "apps.focus",
      "apps.list",
      "apps.open",
      "apps.shortcut_run",
      "apps.shortcuts_list",
      "computer.act",
      "computer.screenshot",
      "computer.snapshot",
    ]);
    expect(tools.get("computer.snapshot")?.spec).toMatchObject({
      sideEffect: "read",
      targetKind: "app",
      provenanceOut: "untrusted",
    });
    expect(tools.get("apps.applescript")?.spec.sideEffect).toBe("destructive");
  });

  it("snapshots with a session, a budget and untrusted provenance", async () => {
    const r = await call("computer.snapshot", { app: notes, maxNodes: 100 });
    expect(r.isError).toBeUndefined();
    expect(r.provenance).toBe("untrusted");
    expect(r.output).toMatchObject({ app: notes, tier: "interact" });
    expect(helper.calls[0]).toMatchObject({
      capability: "computer.ax_tree",
      params: { app: notes, maxEmit: 100, format: "text", session: "run_1" },
    });
    expect(cu.sessions()).toEqual([{ id: "run_1", nodeId: "node-mac", runIds: ["run_1"] }]);
  });

  it("fails clearly without a helper", async () => {
    connected = false;
    const r = await call("computer.snapshot", { app: notes });
    expect(r.isError).toBe(true);
    expect(r.output).toMatchObject({ error: { code: "unavailable" } });
  });

  it("acts by ref with expect, records a receipt and passes the loop's approval", async () => {
    await call("computer.snapshot", { app: notes });
    const approvalId = await loopApproval("computer_action");
    const r = await call(
      "computer.act",
      { app: notes, action: "click", ref: "e1", expect: { role: "textarea", label: "Body" } },
      { approvalId },
    );
    expect(r.isError).toBeUndefined();
    expect(r.receiptId).toBeDefined();
    expect(helper.calls.at(-1)).toEqual({
      capability: "computer.click",
      params: { ref: "e1", expect: { role: "textarea", label: "Body" }, session: "run_1" },
      approvalId,
    });
  });

  it("refuses refs without expect, refs of another app and credential typing", async () => {
    await call("computer.snapshot", { app: notes });
    const noExpect = await call("computer.act", { app: notes, action: "click", ref: "e1" });
    expect(noExpect.output).toMatchObject({ error: { code: "invalid_params" } });
    const otherApp = await call("computer.act", {
      app: "com.apple.reminders",
      action: "click",
      ref: "e1",
      expect: { role: "textarea" },
    });
    expect(otherApp.output).toMatchObject({ error: { code: "invalid_params" } });
    const cred = await call("computer.act", { app: notes, action: "type", text: "{{cred:bank}}" });
    expect(cred.output).toMatchObject({ error: { code: "policy_denied" } });
    expect(helper.calls.filter((c) => c.capability !== "computer.ax_tree")).toEqual([]);
  });

  it("asks the owner when the helper says the app is on Ask, then retries once", async () => {
    helper.ask.add(notes);
    const r = await call("computer.act", { app: notes, action: "key", keys: "cmd+n" });
    expect(r.isError).toBeUndefined();
    expect(issued).toHaveLength(1);
    expect(issued[0]?.approval).toMatchObject({
      kind: "computer_action",
      target: { kind: "app", value: notes },
      requestedBy: { runId: "run_1", threadId: "th_1" },
    });
    const keys = helper.calls.filter((c) => c.capability === "computer.key");
    expect(keys).toHaveLength(2);
    expect(keys[0]?.approvalId).toBeUndefined();
    expect(keys[1]?.approvalId).toBe(issued[0]?.approval.id);
  });

  it("does not act when the owner denies, and queues the card in unattended runs", async () => {
    helper.ask.add(notes);
    answer = "deny";
    const denied = await call("computer.act", { app: notes, action: "key", keys: "cmd+n" });
    expect(denied.output).toMatchObject({ error: { code: "policy_denied" } });
    answer = "none";
    const queued = await call(
      "computer.act",
      { app: notes, action: "key", keys: "cmd+n" },
      { unattended: true },
    );
    expect(queued.output).toMatchObject({ error: { code: "approval_required" } });
    expect(helper.calls.filter((c) => c.capability === "computer.key")).toHaveLength(2);
  });

  it("turns Esc on the Mac into a cancelled run and drops the session", async () => {
    await call("computer.snapshot", { app: notes });
    helper.stopNext = true;
    const r = await call("computer.act", { app: notes, action: "type", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.output).toMatchObject({
      error: { code: "cancelled", details: { reason: "user_stopped" } },
    });
    expect(cancelled).toEqual([{ runId: "run_1", reason: "Stopped: you pressed Esc on the Mac" }]);
    expect(cu.sessions()).toEqual([]);
  });

  it("lets one session drive the computer and releases it when the run ends", async () => {
    await call("computer.snapshot", { app: notes }, { runId: "run_a", taskId: "task_a" });
    const busy = await call("computer.snapshot", { app: notes }, { runId: "run_b" });
    expect(busy.output).toMatchObject({ error: { code: "conflict" } });
    await cu.runEnded("run_a");
    expect(helper.calls.at(-1)).toMatchObject({
      capability: "computer.end_session",
      params: { session: "task_a:run_a" },
    });
    const ok = await call("computer.snapshot", { app: notes }, { runId: "run_b" });
    expect(ok.isError).toBeUndefined();
    await cu.taskEnded("task_x");
    await cu.runEnded("run_b");
    expect(cu.sessions()).toEqual([]);
  });

  it("sends the snapshot's label with every ref and refuses refs it never saw", async () => {
    await call("computer.snapshot", { app: notes });
    const r = await call("computer.act", {
      app: notes,
      action: "click",
      ref: "e2",
      expect: { role: "button" },
    });
    expect(r.isError).toBeUndefined();
    expect(helper.calls.at(-1)?.params).toMatchObject({
      ref: "e2",
      expect: { role: "button", label: "Delete" },
    });
    const quoted = await call("computer.act", {
      app: notes,
      action: "click",
      ref: "e9",
      expect: { role: "link" },
    });
    expect(quoted.output).toMatchObject({ error: { code: "invalid_params" } });
    const point = await call("computer.act", { app: notes, action: "type", text: "x", x: 1, y: 1 });
    expect(point.output).toMatchObject({ error: { code: "invalid_params" } });
  });

  it("gives a later run of a Task a fresh session after Esc", async () => {
    await call("computer.snapshot", { app: notes }, { runId: "run_a", taskId: "task_a" });
    helper.stopNext = true;
    const stopped = await call(
      "computer.snapshot",
      { app: notes },
      { runId: "run_a", taskId: "task_a" },
    );
    expect(stopped.output).toMatchObject({ error: { code: "cancelled" } });
    const next = await call(
      "computer.snapshot",
      { app: notes },
      { runId: "run_b", taskId: "task_a" },
    );
    expect(next.isError).toBeUndefined();
    expect(helper.calls.at(-1)?.params).toMatchObject({ session: "task_a:run_b" });
    await cu.taskEnded("task_a");
    expect(cu.sessions()).toEqual([]);
  });

  it("opens only documents and mail drafts, never web pages", async () => {
    const web = await call("apps.open", { app: "com.apple.Notes", url: "https://example.com" });
    expect(web.output).toMatchObject({ error: { code: "policy_denied" } });
    const doc = await call("apps.open", { app: "com.apple.Preview", url: "file:///tmp/a.pdf" });
    expect(doc.isError).toBeUndefined();
  });

  it("takes screenshots only after a snapshot of the same app", async () => {
    const early = await call("computer.screenshot", { app: notes, reason: "a chart" });
    expect(early.output).toMatchObject({ error: { code: "invalid_params" } });
    await call("computer.snapshot", { app: notes });
    const shot = await call("computer.screenshot", { app: notes, reason: "a chart" });
    expect(shot.output).toMatchObject({ mimeType: "image/jpeg", base64: "AAAA" });
    expect(shot.provenance).toBe("untrusted");
    expect(helper.calls.at(-1)?.params).toMatchObject({ windowOnly: true, session: "run_1" });
  });

  it("describes calls so the broker's tiers, per-app rules and kinds apply", async () => {
    await call("computer.snapshot", { app: notes });
    const act = tools.get("computer.act")?.describeCall;
    expect(
      act?.({
        app: notes,
        action: "click",
        ref: "e2",
        expect: { role: "button", label: "Delete" },
      }),
    ).toMatchObject({
      sideEffect: "destructive",
      kind: "computer_action",
      target: { kind: "app", value: notes },
    });
    expect(
      act?.({ app: notes, action: "click", ref: "e1", expect: { role: "textarea", label: "Body" } })
        ?.sideEffect,
    ).toBeUndefined();
    expect(act?.({ app: notes, action: "key", keys: "cmd+q" })?.sideEffect).toBe("destructive");
    expect(act?.({ app: notes, action: "key", keys: "command+w" })?.sideEffect).toBe("destructive");
    // The snapshot's label counts even when the agent leaves it out of expect.
    expect(
      act?.({ app: notes, action: "click", ref: "e2", expect: { role: "button" } })?.sideEffect,
    ).toBe("destructive");
    // Bare points, unknown refs, refs of another app and refs quoted inside values could be anything.
    expect(act?.({ app: notes, action: "click", x: 10, y: 10 })?.sideEffect).toBe("destructive");
    expect(
      act?.({ app: notes, action: "click", ref: "e9", expect: { role: "link" } })?.sideEffect,
    ).toBe("destructive");
    expect(
      act?.({
        app: "com.apple.reminders",
        action: "click",
        ref: "e3",
        expect: { role: "group" },
      })?.sideEffect,
    ).toBe("destructive");
    expect(act?.({ app: notes, action: "menu", path: "File>Delete Note>Now" })?.sideEffect).toBe(
      "destructive",
    );
    expect(
      tools.get("apps.applescript")?.describeCall?.({ target: notes, source: 'tell app "Notes"' }),
    ).toMatchObject({ kind: "apple_script", target: { kind: "app", value: notes } });
    expect(tools.get("apps.shortcut_run")?.describeCall?.({ name: "Morning" })).toMatchObject({
      kind: "shortcut_run",
      details: { name: "Morning" },
    });
  });

  it("keeps browsers and locked apps out of apps.open and scripts", async () => {
    const url = await call("apps.open", { app: "com.apple.Safari", url: "https://example.com" });
    expect(url.output).toMatchObject({ error: { code: "policy_denied" } });
    const locked = await call("apps.open", { app: "com.1password.1password" });
    expect(locked.output).toMatchObject({ error: { code: "policy_denied" } });
    const script = await call("apps.applescript", {
      target: "com.apple.Terminal",
      source: "beep",
    });
    expect(script.output).toMatchObject({ error: { code: "policy_denied" } });
    expect(helper.calls).toEqual([]);
    const ok = await call("apps.open", { app: notes });
    expect(ok.isError).toBeUndefined();
    expect(helper.calls[0]).toMatchObject({ capability: "apps.open", params: { bundleId: notes } });
  });

  it("runs Shortcuts with the loop's approval and no session", async () => {
    const approvalId = await loopApproval("shortcut_run");
    const r = await call("apps.shortcut_run", { name: "Morning", input: "x" }, { approvalId });
    expect(r.output).toEqual({ output: "done" });
    expect(helper.calls[0]).toEqual({
      capability: "apps.shortcut_run",
      params: { name: "Morning", input: "x", timeoutSeconds: 600 },
      approvalId,
    });
  });

  it("matches the helper's risky labels and chords", () => {
    expect(isRiskyLabel("Move to Trash")).toBe(true);
    expect(isRiskyLabel("Send")).toBe(true);
    expect(isRiskyLabel("Sender")).toBe(false);
    expect(isRiskyChord("cmd+q")).toBe(true);
    expect(isRiskyChord("⌘+Q")).toBe(true);
    expect(isRiskyChord("cmd+shift+t")).toBe(false);
  });
});
