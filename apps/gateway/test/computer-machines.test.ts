import { hashCanonical } from "@psyche/audit";
import type { CallContext } from "@psyche/browser";
import {
  getSetting,
  insertDevice,
  insertMachine,
  openDb,
  type PsycheDb,
  revokeDevice,
  setSetting,
} from "@psyche/db";
import { bindingHash } from "@psyche/permissions";
import type {
  ApprovalRequestInput,
  IssuedApproval,
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeOptions,
  NodeInvokeResult,
  ToolCallAuthority,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ComputerUse,
  createComputerUse,
  type MachineTarget,
  machineNodeId,
  registerSurfaceRouter,
  type SurfaceCall,
  type SurfaceRouter,
} from "../src/compose/computer.ts";
import {
  COMPUTER_USE_DEFAULT_MACHINE,
  COMPUTER_USE_ENABLED,
  COMPUTER_USE_MACHINE_APPS,
  defaultMachineFrom,
  machineAppTiers,
  machineComputerUseFile,
  normalizeMachineSetting,
  noteMachineApp,
} from "../src/compose/computer-settings.ts";
import {
  createMachineRouter,
  MACHINE_SETTINGS_CAPABILITY,
  type MachineRouterHandle,
  machinesListTool,
} from "../src/compose/machines.ts";

/**
 * Computer use on paired machines (wave H4): the Host plus two fake machines, `lab-box` (A) and
 * `build-box` (B). Every row says where a call may go and where it must not.
 */

const cap = (name: string): NodeCapability => ({ name, sideEffect: "none" });

/** A helper (the Host's or a machine's): records every call, answers like the Linux helper. */
class FakeNode implements NodeClient {
  readonly calls: { capability: string; params: Record<string, unknown>; approvalId?: string }[] =
    [];
  /** What `computer.resolve_target` reports. */
  target: Record<string, unknown> = { role: "push button", label: "Save", labels: ["Save"] };
  readonly nodeId: string;
  constructor(nodeId: string) {
    this.nodeId = nodeId;
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
    const app = (p.app ?? p.bundleId) as string | undefined;
    switch (capability) {
      case "computer.ax_tree":
        return {
          ok: true,
          result: { text: `window "W"\n  [e1] button "Save"\n  [e2] button "Delete"`, app },
        };
      case "computer.resolve_target":
        return { ok: true, result: { ...this.target, app } };
      case "apps.resolve":
        return {
          ok: true,
          result: { bundleId: app, path: `/System/Applications/${app}.app`, name: app },
        };
      default:
        return {
          ok: true,
          result: { status: "ok", app },
          receipt: { outcome: "ok", summary: `${capability} ok` },
        };
    }
  }
}

let db: PsycheDb;
let broker: FakePermissionBroker;
let host: FakeNode;
let nodes: Map<string, FakeNode>;
let online: Set<string>;
let router: MachineRouterHandle;
let cu: ComputerUse;
let tools: Map<string, ToolRegistration>;
let A: MachineTarget & { id: string };
let B: MachineTarget & { id: string };
const contexts = new Map<string, CallContext>();
const authorities = new Map<string, ToolCallAuthority>();
const issued: IssuedApproval[] = [];
const requested: ApprovalRequestInput[] = [];
const parks: { machine: MachineTarget; taskId: string }[] = [];
let answer: "approve" | "deny" | "none" = "approve";

function pairMachine(name: string): MachineTarget & { id: string } {
  const device = insertDevice(db, {
    name,
    platform: "linux",
    role: "node",
    publicKey: new Uint8Array(32).fill(name.length),
    pairedAt: db.now(),
  });
  const record = insertMachine(db, {
    deviceId: device.id,
    approvedByDeviceId: null,
    via: "setup_token",
  });
  nodes.set(device.id, new FakeNode(`node-${name}`));
  online.add(device.id);
  return { id: record.id, deviceId: device.id, name };
}

function make(extra: { surfaces?: { virtual_screen: SurfaceRouter } } = {}): void {
  router = createMachineRouter({
    db,
    machine(deviceId) {
      const node = nodes.get(deviceId);
      if (node === undefined || !online.has(deviceId)) return undefined;
      return {
        info: {
          id: node.nodeId,
          deviceId,
          kind: "machine",
          capabilities: [cap("computer.ax_tree"), cap("computer.click")],
          status: "online",
          lastHeartbeatAt: null,
        },
        client: node,
      };
    },
    parked: (machine, taskId) => parks.push({ machine, taskId }),
    park: { timeoutMs: 300, pollMs: 5 },
  });
  cu = createComputerUse({
    broker,
    machines: router,
    helper: () => ({ nodeId: host.nodeId, client: host, kind: "mac-helper" }),
    context: (callId) => {
      const c = contexts.get(callId);
      if (c === undefined) throw new Error(`no context ${callId}`);
      return c;
    },
    authority: (callId) => authorities.get(callId),
    cancelRun: () => undefined,
    ...extra,
  });
  tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
}

beforeEach(() => {
  db = openDb(":memory:");
  broker = new FakePermissionBroker({ armDelayMs: 0 });
  const request = broker.requestApproval.bind(broker);
  issued.length = 0;
  requested.length = 0;
  parks.length = 0;
  answer = "approve";
  broker.requestApproval = async (input) => {
    requested.push(structuredClone(input));
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
  host = new FakeNode("node-host");
  nodes = new Map();
  online = new Set();
  contexts.clear();
  authorities.clear();
  A = pairMachine("lab-box");
  B = pairMachine("build-box");
  setSetting(db, COMPUTER_USE_ENABLED, true);
  make();
});

afterEach(() => {
  db.close();
});

let n = 0;
async function call(tool: string, params: unknown, ctx: Partial<CallContext> = {}) {
  const callId = `mcall_${++n}`;
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

/** What the agent loop binds a call to: `{tool, paramsHash, fields}` from its description. */
function loopBinding(
  tool: string,
  params: unknown,
  scope = { runId: "run_1" } as {
    runId: string;
    taskId?: string;
  },
): string {
  const reg = tools.get(tool);
  const desc = reg?.describeCall?.(params, scope) ?? {};
  return bindingHash(desc.kind ?? "computer_action", {
    tool,
    paramsHash: hashCanonical(params),
    ...(desc.bindingFields === undefined ? {} : { fields: desc.bindingFields }),
  });
}

/**
 * The agent loop's dispatch for an approved call: describe, verify the approval against this
 * call's own binding (`verifyBinding`), and only then run the tool with the approval.
 */
async function viaLoop(
  tool: string,
  params: unknown,
  approvalId: string,
  ctx: Partial<CallContext> = {},
) {
  const binding = loopBinding(tool, params, {
    runId: ctx.runId ?? "run_1",
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
  });
  const verified = await broker.verifyBinding(approvalId, binding);
  if (!verified.ok) return { refused: verified.reason };
  return { result: await call(tool, params, { ...ctx, approvalId }) };
}

/** A card the owner approved for exactly this call (the loop's card). */
async function approvedCard(
  tool: string,
  params: unknown,
  scope: { runId: string; taskId?: string } = { runId: "run_1" },
): Promise<string> {
  const before = answer;
  answer = "approve";
  const i = await broker.requestApproval({
    kind: "computer_action",
    summary: "test",
    details: {},
    bindingHash: loopBinding(tool, params, scope),
    grantKey: "sha256:00",
    requestedBy: { runId: "run_1", taskId: null, threadId: "th_1" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    taint: false,
  });
  await broker.awaitDecision(i.approval.id);
  answer = before;
  issued.length = 0;
  requested.length = 0;
  return i.approval.id;
}

const callsOf = (node: FakeNode | undefined, capability?: string) =>
  (node?.calls ?? []).filter((c) => capability === undefined || c.capability === capability);
const errorOf = (r: { output: unknown }) =>
  (r.output as { error?: { code: string; details?: Record<string, unknown> } }).error;

const editor = "org.gnome.TextEditor";
const allowTiers = (machineId: string, rows: { id: string; tier: string }[]) =>
  setSetting(db, COMPUTER_USE_MACHINE_APPS, {
    [machineId]: rows.map((r) => ({ ...r, name: r.id })),
  });

describe("routing: a call goes only to the computer it names", () => {
  it.each([
    ["the machine's name", () => "lab-box"],
    ["its name in another case", () => "LAB-Box"],
    ["its machine id", () => A.id],
    ["its device id", () => A.deviceId],
  ])("must allow: %s routes to A only", async (_label, ref) => {
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    const r = await call("computer.snapshot", { app: editor, machine: ref() });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(callsOf(nodes.get(A.deviceId), "computer.ax_tree")).toHaveLength(1);
    expect(nodes.get(A.deviceId)?.calls[0]?.params).toMatchObject({
      app: editor,
      surface: "virtual_screen",
    });
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    expect(callsOf(host)).toHaveLength(0);
  });

  it("must allow: no machine means the Host, and the machines hear nothing", async () => {
    const r = await call("computer.snapshot", { app: "com.apple.Notes" });
    expect(r.isError).toBeUndefined();
    expect(callsOf(host, "computer.ax_tree")).toHaveLength(1);
    expect(host.calls[0]?.params).not.toHaveProperty("machine");
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    expect(cu.sessions()).toEqual([{ id: "run_1", nodeId: "node-host", runIds: ["run_1"] }]);
  });

  it("must allow: a machine takes Linux app ids even on a Mac Host", async () => {
    allowTiers(B.id, [{ id: "gnome-calculator", tier: "read" }]);
    const onB = await call("computer.snapshot", { app: "gnome-calculator", machine: "build-box" });
    expect(onB.isError, JSON.stringify(onB.output)).toBeUndefined();
    const onHost = await call("computer.snapshot", { app: "gnome-calculator" });
    expect(errorOf(onHost)?.details).toMatchObject({ reason: "app_id_shape" });
  });

  it("keeps sessions and refs per machine", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    allowTiers(B.id, [{ id: editor, tier: "interact" }]);
    setSetting(db, COMPUTER_USE_MACHINE_APPS, {
      [A.id]: [{ id: editor, name: "E", tier: "interact" }],
      [B.id]: [{ id: editor, name: "E", tier: "interact" }],
    });
    await call("computer.snapshot", { app: editor, machine: "lab-box" });
    expect(cu.sessions()).toEqual([
      {
        id: `run_1@machine:${A.deviceId}`,
        nodeId: machineNodeId(A.deviceId),
        runIds: ["run_1"],
        surface: "virtual_screen",
        machine: A.deviceId,
      },
    ]);
    // e1 was seen on A: B and the Host never saw it.
    const act = {
      app: editor,
      action: "click",
      ref: "e1",
      expect: { role: "button", label: "Save" },
    };
    const onB = await call("computer.act", { ...act, machine: "build-box" });
    expect(errorOf(onB)?.code).toBe("invalid_params");
    const onHost = await call("computer.act", act);
    expect(errorOf(onHost)?.code).toBe("invalid_params");
    const onA = await call("computer.act", { ...act, machine: "lab-box" });
    expect(onA.isError, JSON.stringify(onA.output)).toBeUndefined();
    expect(callsOf(nodes.get(A.deviceId), "computer.click")).toHaveLength(1);
    expect(callsOf(nodes.get(B.deviceId), "computer.click")).toHaveLength(0);
    expect(callsOf(host, "computer.click")).toHaveLength(0);
    // The run's end ends the machine's session on that machine.
    await cu.runEnded("run_1");
    expect(callsOf(nodes.get(A.deviceId), "computer.end_session")).toHaveLength(1);
    expect(callsOf(host, "computer.end_session")).toHaveLength(0);
  });

  it.each([
    ["an unknown name", { machine: "lab-box2" }, "not_found", "machine_not_found"],
    ["a lookalike of a name", { machine: "lab-bоx" }, "not_found", "machine_not_found"],
    [
      "a separate desktop on a machine",
      { machine: "lab-box", surface: "separate_desktop" },
      "unavailable",
      "machine_surface_unavailable",
    ],
    [
      "the direct surface on a machine",
      { machine: "lab-box", surface: "direct" },
      "unavailable",
      "machine_surface_unavailable",
    ],
  ])("must refuse: %s, and nothing is sent anywhere", async (_label, extra, code, reason) => {
    const r = await call("computer.snapshot", { app: editor, ...extra });
    expect(errorOf(r)?.code).toBe(code);
    expect(errorOf(r)?.details).toMatchObject({ reason });
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    expect(callsOf(host)).toHaveLength(0);
  });

  it("must refuse: a name two machines share, until one is renamed", () => {
    pairMachine("Lab-Box");
    expect(() => router.resolve("lab-box")).toThrow(/More than one computer/);
    // The id still names one.
    expect(router.resolve(A.id).deviceId).toBe(A.deviceId);
  });

  it("must refuse: a revoked machine is not a computer Psyche can use", async () => {
    revokeDevice(db, A.deviceId);
    const r = await call("computer.snapshot", { app: editor, machine: A.deviceId });
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_not_found" });
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("must refuse: the Apple-only tools never take a machine", async () => {
    const r = await call("apps.applescript", {
      target: "com.apple.Notes",
      source: "return 1",
      machine: "lab-box",
    });
    expect(errorOf(r)?.code).toBe("invalid_params");
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it.each(["exec.host", "fs.read", "vscreen.input", "apps.applescript", "keychain.get"])(
    "must refuse: the router never sends %s to a machine",
    async (capability) => {
      const res = await router.invoke(A, {
        surface: "virtual_screen",
        machine: A,
        tool: "x",
        capability,
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
      } satisfies SurfaceCall);
      expect(res.ok).toBe(false);
      expect(res.error?.details).toMatchObject({ reason: "machine_policy" });
      expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    },
  );

  it("must refuse: a call whose machine field names another machine", async () => {
    const res = await router.invoke(A, {
      surface: "virtual_screen",
      machine: B,
      tool: "computer.snapshot",
      capability: "computer.ax_tree",
      params: { app: editor },
      timeoutMs: 1000,
      signal: new AbortController().signal,
      context: {
        toolCallId: "c",
        threadId: "t",
        runId: "r",
        permissionMode: "balanced",
        taint: false,
      },
    });
    expect(res.error?.details).toMatchObject({ reason: "machine_mismatch" });
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
  });
});

describe("approvals are bound to the machine", () => {
  const act = (machine?: string) => ({
    app: editor,
    action: "type",
    text: "hello",
    ...(machine === undefined ? {} : { machine }),
  });

  it("puts the machine's device id in the binding and the grant key, never for the Host", () => {
    const reg = tools.get("computer.act");
    const onA = reg?.describeCall?.(act("lab-box"), { runId: "run_1" });
    const onB = reg?.describeCall?.(act("build-box"), { runId: "run_1" });
    const onHost = reg?.describeCall?.(act(), { runId: "run_1" });
    expect(onA?.bindingFields).toMatchObject({ machine: A.deviceId, surface: "virtual_screen" });
    expect(onB?.bindingFields).toMatchObject({ machine: B.deviceId });
    expect(onHost?.bindingFields).not.toHaveProperty("machine");
    expect(onHost?.bindingFields).not.toHaveProperty("surface");
    expect(new Set([onA?.grantKey, onB?.grantKey, onHost?.grantKey]).size).toBe(3);
    expect(onA?.grantKey).toContain(`|machine:${A.deviceId}`);
    expect(onA?.summary).toBe("On lab-box: Type text in org.gnome.TextEditor");
    expect(onA?.details).toMatchObject({ machine: { deviceId: A.deviceId, name: "lab-box" } });
    expect(onHost?.summary).toBe("Type text in org.gnome.TextEditor");
    // The name and the id bind the same machine.
    expect(reg?.describeCall?.(act(A.deviceId), { runId: "run_1" })?.bindingFields).toEqual(
      onA?.bindingFields,
    );
  });

  it("must allow: the card approved for A runs on A, with the approval", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const id = await approvedCard("computer.act", act("lab-box"));
    const out = await viaLoop("computer.act", act("lab-box"), id);
    expect(out.refused).toBeUndefined();
    expect(out.result?.isError, JSON.stringify(out.result?.output)).toBeUndefined();
    const typed = callsOf(nodes.get(A.deviceId), "computer.type");
    expect(typed).toHaveLength(1);
    expect(typed[0]?.approvalId).toBe(id);
  });

  it.each([
    ["on machine B", act("build-box")],
    ["on the Host", act()],
    ["on A with other text", { ...act("lab-box"), text: "hellO" }],
  ])("must refuse: the card approved for A %s", async (_label, other) => {
    const id = await approvedCard("computer.act", act("lab-box"));
    const out = await viaLoop("computer.act", other, id);
    expect(out.refused).toBe("binding_mismatch");
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    expect(callsOf(host)).toHaveLength(0);
    expect(callsOf(nodes.get(A.deviceId), "computer.type")).toHaveLength(0);
  });

  it("asks with a card bound to the machine when the machine's tier asks, then retries there", async () => {
    // The Host's tiers say nothing about A: an app with no tier for A asks there.
    const r = await call("computer.act", act("lab-box"));
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(issued).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      kind: "computer_action",
      machine: { deviceId: A.deviceId, name: "lab-box" },
      details: { machine: { deviceId: A.deviceId, name: "lab-box" } },
    });
    expect(requested[0]?.summary).toMatch(/^On lab-box: /);
    // The card binds the helper call and the machine: the same call on B or the Host is another.
    const cardHash = (where: Record<string, string>) =>
      bindingHash("computer_action", {
        tool: "computer.act",
        paramsHash: hashCanonical({ text: "hello", app: editor }),
        app: editor,
        tierRequired: "interact",
        action: "type",
        ...where,
      });
    expect(issued[0]?.approval.bindingHash).toBe(
      cardHash({ surface: "virtual_screen", machine: A.deviceId }),
    );
    expect(issued[0]?.approval.bindingHash).not.toBe(
      cardHash({ surface: "virtual_screen", machine: B.deviceId }),
    );
    expect(issued[0]?.approval.bindingHash).not.toBe(cardHash({}));
    // The machine's own gate asked before anything was sent; the retry carries the approval.
    const typed = callsOf(nodes.get(A.deviceId), "computer.type");
    expect(typed.map((c) => c.approvalId)).toEqual([issued[0]?.approval.id]);
    expect(typed[0]?.params).toMatchObject({ approval: { app: editor, tier: "interact" } });
    // The allowance holds on A only: B still asks.
    issued.length = 0;
    const again = await call("computer.act", act("lab-box"));
    expect(again.isError).toBeUndefined();
    expect(issued).toHaveLength(0);
    answer = "none";
    const onB = await call("computer.act", act("build-box"), { unattended: true });
    expect(errorOf(onB)?.code).toBe("approval_required");
    expect(callsOf(nodes.get(B.deviceId), "computer.type")).toHaveLength(0);
  });

  it("queues the card and parks an unattended Task instead of acting", async () => {
    answer = "none";
    const r = await call("computer.act", act("lab-box"), { unattended: true, taskId: "task_1" });
    expect(errorOf(r)?.code).toBe("approval_required");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.approval.status).toBe("pending");
    expect(callsOf(nodes.get(A.deviceId), "computer.type")).toHaveLength(0);
  });

  it("refuses the call when the owner denies the machine's card", async () => {
    answer = "deny";
    const r = await call("computer.act", act("lab-box"));
    expect(errorOf(r)?.code).toBe("policy_denied");
    expect(callsOf(nodes.get(A.deviceId), "computer.type")).toHaveLength(0);
  });
});

describe("per-machine tiers", () => {
  it.each([
    ["off on A", [{ id: editor, tier: "off" }], { action: "click", x: 1, y: 2 }, "app_tier:off"],
    [
      "a browser above read",
      [{ id: "firefox", tier: "interact" }],
      { action: "type", text: "x" },
      "app_tier:read",
    ],
    [
      "a password manager",
      [{ id: "org.keepassxc.KeePassXC", tier: "interact" }],
      { action: "click", x: 1, y: 2 },
      "app_tier:off",
    ],
  ])("must refuse: %s, with no card and nothing sent", async (_label, rows, action, reason) => {
    allowTiers(A.id, rows);
    const app = rows[0]?.id ?? editor;
    const r = await call("computer.act", { app, machine: "lab-box", ...action });
    expect(r.isError).toBe(true);
    const e = errorOf(r);
    expect(e?.code).toBe("policy_denied");
    expect(e?.details).toMatchObject({ reason });
    expect(issued).toHaveLength(0);
    expect(
      callsOf(nodes.get(A.deviceId)).filter((c) => c.capability !== "computer.resolve_target"),
    ).toHaveLength(0);
  });

  it("must allow: A's own tier lets the call through without a card; B's and the Host's do not count", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const onA = await call("computer.act", {
      app: editor,
      machine: "lab-box",
      action: "type",
      text: "x",
    });
    expect(onA.isError, JSON.stringify(onA.output)).toBeUndefined();
    expect(issued).toHaveLength(0);
    answer = "none";
    const onB = await call(
      "computer.act",
      { app: editor, machine: "build-box", action: "type", text: "x" },
      { unattended: true },
    );
    expect(errorOf(onB)?.code).toBe("approval_required");
  });

  it("clamps each machine's tiers to the fixed caps and never inherits another's", () => {
    const value = {
      [A.id]: [
        { id: "firefox", name: "Firefox", tier: "interact" },
        { id: editor, name: "Editor", tier: "interact" },
        { id: "org.keepassxc.KeePassXC", name: "KeePassXC", tier: "interact" },
        { id: "bad id", name: "x", tier: "interact" },
      ],
      [B.id]: [{ id: editor, name: "Editor", tier: "read" }],
      __proto__: [{ id: editor, name: "Editor", tier: "interact" }],
    };
    expect(machineAppTiers(value, A.id)).toEqual({
      firefox: "read",
      [editor]: "interact",
      "org.keepassxc.KeePassXC": "off",
    });
    expect(machineAppTiers(value, B.id)).toEqual({ [editor]: "read" });
    expect(machineAppTiers(value, "dev-other")).toEqual({});
    expect(machineAppTiers(value, "__proto__")).toEqual({});
    expect(machineAppTiers(value, "../x")).toEqual({});
    expect(machineComputerUseFile(true, value, A.id)).toMatchObject({
      version: 1,
      default: "ask",
      apps: { firefox: "read", [editor]: "interact" },
    });
    expect(machineComputerUseFile(false, value, A.id)).toMatchObject({
      default: "off",
      apps: {},
    });
  });

  it("pushes the tiers to a machine whose helper takes them, and only that machine's", async () => {
    const pushed: { deviceId: string; params: unknown }[] = [];
    const settingsRouter = createMachineRouter({
      db,
      machine(deviceId) {
        if (!online.has(deviceId)) return undefined;
        return {
          info: {
            id: `node-${deviceId}`,
            deviceId,
            kind: "machine",
            capabilities: deviceId === A.deviceId ? [cap(MACHINE_SETTINGS_CAPABILITY)] : [],
            status: "online",
            lastHeartbeatAt: null,
          },
          client: {
            nodeId: `node-${deviceId}`,
            info: async () => {
              throw new Error("unused");
            },
            capabilities: async () => [],
            invoke: async (_c: string, params: unknown) => {
              pushed.push({ deviceId, params });
              return { ok: true, result: {} };
            },
          },
        };
      },
    });
    allowTiers(A.id, [{ id: "firefox", tier: "interact" }]);
    await settingsRouter.syncTiers();
    expect(pushed).toEqual([
      {
        deviceId: A.deviceId,
        params: {
          settings: expect.objectContaining({ apps: { firefox: "read" }, default: "ask" }),
        },
      },
    ]);
  });
});

describe("money, risky labels and credentials on a machine", () => {
  it("classes a money label financial and a risky one destructive, as on the Host", () => {
    const reg = tools.get("computer.act");
    const base = { app: editor, machine: "lab-box", action: "press", ref: "e1" };
    expect(
      reg?.describeCall?.({ ...base, expect: { role: "button", label: "Pay $50" } }, { runId: "r" })
        ?.sideEffect,
    ).toBe("financial");
    expect(
      reg?.describeCall?.({ ...base, expect: { role: "button", label: "Delete" } }, { runId: "r" })
        ?.sideEffect,
    ).toBe("destructive");
  });

  it("asks a financial card bound to the machine before a point click lands on a payment", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const nodeA = nodes.get(A.deviceId);
    if (nodeA !== undefined)
      nodeA.target = { role: "push button", label: "Place order", labels: ["Place order"] };
    const r = await call("computer.act", {
      app: editor,
      machine: "lab-box",
      action: "click",
      x: 5,
      y: 5,
    });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      sideEffect: "financial",
      scopesOffered: ["once"],
      machine: { deviceId: A.deviceId, name: "lab-box" },
    });
    // The check went to A, never to the Host or B.
    expect(callsOf(nodeA, "computer.resolve_target")).toHaveLength(1);
    expect(callsOf(host)).toHaveLength(0);
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    // The same payment on B is B's own card, never A's.
    const money = (await broker.list({ status: "approved" })).find(
      (a) => a.sideEffect === "financial",
    );
    expect(money?.bindingHash).not.toBe(
      bindingHash("computer_action", {
        tool: "computer.act",
        paramsHash: hashCanonical({
          app: editor,
          action: "click",
          x: 5,
          y: 5,
          surface: "virtual_screen",
          machine: B.deviceId,
        }),
        app: editor,
        tierRequired: "click",
        action: "click",
        surface: "virtual_screen",
        machine: B.deviceId,
      }),
    );
  });

  it("refuses a point click when the machine cannot say what it lands on (fail closed)", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const nodeA = nodes.get(A.deviceId);
    if (nodeA === undefined) throw new Error("no A");
    nodeA.invoke = async (capability) => {
      nodeA.calls.push({ capability, params: {} });
      return {
        ok: false,
        error: { code: "not_found", message: `unknown capability ${capability}` },
      };
    };
    const r = await call("computer.act", {
      app: editor,
      machine: "lab-box",
      action: "click",
      x: 5,
      y: 5,
    });
    expect(errorOf(r)?.details).toMatchObject({ reason: "point_unchecked" });
    expect(callsOf(nodeA, "computer.click")).toHaveLength(0);
  });

  it.each([
    ["typed", { action: "type", text: "{{cred:github}}" }],
    [
      "set as a value",
      {
        action: "set_value",
        ref: "e1",
        expect: { role: "button", label: "Save" },
        value: "{{ CRED:github }}",
      },
    ],
    ["inside a key name", { action: "key", keys: "{{cred:x}}" }],
  ])("must refuse: a credential placeholder %s on a machine", async (_label, action) => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    await call("computer.snapshot", { app: editor, machine: "lab-box" });
    const r = await call("computer.act", { app: editor, machine: "lab-box", ...action });
    expect(errorOf(r)?.code).toBe("policy_denied");
    const sent = callsOf(nodes.get(A.deviceId)).filter((c) =>
      ["computer.type", "computer.set_value", "computer.key"].includes(c.capability),
    );
    expect(sent).toHaveLength(0);
  });
});

describe("offline machines and parking", () => {
  it("must refuse: an offline machine answers machine_offline and the call goes nowhere else", async () => {
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    online.delete(B.deviceId);
    const r = await call("computer.snapshot", { app: editor, machine: "build-box" });
    expect(errorOf(r)?.code).toBe("unavailable");
    expect(errorOf(r)?.details).toMatchObject({
      reason: "machine_offline",
      machine: { deviceId: B.deviceId, name: "build-box" },
    });
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    expect(callsOf(host)).toHaveLength(0);
    expect(parks).toHaveLength(0);
  });

  it("parks an unattended Task until its machine is back, telling the owner once", async () => {
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    online.delete(B.deviceId);
    setTimeout(() => online.add(B.deviceId), 40);
    const r = await call(
      "computer.snapshot",
      { app: editor, machine: "build-box" },
      { unattended: true, taskId: "task_9" },
    );
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(parks).toEqual([
      { machine: { deviceId: B.deviceId, name: "build-box" }, taskId: "task_9" },
    ]);
    expect(callsOf(nodes.get(B.deviceId), "computer.ax_tree")).toHaveLength(1);
    expect(callsOf(host)).toHaveLength(0);
  });

  it("gives up a park with machine_offline, never another computer", async () => {
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    online.delete(B.deviceId);
    const r = await call(
      "computer.snapshot",
      { app: editor, machine: "build-box" },
      { unattended: true, taskId: "task_9" },
    );
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_offline" });
    expect(parks).toHaveLength(1);
    expect(callsOf(host)).toHaveLength(0);
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("ends a parked wait when the machine is removed", async () => {
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    online.delete(B.deviceId);
    setTimeout(() => revokeDevice(db, B.deviceId), 20);
    const started = Date.now();
    const r = await call(
      "computer.snapshot",
      { app: editor, machine: "build-box" },
      { unattended: true, taskId: "task_9" },
    );
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_offline" });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("drops a machine's sessions when its node goes away", async () => {
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    await call("computer.snapshot", { app: editor, machine: "lab-box" });
    expect(cu.sessions()).toHaveLength(1);
    cu.nodeGone(machineNodeId(A.deviceId));
    expect(cu.sessions()).toHaveLength(0);
  });
});

describe("the default computer for background work", () => {
  beforeEach(() => {
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, A.id);
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
  });

  it("must allow: a Task's call that names no computer goes to the default", async () => {
    const r = await call("computer.snapshot", { app: editor }, { taskId: "task_1" });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(callsOf(nodes.get(A.deviceId), "computer.ax_tree")).toHaveLength(1);
    expect(callsOf(host)).toHaveLength(0);
  });

  it.each([
    ["a chat turn", {}, {}],
    ["a Task that names the direct surface", { surface: "direct" }, { taskId: "task_1" }],
  ])("must allow: %s stays on the Host", async (_label, extra, ctx) => {
    const r = await call("computer.snapshot", { app: "com.apple.Notes", ...extra }, ctx);
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(callsOf(host, "computer.ax_tree")).toHaveLength(1);
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("must allow: a Task that names another machine goes there", async () => {
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    const r = await call(
      "computer.snapshot",
      { app: editor, machine: "build-box" },
      { taskId: "task_1" },
    );
    expect(r.isError).toBeUndefined();
    expect(callsOf(nodes.get(B.deviceId), "computer.ax_tree")).toHaveLength(1);
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("must refuse: a default that names a removed machine, never falling back to the Host", async () => {
    revokeDevice(db, A.deviceId);
    const r = await call("computer.snapshot", { app: editor }, { taskId: "task_1" });
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_not_found" });
    expect(callsOf(host)).toHaveLength(0);
  });

  it("runs a call where its description was decided, even if the default changes in between", async () => {
    const reg = tools.get("computer.snapshot");
    const params = { app: editor };
    const desc = reg?.describeCall?.(params, { runId: "run_7", taskId: "task_1" });
    expect(desc?.bindingFields).toMatchObject({ machine: A.deviceId });
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, "");
    const r = await call("computer.snapshot", params, { runId: "run_7", taskId: "task_1" });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(callsOf(nodes.get(A.deviceId), "computer.ax_tree")).toHaveLength(1);
    expect(callsOf(host)).toHaveLength(0);
  });

  it.each([
    ["the Host, in a chat turn", {}, (): string | undefined => undefined],
    ["the Host, after the default changed to it", { taskId: "task_1" }, () => ""],
    ["machine B, after the default changed to it", { taskId: "task_1" }, () => B.id],
  ])(
    "must refuse: a Task's card for the default machine A, with the same params, on %s",
    async (_label, ctx, nextDefault) => {
      allowTiers(B.id, [{ id: editor, tier: "interact" }]);
      const params = { app: editor, action: "type", text: "hi" };
      const id = await approvedCard("computer.act", params, { runId: "run_2", taskId: "task_1" });
      const next = nextDefault();
      if (next !== undefined) setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, next);
      const out = await viaLoop("computer.act", params, id, { runId: "run_3", ...ctx });
      expect(out.refused).toBe("binding_mismatch");
      expect(callsOf(host)).toHaveLength(0);
      expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
      expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    },
  );

  it("must allow: the Task's card for the default machine runs there", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const params = { app: editor, action: "type", text: "hi" };
    const id = await approvedCard("computer.act", params, { runId: "run_2", taskId: "task_1" });
    const out = await viaLoop("computer.act", params, id, { runId: "run_2", taskId: "task_1" });
    expect(out.refused).toBeUndefined();
    expect(callsOf(nodes.get(A.deviceId), "computer.type")).toHaveLength(1);
  });

  it("must refuse: a call two descriptions placed on different computers", async () => {
    const reg = tools.get("computer.snapshot");
    const params = { app: editor };
    reg?.describeCall?.(params, { runId: "run_8", taskId: "task_1" });
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, "");
    reg?.describeCall?.(params, { runId: "run_8", taskId: "task_1" });
    const r = await call("computer.snapshot", params, { runId: "run_8", taskId: "task_1" });
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_changed" });
    expect(callsOf(host)).toHaveLength(0);
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it.each([
    [undefined, undefined],
    ["host", undefined],
    ["  HOST ", undefined],
    ["", undefined],
    [42, undefined],
    ["mach_1", "mach_1"],
  ])("reads the setting %j as %j", (value, want) => {
    expect(defaultMachineFrom(value)).toBe(want);
  });
});

/**
 * The Host's own private screen (B0's fallback `virtual_screen` router on a headless Linux Host,
 * or any router registered for the surface). The machine router never takes it over: a call with
 * no `machine` goes to the Host's screen, never to the default computer or another machine.
 */
describe("the Host's own virtual screen next to the machine router", () => {
  /** A fake Host screen router: Ask tier, so a typed call asks first and retries with the card. */
  function hostScreen(): SurfaceRouter & { calls: SurfaceCall[] } {
    const calls: SurfaceCall[] = [];
    return {
      calls,
      async invoke(c) {
        calls.push(c);
        const app = c.params.app as string | undefined;
        if (c.capability === "computer.ax_tree") {
          return { ok: true, result: { text: `window "W"\n  [e1] button "Save"`, app } };
        }
        if (c.capability === "computer.type" && c.approvalId === undefined) {
          return {
            ok: false,
            error: {
              code: "approval_required",
              message: "ask",
              details: { reason: "tier_ask", app, tierRequired: "interact" },
            },
          };
        }
        return {
          ok: true,
          result: { status: "ok", app },
          receipt: { outcome: "ok", summary: "ok" },
        };
      },
    };
  }

  const typed = { app: editor, action: "type", text: "hello", surface: "virtual_screen" };
  let screen: ReturnType<typeof hostScreen>;
  let offs: (() => void)[] = [];

  beforeEach(() => {
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, A.id);
    setSetting(db, COMPUTER_USE_MACHINE_APPS, {
      [A.id]: [{ id: editor, name: editor, tier: "interact" }],
      [B.id]: [{ id: editor, name: editor, tier: "interact" }],
    });
    screen = hostScreen();
  });
  afterEach(() => {
    for (const off of offs) off();
    offs = [];
  });

  const routes: [string, () => void][] = [
    ["a router passed to computer use", () => make({ surfaces: { virtual_screen: screen } })],
    [
      "a router registered for the surface",
      () => {
        offs.push(registerSurfaceRouter("virtual_screen", screen));
        make();
      },
    ],
  ];
  const ctxs: [string, Partial<CallContext>][] = [
    ["a chat turn", {}],
    ["a Task, with a default computer set", { taskId: "task_1" }],
  ];

  describe.each(routes)("with %s", (_route, setup) => {
    beforeEach(() => setup());

    it.each(ctxs)(
      "must allow: %s with no machine reaches the Host's screen only",
      async (_l, ctx) => {
        const r = await call("computer.snapshot", { app: editor, surface: "virtual_screen" }, ctx);
        expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
        expect(screen.calls.map((c) => c.capability)).toEqual(["computer.ax_tree"]);
        expect(screen.calls[0]?.machine).toBeUndefined();
        expect(screen.calls[0]?.params).not.toHaveProperty("machine");
        expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
        expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
        expect(callsOf(host)).toHaveLength(0);
        expect(cu.sessions().every((s) => s.machine === undefined)).toBe(true);
      },
    );

    it.each(ctxs)(
      "must allow: %s asks with a card that names the Host, not a machine",
      async (_l, ctx) => {
        const desc = tools.get("computer.act")?.describeCall?.(typed, {
          runId: "run_1",
          ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        });
        expect(desc?.bindingFields).toMatchObject({ surface: "virtual_screen" });
        expect(desc?.bindingFields).not.toHaveProperty("machine");
        const r = await call("computer.act", typed, ctx);
        expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
        expect(requested).toHaveLength(1);
        expect(requested[0]).not.toHaveProperty("machine");
        expect(requested[0]?.details).not.toHaveProperty("machine");
        expect(requested[0]?.summary).toMatch(/^On the virtual screen: /);
        expect(requested[0]?.summary).not.toMatch(/lab-box|build-box/);
        expect(issued[0]?.approval.machine).toBeUndefined();
        expect(screen.calls.filter((c) => c.capability === "computer.type")).toHaveLength(2);
        expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
        expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
      },
    );

    it("must allow: naming a machine still goes to that machine, never the Host's screen", async () => {
      const r = await call("computer.snapshot", { app: editor, machine: "build-box" });
      expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
      expect(callsOf(nodes.get(B.deviceId), "computer.ax_tree")).toHaveLength(1);
      expect(screen.calls).toHaveLength(0);
    });

    it("must refuse: a card approved for the Host's screen, on machine A", async () => {
      const id = await approvedCard("computer.act", typed);
      const out = await viaLoop("computer.act", { ...typed, machine: "lab-box" }, id);
      expect(out.refused).toBe("binding_mismatch");
      expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
    });

    it("must refuse: a card approved for machine A, on the Host's screen", async () => {
      const id = await approvedCard("computer.act", { ...typed, machine: "lab-box" });
      const out = await viaLoop("computer.act", typed, id);
      expect(out.refused).toBe("binding_mismatch");
      expect(screen.calls).toHaveLength(0);
    });
  });
});

describe("receipts and machines.list", () => {
  it("names the machine on the receipt", async () => {
    allowTiers(A.id, [{ id: editor, tier: "interact" }]);
    const r = await call("computer.act", {
      app: editor,
      machine: "lab-box",
      action: "type",
      text: "x",
    });
    expect(r.isError).toBeUndefined();
    const receipts = await broker.listReceipts({});
    expect(receipts.at(-1)).toMatchObject({
      summary: expect.stringMatching(/^On lab-box: /),
      externalRefs: { machine: A.deviceId },
      payload: { machine: { deviceId: A.deviceId, name: "lab-box" } },
    });
  });

  it("leaves the Host's receipts as they were", async () => {
    const r = await call("computer.act", {
      app: "com.apple.Notes",
      action: "key",
      keys: "cmd+n",
    });
    expect(r.isError).toBeUndefined();
    const receipt = (await broker.listReceipts({})).at(-1);
    expect(receipt?.summary).toBe("computer.key ok");
    expect(receipt?.payload ?? null).toBeNull();
  });

  it("lists the paired machines, never a revoked one", async () => {
    revokeDevice(db, B.deviceId);
    const tool = machinesListTool(router);
    const r = await tool.execute("c1", {}, new AbortController().signal, () => undefined);
    const out = r.output as { machines: { id: string; name: string }[] };
    expect(out.machines.map((m) => m.name)).toEqual(["lab-box"]);
    expect(out.machines[0]?.id).toBe(A.id);
    expect(r.provenance).toBe("untrusted");
    expect(tool.spec.sideEffect).toBe("read");
  });
});

describe("the machine settings (computerUse.machineApps and computerUse.defaultMachine)", () => {
  it.each([
    ["the Host", () => "", ""],
    ["the Host, as null", () => null, ""],
    ["a paired machine's id", () => A.id, undefined],
  ])("must allow defaultMachine: %s", (_label, value, want) => {
    expect(normalizeMachineSetting(db, COMPUTER_USE_DEFAULT_MACHINE, value())).toBe(want ?? A.id);
  });

  it.each([
    ["an unknown id", () => "mach_nope"],
    ["a machine's name", () => "lab-box"],
    ["a device id", () => A.deviceId],
    [
      "a revoked machine",
      () => {
        revokeDevice(db, B.deviceId);
        return B.id;
      },
    ],
    ["a number", () => 5],
  ])("must refuse defaultMachine: %s", (_label, value) => {
    expect(() => normalizeMachineSetting(db, COMPUTER_USE_DEFAULT_MACHINE, value())).toThrow(
      /computerUse\.defaultMachine/,
    );
  });

  it("clamps each tier to its fixed cap and keeps the owner's lower ones", () => {
    const out = normalizeMachineSetting(db, COMPUTER_USE_MACHINE_APPS, {
      [A.id]: [
        { id: "firefox", name: "Firefox", tier: "interact" },
        { id: "org.keepassxc.KeePassXC", name: "KeePassXC", tier: "ask" },
        { id: editor, name: "Editor", tier: "click" },
        { id: editor.toUpperCase(), name: "dup", tier: "interact" },
        { id: "gnome-terminal", tier: "interact" },
      ],
      [B.id]: [],
    });
    expect(out).toEqual({
      [A.id]: [
        { id: "firefox", name: "Firefox", tier: "read" },
        { id: "org.keepassxc.KeePassXC", name: "KeePassXC", tier: "off" },
        { id: editor, name: "Editor", tier: "click" },
        { id: "gnome-terminal", name: "gnome-terminal", tier: "click" },
      ],
      [B.id]: [],
    });
    expect(normalizeMachineSetting(db, COMPUTER_USE_MACHINE_APPS, null)).toEqual({});
  });

  it.each([
    ["an unknown machine id", () => ({ mach_nope: [] })],
    ["a device id as the key", () => ({ [A.deviceId]: [] })],
    [
      "a revoked machine",
      () => {
        revokeDevice(db, B.deviceId);
        return { [B.id]: [] };
      },
    ],
    ["a list instead of a map", () => [{ id: editor, tier: "interact" }]],
    ["apps that are not a list", () => ({ [A.id]: { id: editor } })],
    ["a bad app id", () => ({ [A.id]: [{ id: "../x", tier: "read" }] })],
    ["an unknown tier", () => ({ [A.id]: [{ id: editor, tier: "admin" }] })],
    [
      "too many apps",
      () => ({ [A.id]: Array.from({ length: 501 }, (_, i) => ({ id: `app${i}`, tier: "read" })) }),
    ],
  ])("must refuse machineApps: %s", (_label, value) => {
    expect(() => normalizeMachineSetting(db, COMPUTER_USE_MACHINE_APPS, value())).toThrow(
      /computerUse\.machineApps/,
    );
  });

  it("leaves every other key alone", () => {
    const value = [{ id: "x", tier: "interact" }];
    expect(normalizeMachineSetting(db, "computerUse.apps", value)).toBe(value);
  });

  it("lists an app the agent first used on a machine under that machine only, as ask", () => {
    expect(noteMachineApp(db, A.id, editor, "Text Editor")).toBeDefined();
    expect(noteMachineApp(db, A.id, editor.toLowerCase())).toBeUndefined();
    expect(noteMachineApp(db, "mach_nope", editor)).toBeUndefined();
    expect(noteMachineApp(db, A.id, "org.keepassxc.KeePassXC")).toBeDefined();
    expect(getSetting(db, COMPUTER_USE_MACHINE_APPS)?.value).toEqual({
      [A.id]: [
        { id: editor, name: "Text Editor", tier: "ask" },
        { id: "org.keepassxc.KeePassXC", name: "KeePassXC", tier: "off" },
      ],
    });
    // An `ask` row grants nothing: the machine still asks for it.
    expect(machineAppTiers(getSetting(db, COMPUTER_USE_MACHINE_APPS)?.value, A.id)).toEqual({
      "org.keepassxc.KeePassXC": "off",
    });
  });

  it("reports a machine's app to the machine's list, never the Host's", async () => {
    const hostApps: string[] = [];
    const machineApps: { deviceId: string; app: string }[] = [];
    cu = createComputerUse({
      broker,
      machines: router,
      helper: () => ({ nodeId: host.nodeId, client: host, kind: "mac-helper" }),
      context: (callId) => {
        const c = contexts.get(callId);
        if (c === undefined) throw new Error(`no context ${callId}`);
        return c;
      },
      cancelRun: () => undefined,
      appUsed: (app) => hostApps.push(app),
      machineAppUsed: (deviceId, app) => machineApps.push({ deviceId, app }),
    });
    tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    await call("computer.snapshot", { app: editor, machine: "lab-box" });
    await call("computer.snapshot", { app: "com.apple.Notes" });
    expect(machineApps).toEqual([{ deviceId: A.deviceId, app: editor }]);
    expect(hostApps).toEqual(["com.apple.Notes"]);
  });
});

describe("review r1 of #1509: tiers, parks, apps.open, pins", () => {
  const typeOn = (machine?: string) => ({
    app: editor,
    action: "type",
    text: "hello",
    ...(machine === undefined ? {} : { machine }),
  });
  const typed = () => callsOf(nodes.get(A.deviceId), "computer.type");

  it("must refuse: an explicit read tier is not turned into a card (P1)", async () => {
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    const r = await call("computer.act", typeOn("lab-box"));
    expect(errorOf(r)?.code).toBe("policy_denied");
    expect(errorOf(r)?.details).toMatchObject({ reason: "app_tier:read" });
    expect(issued).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("must refuse: a loop approval never lifts an explicit read tier, now or later (P2)", async () => {
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    const id = await approvedCard("computer.act", typeOn("lab-box"));
    const out = await viaLoop("computer.act", typeOn("lab-box"), id);
    expect(errorOf(out.result ?? { output: {} })?.code).toBe("policy_denied");
    const later = await call(
      "computer.act",
      { ...typeOn("lab-box"), text: "other" },
      { taint: true },
    );
    expect(errorOf(later)?.details).toMatchObject({ reason: "app_tier:read" });
    expect(issued).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("must refuse: a click tier with an approved interact call", async () => {
    allowTiers(A.id, [{ id: editor, tier: "click" }]);
    const id = await approvedCard("computer.act", typeOn("lab-box"));
    const out = await viaLoop("computer.act", typeOn("lab-box"), id);
    expect(errorOf(out.result ?? { output: {} })?.details).toMatchObject({
      reason: "app_tier:click",
    });
    expect(typed()).toHaveLength(0);
  });

  it("must allow: an unset tier with an approval, then the allowance for later calls", async () => {
    const id = await approvedCard("computer.act", typeOn("lab-box"));
    const out = await viaLoop("computer.act", typeOn("lab-box"), id);
    expect(out.result?.isError, JSON.stringify(out.result?.output)).toBeUndefined();
    const later = await call("computer.act", { ...typeOn("lab-box"), text: "again" });
    expect(later.isError).toBeUndefined();
    expect(issued).toHaveLength(0);
    expect(typed()).toHaveLength(2);
  });

  it("must allow: apps.open on a machine, approved on its card, opens exactly once (P3)", async () => {
    const r = await call("apps.open", { app: editor, machine: "lab-box" });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(issued).toHaveLength(1);
    const opens = callsOf(nodes.get(A.deviceId), "apps.open");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.approvalId).toBe(issued[0]?.approval.id);
    expect(opens[0]?.params.approval).toEqual({ app: editor, tier: "click" });
    expect(callsOf(nodes.get(B.deviceId), "apps.open")).toHaveLength(0);
    expect(callsOf(host, "apps.open")).toHaveLength(0);
  });

  describe("a parked call is checked again when the machine is back (P4)", () => {
    const parked = () =>
      call(
        "computer.snapshot",
        { app: editor, machine: "build-box" },
        { unattended: true, taskId: "task_9" },
      );
    const park = (during: () => void) => {
      allowTiers(B.id, [{ id: editor, tier: "read" }]);
      online.delete(B.deviceId);
      setTimeout(during, 10);
      setTimeout(() => online.add(B.deviceId), 40);
    };

    it.each([
      [
        "the app set to Off",
        () => allowTiers(B.id, [{ id: editor, tier: "off" }]),
        "policy_denied",
      ],
      [
        "computer use turned off",
        () => setSetting(db, COMPUTER_USE_ENABLED, false),
        "policy_denied",
      ],
      ["the machine revoked", () => revokeDevice(db, B.deviceId), "unavailable"],
    ])("must refuse: %s during the park", async (_label, during, code) => {
      park(during);
      const r = await parked();
      expect(errorOf(r)?.code).toBe(code);
      expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    });
  });

  it("must refuse: a machine revoked after the router was told of it (M9)", async () => {
    revokeDevice(db, A.deviceId);
    const res = await router.invoke(A, {
      surface: "virtual_screen",
      machine: A,
      tool: "computer.snapshot",
      capability: "computer.ax_tree",
      params: { app: editor },
      timeoutMs: 1000,
      signal: new AbortController().signal,
      context: {
        toolCallId: "c",
        threadId: "t",
        runId: "r",
        permissionMode: "balanced",
        taint: false,
      },
    });
    expect(res.error?.details).toMatchObject({ reason: "machine_removed" });
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("must refuse: a described Task call whose pin was evicted, never the new default (P5)", async () => {
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, A.id);
    allowTiers(A.id, [{ id: editor, tier: "read" }]);
    const reg = tools.get("computer.snapshot");
    const p = { app: editor };
    reg?.describeCall?.(p, { runId: "run_1", taskId: "task_1" });
    for (let i = 0; i < 2100; i++) {
      reg?.describeCall?.({ app: `org.x.App${i}` }, { runId: "run_z", taskId: "task_z" });
    }
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, B.id);
    allowTiers(B.id, [{ id: editor, tier: "read" }]);
    const r = await call("computer.snapshot", p, { taskId: "task_1" });
    expect(errorOf(r)?.details).toMatchObject({ reason: "machine_changed" });
    expect(callsOf(nodes.get(B.deviceId))).toHaveLength(0);
    expect(callsOf(nodes.get(A.deviceId))).toHaveLength(0);
  });

  it("reads defaultMachine as a machine id only (R4)", () => {
    for (const v of ["lab-box", A.deviceId]) {
      setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, v);
      expect(() => router.backgroundDefault?.()).toThrow(/no longer paired/);
    }
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, A.id);
    expect(router.backgroundDefault?.()?.deviceId).toBe(A.deviceId);
  });

  it("describes a Task's call on the default machine", () => {
    setSetting(db, COMPUTER_USE_DEFAULT_MACHINE, A.id);
    const desc = tools
      .get("computer.act")
      ?.describeCall?.(typeOn(), { runId: "run_1", taskId: "task_1" });
    expect(desc?.details?.machine).toEqual({ deviceId: A.deviceId, name: "lab-box" });
  });

  it.each([
    ["off", editor],
    ["off", editor.toUpperCase()],
    ["off", `${editor}.desktop`],
    ["read", editor],
    ["read", editor.toUpperCase()],
    ["read", `${editor}.desktop`],
  ])("must refuse: %s on the lowercase id holds for %s", async (tier, spelling) => {
    allowTiers(A.id, [{ id: editor.toLowerCase(), tier }]);
    const r = await call("computer.act", { ...typeOn("lab-box"), app: spelling });
    expect(errorOf(r)?.code).toBe("policy_denied");
    expect(errorOf(r)?.details).toMatchObject({ reason: `app_tier:${tier}` });
    expect(issued).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("must allow: Interact on the lowercase id covers another case, with no card", async () => {
    allowTiers(A.id, [{ id: editor.toLowerCase(), tier: "interact" }]);
    const r = await call("computer.act", { ...typeOn("lab-box"), app: editor });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(issued).toHaveLength(0);
    expect(typed()).toHaveLength(1);
  });
});
