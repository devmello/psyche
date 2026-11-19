import { openDb, setSetting } from "@psyche/db";
import { VM_SETTING_KEYS } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { VmRunner } from "../src/compose/vm.ts";
import type { Gateway } from "../src/server.ts";

/**
 * The sandbox guest's own `vm.exec` receipt names the standing grant that let the command
 * through, with the call's binding, the way the loop's receipt does: a resume's done check
 * reads both. The guest node is a fake behind the runner's real VM-mode checks.
 */

function runner() {
  const db = openDb(":memory:");
  setSetting(db, VM_SETTING_KEYS.enabled, true);
  setSetting(db, VM_SETTING_KEYS.guestNodeId, "guest");
  const broker = new FakePermissionBroker({ armDelayMs: 0 });
  const client = {
    invoke: async () => ({
      ok: true,
      result: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        truncated: false,
        filesChanged: [],
        timedOut: false,
        outcome: "ok",
      },
      receipt: { outcome: "ok", summary: "ls exited 0" },
    }),
  };
  const nodes = {
    list: () => [{ id: "guest", capabilities: [{ name: "exec" }] }],
    isLive: () => true,
    transportOf: () => "vm-relay",
    client: () => client,
  };
  const gateway = { context: { nodes } } as unknown as Gateway;
  const services = { db, broker } as unknown as ComposeServices;
  return {
    vm: new VmRunner(
      services,
      () => gateway,
      () => "running",
    ),
    broker,
  };
}

async function exec(grant?: { id: string; bindingHash: string }) {
  const { vm, broker } = runner();
  const sandbox = await vm.ensureSandbox({ kind: "task", id: "task_1" });
  await vm.exec({
    sandboxId: sandbox.id,
    argv: ["ls"],
    cwd: "/workspace",
    timeoutMs: 1000,
    ...(grant === undefined ? {} : { grant }),
  });
  return (await broker.listReceipts({ taskId: "task_1" })).find((r) => r.kind === "vm.exec");
}

describe("vm.exec receipts and the standing grant", () => {
  it("a command a grant let through: the receipt names the grant and the call's binding", async () => {
    const r = await exec({ id: "grt_7", bindingHash: "sha256:cc" });
    expect(r).toMatchObject({
      taskId: "task_1",
      outcome: "ok",
      payload: { grantId: "grt_7", bindingHash: "sha256:cc" },
    });
  });

  it("positive control: without a grant the receipt names none", async () => {
    const r = await exec();
    expect(r?.taskId).toBe("task_1");
    expect(r?.payload?.grantId).toBeUndefined();
  });
});
