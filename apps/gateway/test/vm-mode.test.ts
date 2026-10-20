import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ModelEvent,
  type ModelRequest,
  VM_SETTING_KEYS,
  type VmGuest,
  type VmStatus,
} from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeSandbox } from "../src/compose/sandbox.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { type ComposedVm, composeVm } from "../src/compose/vm.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode } from "./fake-node.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Scripted scenario for VM mode, Gateway side (L1–L5): the owner turns VM mode on, a chat turn
 * starts a Task whose workspace is the sandbox Mac, and the Task's command runs in the guest
 * through its psyche-node. The mac helper and the guest node are fakes on the real node socket.
 * No container or guest is booted.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

/** The model: the chat starts a vm Task; the Task runs `sw_vers` and reports; the evaluator agrees. */
function brain(request: ModelRequest): ModelEvent[] {
  const text = JSON.stringify(request.messages);
  if (text.includes('\\"receipts\\"')) {
    return say(
      '{"verdict": "done", "gaps": [], "reason": "sw_vers ran in the guest and exited 0."}',
    );
  }
  const parts = request.messages.flatMap((m) => m.parts ?? []);
  const last = parts.at(-1);
  if (last?.type === "tool_result") {
    return text.includes("ProductVersion")
      ? say("The sandbox Mac runs macOS 27.0.")
      : say("Started a task in the sandbox Mac.");
  }
  return text.includes("Run sw_vers in the sandbox Mac")
    ? call(`exec_${request.messages.length}`, "exec", { argv: ["sw_vers"] })
    : call("start_1", "task.start", {
        title: "Check the sandbox Mac",
        goal: "Run sw_vers in the sandbox Mac and report the macOS version.",
        workspace: "vm",
      });
}

const guest = (phase: VmGuest["phase"]): VmGuest => ({
  name: "sandbox",
  phase,
  provisioned: true,
  cpus: 4,
  memoryGB: 8,
  diskGB: 80,
  guestOS: "27.0",
  username: "psyche",
  shares: [],
  vsock: { hostCid: 2, gatewayNodePort: 7980 },
});

const noContainers = {
  start: () => ({
    pid: 1,
    done: Promise.resolve({
      exitCode: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    }),
    kill: () => undefined,
  }),
  stream: () => {
    throw new Error("no container on this host");
  },
};

let home = "";
let composed: ComposedGateway | null = null;
const nodes: FakeNode[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function stack(background: boolean) {
  home = mkdtempSync(join(tmpdir(), "psyche-vm-"));
  const model = new FakeModelProvider().script(Array.from({ length: 12 }, () => brain));
  let vm: ComposedVm | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background,
    taskPollMs: 20,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        vm = composeVm(s, { pollMs: 0 });
        return vm;
      },
      // This host has no container backend: exec exists only for VM mode.
      (s) =>
        composeSandbox(s, {
          vm: vm as ComposedVm,
          containers: false,
          runner: { driver: noContainers, detect: async () => [], idleTimeoutMs: 0 },
        }),
    ],
  });
  const c = composed;
  let phase: VmGuest["phase"] = "running";
  const helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    handlers: [
      {
        capability: { name: "vm.status", sideEffect: "read", streaming: false },
        run: (): VmStatus => ({
          guests: [guest(phase)],
          active: phase === "running" ? 1 : 0,
          maxActive: 2,
          supportsGuestProvisioning: true,
        }),
      },
    ],
  });
  const ran: unknown[] = [];
  const guestNode = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceId: "guest-psyche-node",
    handlers: [
      {
        capability: { name: "exec", sideEffect: "write", streaming: true },
        run: (params) => {
          ran.push(params);
          return {
            exitCode: 0,
            stdout: "ProductName: macOS\nProductVersion: 27.0\n",
            stderr: "",
            durationMs: 12,
            truncated: false,
            filesChanged: [],
            timedOut: false,
            outcome: "ok",
          };
        },
        receipt: { outcome: "ok", summary: "sw_vers exited 0" },
      },
    ],
  });
  nodes.push(helper, guestNode);
  const owner = await adminClient(c.gateway);
  clients.push(owner);
  return {
    c,
    model,
    owner,
    ran,
    guestNode,
    vm: vm as ComposedVm,
    services: services as ComposeServices,
    setPhase: (p: VmGuest["phase"]) => {
      phase = p;
    },
  };
}

async function approveAll(owner: TestClient, until: () => boolean, ms = 15_000) {
  const answered = new Set<string>();
  const deadline = Date.now() + ms;
  while (!until()) {
    if (Date.now() > deadline) {
      throw new Error(
        `the scenario did not finish: ${JSON.stringify(
          owner.events.map((e) => [
            e.event,
            (e.payload as { task?: { status: string } }).task?.status ??
              (e.payload as { approval?: { kind: string; status: string } }).approval?.kind ??
              (e.payload as { toolCall?: { tool: string; status: string } }).toolCall?.status ??
              "",
          ]),
        )}`,
      );
    }
    const card = owner.events
      .filter((e) => e.event === "approval.created")
      .map((e) => e.payload as { approval: { id: string }; answerToken?: string })
      .find((p) => !answered.has(p.approval.id) && p.answerToken !== undefined);
    if (card === undefined) {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    answered.add(card.approval.id);
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    await owner.call("approvals.answer", {
      approvalId: card.approval.id,
      answerToken: card.answerToken,
      decision: "approve",
      scope: "once",
    });
  }
}

describe("VM mode, Gateway side (L1–L5)", () => {
  it("runs a Task in the sandbox Mac end to end against the fake helper", async () => {
    const { c, owner, ran, guestNode, vm } = await stack(true);
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: true }, ik());
    await owner.call(
      "settings.set",
      { key: VM_SETTING_KEYS.guestNodeId, value: guestNode.nodeId },
      ik(),
    );
    await vm.refresh();
    await owner.waitForEvent((e) => e.event === "vm.updated");

    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call("chat.send", { threadId: thread.id, content: "Check the guest Mac." }, ik());
    let taskId = "";
    await approveAll(owner, () => {
      const done = owner.events.find(
        (e) =>
          e.event === "task.updated" &&
          (e.payload as { task: { status: string } }).task.status === "done",
      );
      if (done !== undefined) taskId = (done.payload as { task: { id: string } }).task.id;
      return done !== undefined;
    });

    const task = await c.tasks.get(taskId);
    expect(task).toMatchObject({ workspace: "vm", status: "done" });
    // The command ran in the guest, in the Task's own workspace there, never on the host.
    expect(ran).toEqual([
      expect.objectContaining({ argv: ["sw_vers"], scope: { kind: "task", id: taskId } }),
    ]);
    const receipts = await c.broker.listReceipts({ taskId });
    expect(receipts.map((r) => r.kind)).toContain("vm.exec");
    const lifecycle = await c.broker.listReceipts();
    expect(lifecycle.filter((r) => r.kind === "vm.lifecycle").map((r) => r.summary)).toEqual([
      "Sandbox Mac sandbox: found → running",
    ]);
  }, 30_000);

  it("never falls back to the host: a vm Task fails while the guest is off", async () => {
    const { owner, guestNode, vm, setPhase } = await stack(false);
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: true }, ik());
    await owner.call(
      "settings.set",
      { key: VM_SETTING_KEYS.guestNodeId, value: guestNode.nodeId },
      ik(),
    );
    setPhase("stopped");
    await vm.refresh();
    await expect(vm.runner.ensureSandbox({ kind: "task", id: "task_1" })).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "vm_not_running" },
    });
    // The phase change is forwarded.
    await owner.waitForEvent(
      (e) =>
        e.event === "vm.updated" && (e.payload as { guest: VmGuest }).guest.phase === "stopped",
    );

    setPhase("running");
    await vm.refresh();
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: false }, ik());
    await expect(vm.runner.ensureSandbox({ kind: "task", id: "task_1" })).rejects.toMatchObject({
      details: { reason: "vm_disabled" },
    });
    expect(vm.workspaceFor({})).toBe("sandbox");
    await owner.call("settings.set", { key: VM_SETTING_KEYS.defaultWorkspace, value: "vm" }, ik());
    expect(vm.workspaceFor({})).toBe("vm");
  });

  it("offers exec without a container backend only while VM mode is on", async () => {
    const { owner, services } = await stack(false);
    expect(services.tools.get("exec")).toBeUndefined();
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: true }, ik());
    await new Promise((r) => setTimeout(r, 20));
    expect(services.tools.get("exec")).toBeDefined();
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: false }, ik());
    await new Promise((r) => setTimeout(r, 20));
    expect(services.tools.get("exec")).toBeUndefined();
  });
});
