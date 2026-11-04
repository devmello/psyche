import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, listPairingRequests } from "@psyche/db";
import type { AuditEntry } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { approvePairing } from "../src/handlers/devices.ts";
import { silentLogger } from "../src/log.ts";
import {
  type TestClient as Client,
  type DeviceKey,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  wsUrlOf,
} from "./helpers.ts";

let home: string;
let composed: ComposedGateway | undefined;
const clients: Client[] = [];

async function compose(): Promise<ComposedGateway> {
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

/** A phone paired by owner approval with only `operator.read` and `operator.write`. */
async function pairPhone(gw: ComposedGateway, id: string, key: DeviceKey): Promise<Client> {
  const first = await TestClient.open(wsUrlOf(gw.gateway));
  clients.push(first);
  await handshake(first, gw.gateway.origin, { key, deviceId: id, deviceFamily: "ios-app" });
  const request = listPairingRequests(gw.db, { status: "pending" }).find((r) => r.deviceId === id);
  if (!request) throw new Error("no pending request");
  gw.db.sqlite.transaction(() =>
    approvePairing(gw.db, {
      pairingRequestId: request.id,
      scopes: ["operator.read", "operator.write"],
      code: request.code,
      decidedByDeviceId: null,
    }),
  )();
  const again = await TestClient.open(wsUrlOf(gw.gateway));
  clients.push(again);
  const res = await handshake(again, gw.gateway.origin, {
    key,
    deviceId: id,
    deviceFamily: "ios-app",
  });
  expect(res.verifyRes?.payload).toMatchObject({ phase: "paired" });
  return again;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-revoke-self-")));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("devices.revokeSelf", () => {
  it("lets a non-admin phone remove only itself, audited, and answers before closing", async () => {
    const gw = await compose();
    const desk = await desktopClient(gw.gateway, newDeviceKey(), "desk-1");
    clients.push(desk);
    const phoneKey = newDeviceKey();
    const phone = await pairPhone(gw, "phone-1", phoneKey);
    const other = await pairPhone(gw, "phone-2", newDeviceKey());

    // A non-admin cannot name another device.
    expect(await phone.request("devices.revoke", { deviceId: "phone-2" }, ik())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(getDevice(gw.db, "phone-2")?.revokedAt).toBeNull();

    const res = await phone.request("devices.revokeSelf", {}, ik());
    expect(res.ok).toBe(true);
    expect(
      (res.payload as { device: { id: string; revokedAt: string | null } }).device,
    ).toMatchObject({
      id: "phone-1",
    });
    expect(getDevice(gw.db, "phone-1")?.revokedAt).not.toBeNull();
    // Nobody else was touched.
    expect(getDevice(gw.db, "phone-2")?.revokedAt).toBeNull();
    expect(getDevice(gw.db, "desk-1")?.revokedAt).toBeNull();
    expect((await other.request("threads.list", {})).ok).toBe(true);

    const audit = await desk.call<{ entries: AuditEntry[] }>("audit.list", {
      kind: "device.revoked_self",
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actor: { type: "device", deviceId: "phone-1" },
      data: { deviceId: "phone-1" },
    });
  });

  it("makes a later connect from the revoked device a denial with code device_revoked", async () => {
    const gw = await compose();
    const key = newDeviceKey();
    const phone = await pairPhone(gw, "phone-1", key);
    expect((await phone.request("devices.revokeSelf", {}, ik())).ok).toBe(true);

    const again = await TestClient.open(wsUrlOf(gw.gateway));
    clients.push(again);
    const res = await handshake(again, gw.gateway.origin, {
      key,
      deviceId: "phone-1",
      deviceFamily: "ios-app",
    });
    expect(res.verifyRes?.payload).toMatchObject({
      phase: "denied",
      reason: "device revoked",
      code: "device_revoked",
    });
  });
});
