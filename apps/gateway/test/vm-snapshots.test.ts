import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VM_SETTING_KEYS, type VmGuest, type VmSnapshot, type VmStatus } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedVm, composeVm } from "../src/compose/vm.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode } from "./fake-node.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * L6, Gateway side: the owner's `vm.snapshots.*` and the per-Task reset over a fake mac helper
 * (S14's `vm.snapshot` / `vm.restore` / `vm.reset` / `vm.snapshot_delete`). No guest is booted.
 */

const snap = (id: string, kind: VmSnapshot["kind"]): VmSnapshot => ({
  id,
  label: id,
  kind,
  createdAt: "2026-10-20T00:00:00.000Z",
  guestOS: "27.0",
  bytes: 1024,
  savedState: false,
  provisioned: true,
  psycheInstalled: true,
  method: "apfs-clone",
});

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

async function stack(opts: { failReset?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), "psyche-vmsnap-"));
  let vm: ComposedVm | undefined;
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        vm = composeVm(s, { pollMs: 0 });
        return vm;
      },
    ],
  });
  const c = composed;
  // The fake helper's one guest: stop, reset and start move it like the real one.
  const state = {
    phase: "running" as VmGuest["phase"],
    snapshots: [snap("fresh", "base")],
    base: "fresh" as string | undefined,
  };
  const guest = (): VmGuest => ({
    name: "sandbox",
    phase: state.phase,
    provisioned: true,
    cpus: 4,
    memoryGB: 8,
    diskGB: 80,
    guestOS: "27.0",
    username: "psyche",
    shares: [],
    vsock: { hostCid: 2, gatewayNodePort: 7980 },
    snapshots: state.snapshots,
    ...(state.base === undefined ? {} : { baseSnapshot: state.base }),
  });
  const refuseActive = () => {
    if (state.phase === "running") throw new Error("the guest is running");
  };
  const restored = (snapshot: string) => {
    refuseActive();
    if (opts.failReset === true) throw new Error("clone failed");
    state.phase = "stopped";
    return { guest: guest(), snapshot, durationMs: 40 };
  };
  const cap = (name: string, run: (p: Record<string, unknown>) => unknown) => ({
    capability: { name, sideEffect: "write" as const, streaming: false },
    run: (p: unknown) => run(p as Record<string, unknown>),
  });
  const helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    handlers: [
      {
        capability: { name: "vm.status", sideEffect: "read", streaming: false },
        run: (): VmStatus => ({
          guests: [guest()],
          active: state.phase === "running" ? 1 : 0,
          maxActive: 2,
          supportsGuestProvisioning: true,
        }),
      },
      cap("vm.stop", () => {
        state.phase = "stopped";
        return { graceful: true };
      }),
      cap("vm.start", () => {
        state.phase = "running";
        return { guest: guest() };
      }),
      cap("vm.snapshot", (p) => {
        refuseActive();
        const s = { ...snap(`s${state.snapshots.length}`, p.kind as VmSnapshot["kind"]) };
        if (s.kind === "base") state.base = s.id;
        state.snapshots = [s, ...state.snapshots];
        return { snapshot: s, guest: guest() };
      }),
      cap("vm.restore", (p) => restored(p.snapshot as string)),
      cap("vm.reset", () => restored(state.base ?? "")),
      cap("vm.snapshot_delete", (p) => {
        state.snapshots = state.snapshots.filter((s) => s.id !== p.snapshot);
        return { deleted: true };
      }),
    ],
  });
  const guestNode = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceId: "guest-psyche-node",
    handlers: [{ capability: { name: "exec", sideEffect: "write", streaming: true } }],
  });
  nodes.push(helper, guestNode);
  const owner = await adminClient(c.gateway);
  clients.push(owner);
  const on = async () => {
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: true }, ik());
    await owner.call(
      "settings.set",
      { key: VM_SETTING_KEYS.guestNodeId, value: guestNode.nodeId },
      ik(),
    );
    await (vm as ComposedVm).refresh();
  };
  const calls = () =>
    helper.invocations.map((i) => i.capability).filter((name) => name !== "vm.status");
  return { c, owner, vm: vm as ComposedVm, helper, state, on, calls };
}

describe("VM snapshots and resets, Gateway side (L6)", () => {
  it("serves the owner's vm.snapshots.* over the helper, audited, behind VM mode", async () => {
    const { c, owner, on, calls, state } = await stack();
    await expect(owner.call("vm.snapshots.list", {})).rejects.toThrow(/vm_disabled/);
    await on();
    expect(await owner.call("vm.snapshots.list", {})).toEqual({
      snapshots: [snap("fresh", "base")],
      baseSnapshot: "fresh",
    });

    // The helper refuses a running guest for a snapshot; the owner stops it first.
    await expect(owner.call("vm.snapshots.create", { label: "before" }, ik())).rejects.toThrow(
      /the guest is running/,
    );
    state.phase = "stopped";
    const made = await owner.call<{ snapshot: VmSnapshot }>(
      "vm.snapshots.create",
      { label: "clean", base: true },
      ik(),
    );
    expect(made.snapshot.kind).toBe("base");
    expect(state.base).toBe(made.snapshot.id);

    // A reset of a running guest stops it, resets and starts it again.
    state.phase = "running";
    await owner.call("vm.snapshots.list", {});
    const reset = await owner.call<{ snapshot: string }>("vm.snapshots.reset", {}, ik());
    expect(reset.snapshot).toBe(made.snapshot.id);
    expect(state.phase).toBe("running");
    await owner.call("vm.snapshots.restore", { snapshot: "fresh" }, ik());
    await owner.call("vm.snapshots.delete", { snapshot: "fresh" }, ik());
    expect(calls()).toEqual([
      "vm.snapshot",
      "vm.snapshot",
      "vm.stop",
      "vm.reset",
      "vm.start",
      "vm.stop",
      "vm.restore",
      "vm.start",
      "vm.snapshot_delete",
    ]);
    const receipts = (await c.broker.listReceipts()).filter((r) => r.kind === "vm.snapshot");
    expect(receipts.map((r) => [r.payload?.action, r.outcome])).toEqual(
      expect.arrayContaining([
        ["create", "failed"],
        ["create", "ok"],
        ["reset", "ok"],
        ["restore", "ok"],
        ["delete", "ok"],
      ]),
    );
    expect(receipts).toHaveLength(5);
    // Each change is published.
    await owner.waitForEvent(
      (e) =>
        e.event === "vm.updated" &&
        ((e.payload as { guest: VmGuest }).guest.snapshots ?? []).every((s) => s.id !== "fresh"),
    );
  });

  it("resets the guest once before a vm Task's first command with vm.resetPerTask on", async () => {
    const { c, owner, vm, on, calls } = await stack();
    await on();
    await vm.runner.ensureSandbox({ kind: "task", id: "task_a" });
    expect(calls()).toEqual([]);

    await owner.call("settings.set", { key: VM_SETTING_KEYS.resetPerTask, value: true }, ik());
    await vm.runner.ensureSandbox({ kind: "task", id: "task_b" });
    await vm.runner.ensureSandbox({ kind: "task", id: "task_b" });
    // A thread's commands are not a Task: no reset.
    await vm.runner.ensureSandbox({ kind: "thread", id: "thr_1" });
    expect(calls()).toEqual(["vm.stop", "vm.reset", "vm.start"]);
    const receipts = await c.broker.listReceipts({ taskId: "task_b" });
    expect(receipts.map((r) => [r.kind, r.payload?.action, r.outcome])).toEqual([
      ["vm.snapshot", "task_reset", "ok"],
    ]);
  });

  it("never runs a Task's command on an unreset guest: a failed reset fails it", async () => {
    const { c, owner, vm, on, calls } = await stack({ failReset: true });
    await on();
    await owner.call("settings.set", { key: VM_SETTING_KEYS.resetPerTask, value: true }, ik());
    await expect(vm.runner.ensureSandbox({ kind: "task", id: "task_c" })).rejects.toMatchObject({
      code: "internal",
      details: { reason: "vm_helper_failed", capability: "vm.reset" },
    });
    // Tried again by the next command, never skipped.
    await expect(vm.runner.ensureSandbox({ kind: "task", id: "task_c" })).rejects.toMatchObject({
      details: { capability: "vm.reset" },
    });
    expect(calls().filter((n) => n === "vm.reset")).toHaveLength(2);
    const receipts = await c.broker.listReceipts({ taskId: "task_c" });
    expect(receipts.map((r) => r.outcome)).toEqual(["failed", "failed"]);
  });

  it("refuses a per-Task reset while another Task is working in the guest", async () => {
    const { c, owner, vm, on } = await stack();
    await on();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const busy = await c.tasks.create({
      threadId: thread.id,
      title: "Busy",
      goal: "Work in the guest",
      createdFrom: "chat",
      workspace: "vm",
    });
    await vm.runner.ensureSandbox({ kind: "task", id: busy.id });
    await owner.call("settings.set", { key: VM_SETTING_KEYS.resetPerTask, value: true }, ik());
    await expect(vm.runner.ensureSandbox({ kind: "task", id: "task_d" })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "vm_in_use" },
    });
  });
});
