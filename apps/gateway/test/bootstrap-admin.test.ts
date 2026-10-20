import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, listPairingRequests, updateDevice } from "@psyche/db";
import type { AuditEntry } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { approvePairing } from "../src/handlers/devices.ts";
import { silentLogger } from "../src/log.ts";
import {
  type TestClient as Client,
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

async function desktop(gw: ComposedGateway, deviceId: string): Promise<Client> {
  const c = await desktopClient(gw.gateway, newDeviceKey(), deviceId);
  clients.push(c);
  return c;
}

const admins = (gw: ComposedGateway) =>
  ["d1", "d2", "d3"].filter((id) => getDevice(gw.db, id)?.scopes.includes("operator.admin"));

async function bootstrapEvents(c: Client): Promise<AuditEntry[]> {
  const res = await c.call<{ entries: AuditEntry[] }>("audit.list", {
    kind: "device.bootstrap_admin",
  });
  return res.entries;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "psyche-bootstrap-")));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop();
  composed = undefined;
  await rm(home, { recursive: true, force: true });
});

describe("devices.bootstrapAdmin", () => {
  it("grants the first desktop admin once, audited, and is inert afterwards", async () => {
    const gw = await compose();
    const first = await desktop(gw, "d1");
    const res = await first.call<{ device: { id: string; scopes: string[] } }>(
      "devices.bootstrapAdmin",
      {},
      ik(),
    );
    expect(res.device.id).toBe("d1");
    expect(res.device.scopes).toContain("operator.admin");
    // Scopes are re-read per request: the same connection is admin now.
    expect((await first.request("devices.list", {})).ok).toBe(true);
    const events = await bootstrapEvents(first);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: "device", deviceId: "d1" } });

    // Never again: another desktop shell (or the same one) gets conflict.
    const second = await desktop(gw, "d2");
    expect(await second.request("devices.bootstrapAdmin", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await first.request("devices.bootstrapAdmin", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(admins(gw)).toEqual(["d1"]);
    expect(await bootstrapEvents(first)).toHaveLength(1);
  });

  it("lets exactly one of two racing desktops win", async () => {
    const gw = await compose();
    const a = await desktop(gw, "d1");
    const b = await desktop(gw, "d2");
    const results = await Promise.all([
      a.request("devices.bootstrapAdmin", {}, ik()),
      b.request("devices.bootstrapAdmin", {}, ik()),
    ]);
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(
      results.filter((r) => (r.error as { code?: string } | undefined)?.code === "conflict"),
    ).toHaveLength(1);
    expect(admins(gw)).toHaveLength(1);
  });

  it("stays inert when an admin was granted another way", async () => {
    const gw = await compose();
    const c = await desktop(gw, "d1");
    updateDevice(gw.db, "d1", {
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
    const other = await desktop(gw, "d2");
    expect(await other.request("devices.bootstrapAdmin", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await bootstrapEvents(c)).toHaveLength(0);
  });

  it("refuses any caller that is not the desktop shell's own connection", async () => {
    const gw = await compose();
    // A device paired by approval (no handshake secret) with operator.write.
    const key = newDeviceKey();
    const phone = await TestClient.open(wsUrlOf(gw.gateway));
    clients.push(phone);
    await handshake(phone, gw.gateway.origin, { key, deviceId: "p1", deviceFamily: "ios-app" });
    const request = listPairingRequests(gw.db, { status: "pending" })[0];
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
    await handshake(again, gw.gateway.origin, { key, deviceId: "p1", deviceFamily: "ios-app" });
    expect(await again.request("devices.bootstrapAdmin", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(getDevice(gw.db, "p1")?.scopes).not.toContain("operator.admin");
  });
});
