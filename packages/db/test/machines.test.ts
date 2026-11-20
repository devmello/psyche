import { describe, expect, it } from "vitest";
import {
  consumeSetupToken,
  createSetupToken,
  deleteMachineByDevice,
  getMachineByDevice,
  insertDevice,
  insertMachine,
  markMachineAnnounced,
  setupTokenPurposeOf,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

describe("machine setup tokens", () => {
  it("a machine token is exactly [node]; a device token never has node", () => {
    const db = memoryDb();
    expect(() => createSetupToken(db, { purpose: "machine", scopes: ["operator.read"] })).toThrow(
      /no scopes/,
    );
    expect(() => createSetupToken(db, { scopes: ["node"] })).toThrow(/operator scopes only/);
    expect(() => createSetupToken(db, {})).toThrow(/operator scopes only/);
    expect(createSetupToken(db, { purpose: "machine" }).record).toMatchObject({
      scopes: ["node"],
      purpose: "machine",
    });
  });

  it("is spent only by the purpose it was made for, and stays live otherwise", () => {
    const db = memoryDb();
    const machine = createSetupToken(db, { purpose: "machine" });
    const device = createSetupToken(db, { scopes: ["operator.admin"] });
    expect(consumeSetupToken(db, machine.token, "d1", db.now(), "device")).toBeUndefined();
    expect(consumeSetupToken(db, device.token, "d1", db.now(), "machine")).toBeUndefined();
    expect(consumeSetupToken(db, machine.token, "d1", db.now(), "machine")).toMatchObject({
      scopes: ["node"],
      purpose: "machine",
    });
    // Replay.
    expect(consumeSetupToken(db, machine.token, "d2", db.now(), "machine")).toBeUndefined();
    // "any" spends whatever it is (a paired device burning a link).
    expect(consumeSetupToken(db, device.token, "d1", db.now(), "any")).toMatchObject({
      purpose: "device",
    });
  });

  it("a row whose scopes are a mix pairs nobody", () => {
    expect(setupTokenPurposeOf(["node"])).toBe("machine");
    expect(setupTokenPurposeOf(["operator.read"])).toBe("device");
    for (const mixed of [[], ["node", "operator.read"], ["node", "node"], ["bogus"]]) {
      expect(setupTokenPurposeOf(mixed)).toBeUndefined();
    }
    const db = memoryDb();
    const { token } = createSetupToken(db, { purpose: "machine" });
    db.sqlite.prepare('UPDATE setup_tokens SET scopes = \'["node","operator.admin"]\'').run();
    expect(consumeSetupToken(db, token, "d1", db.now(), "any")).toBeUndefined();
  });
});

describe("machines table", () => {
  const box = (db: ReturnType<typeof memoryDb>) =>
    insertDevice(db, {
      id: "d1",
      name: "box",
      platform: "linux",
      role: "node",
      publicKey: "AAAA",
      scopes: ["node"],
      pairedAt: db.now(),
    });

  it("records one decision per device, announces once, and goes with a delete", () => {
    const db = memoryDb();
    box(db);
    const first = insertMachine(db, {
      deviceId: "d1",
      approvedByDeviceId: null,
      via: "setup_token",
    });
    const again = insertMachine(db, {
      deviceId: "d1",
      approvedByDeviceId: null,
      via: "pairing_card",
    });
    expect(again.id).toBe(first.id);
    expect(markMachineAnnounced(db, "d1")).toBe(true);
    expect(markMachineAnnounced(db, "d1")).toBe(false);
    expect(getMachineByDevice(db, "d1")?.via).toBe("setup_token");
    expect(deleteMachineByDevice(db, "d1")).toBe(true);
    expect(getMachineByDevice(db, "d1")).toBeUndefined();
  });

  it("nodes.kind accepts machine and nothing invented", () => {
    const db = memoryDb();
    box(db);
    const ins = (kind: string) =>
      db.sqlite
        .prepare(
          "INSERT INTO nodes (id, device_id, kind, created_at, updated_at) VALUES (?, 'd1', ?, 't', 't')",
        )
        .run(`n-${kind}`, kind);
    ins("machine");
    expect(() => ins("bogus")).toThrow(/CHECK/);
  });
});
