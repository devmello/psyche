import type { ApprovalKind } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { bindingFor, bindingHash, MACHINE_CARD_KINDS, machineRefOf } from "../src/index.ts";
import { CTX, makeBroker } from "./helpers.ts";

/**
 * Wave H4 (docs/design/linux-helper-only-2026.md 6.2): a computer-use approval binds the machine
 * it is for, so a card or grant for one machine never covers the Host or another machine.
 */

const base = { app: "org.gnome.TextEditor", tierRequired: "interact", action: "type" } as const;

describe("computer_action bindings include the machine", () => {
  it("leaves the Host's binding exactly as it was", () => {
    const b = bindingFor("computer_action", base);
    expect(b.fields).toEqual(base);
    expect(b.bindingHash).toBe(bindingHash("computer_action", base));
    expect(b.grantFields).toEqual({ app: base.app, tierRequired: base.tierRequired });
  });

  it("gives the Host, machine A and machine B three bindings and three grant keys", () => {
    const host = bindingFor("computer_action", base);
    const a = bindingFor("computer_action", { ...base, machine: "dev_A" });
    const b = bindingFor("computer_action", { ...base, machine: "dev_B" });
    expect(new Set([host.bindingHash, a.bindingHash, b.bindingHash]).size).toBe(3);
    expect(new Set([host.grantKey, a.grantKey, b.grantKey]).size).toBe(3);
    expect(a.fields).toMatchObject({ machine: "dev_A" });
    expect(a.grantFields).toMatchObject({ machine: "dev_A" });
  });

  it.each([[""], [5], [null], [{ deviceId: "dev_A" }]])("refuses machine %j", (machine) => {
    expect(() => bindingFor("computer_action", { ...base, machine })).toThrow(/machine/);
  });
});

describe("machineRefOf", () => {
  it.each([
    [{ deviceId: "01JDEV", name: "lab-box" }],
    [{ deviceId: "dev_A-1", name: "Lab Box 2" }],
    [{ deviceId: "a".repeat(64), name: "ラボ" }],
  ])("must allow %j", (v) => {
    expect(machineRefOf(v)).toEqual(v);
  });

  it("keeps only the two fields", () => {
    expect(machineRefOf({ deviceId: "dev_A", name: "lab-box", local: true })).toEqual({
      deviceId: "dev_A",
      name: "lab-box",
    });
  });

  it.each([
    ["no device id", { name: "lab-box" }],
    ["an empty device id", { deviceId: "", name: "lab-box" }],
    ["a path as device id", { deviceId: "../dev", name: "lab-box" }],
    ["a spaced device id", { deviceId: "dev A", name: "lab-box" }],
    ["a long device id", { deviceId: "a".repeat(65), name: "lab-box" }],
    ["no name", { deviceId: "dev_A" }],
    ["an empty name", { deviceId: "dev_A", name: "" }],
    ["a name with a control character", { deviceId: "dev_A", name: "lab\u0007box" }],
    ["a name with a bidi override", { deviceId: "dev_A", name: "lab‮box" }],
    ["a name with a zero-width space", { deviceId: "dev_A", name: "lab​box" }],
    ["a name with a leading space", { deviceId: "dev_A", name: " lab-box" }],
    ["a 65-character name", { deviceId: "dev_A", name: "x".repeat(65) }],
    ["a number", 5],
    ["null", null],
    ["an array", [{ deviceId: "dev_A", name: "lab-box" }]],
  ])("must refuse %s", (_label, v) => {
    expect(machineRefOf(v)).toBeUndefined();
  });
});

describe("approval cards name the machine", () => {
  async function card(kind: ApprovalKind, machine: unknown) {
    const h = makeBroker();
    const issued = await h.broker.requestApproval({
      kind,
      summary: "On lab-box: type",
      details: {},
      bindingHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      grantKey: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
      machine: machine as never,
    });
    return issued.approval;
  }

  it.each([...MACHINE_CARD_KINDS])("must allow: a %s card carries its machine", async (kind) => {
    const a = await card(kind, { deviceId: "dev_A", name: "lab-box" });
    expect(a.machine).toEqual({ deviceId: "dev_A", name: "lab-box" });
  });

  it.each([
    ["a kind that never runs on a machine", "send_email", { deviceId: "dev_A", name: "lab-box" }],
    ["a connector action", "connector_action", { deviceId: "dev_A", name: "lab-box" }],
    ["a malformed name", "computer_action", { deviceId: "dev_A", name: "lab‮box" }],
    ["a malformed device id", "computer_action", { deviceId: "a b", name: "lab-box" }],
    ["no machine", "computer_action", undefined],
  ] as const)("must refuse: %s names no machine", async (_label, kind, machine) => {
    const a = await card(kind, machine);
    expect(a.machine).toBeUndefined();
  });
});
