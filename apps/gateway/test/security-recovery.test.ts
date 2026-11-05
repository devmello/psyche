import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, insertDevice, openDb, setSetting } from "@psyche/db";
import type { SecurityStateStatus } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { PRESENCE_ENROLLED_SETTING } from "../src/presence-gate.ts";
import {
  adminClient,
  TestClient as Client,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

/**
 * The hardened `psyched` commands and the recovery route (docs/design/
 * security-state-integrity-2026.md §7.2), and the seal at work in a running Gateway (§7.1).
 */

let t: TestGateway | undefined;
const open: TestClient[] = [];
let offsetMs = 0;
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
  t = undefined;
  offsetMs = 0;
});

async function boot(): Promise<TestGateway> {
  const home = mkdtempSync(join(tmpdir(), "psyche-rec-"));
  t = await startTestGateway({
    home,
    config: { dbPath: join(home, "state", "psyche.sqlite") },
    now: () => new Date(Date.now() + offsetMs),
    security: { pollMs: 20 },
  });
  return t;
}

/** `psyched <args>` against the test Gateway's home. */
async function cli(args: string[], waitMs?: number): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const prev = process.env.PSYCHE_HOME;
  process.env.PSYCHE_HOME = t?.home ?? "";
  try {
    const code = await runCli(args, (l) => lines.push(l), {
      pollMs: 20,
      ...(waitMs === undefined ? {} : { waitMs }),
    });
    return { code, lines };
  } finally {
    if (prev === undefined) delete process.env.PSYCHE_HOME;
    else process.env.PSYCHE_HOME = prev;
  }
}

async function pendingCode(gw: TestGateway, deviceId: string) {
  const c = await Client.open(wsUrlOf(gw.gateway));
  open.push(c);
  const key = newDeviceKey();
  const res = await handshake(c, gw.gateway.origin, { key, deviceId });
  return { key, code: verified<{ code: string }>(res).code };
}

async function state(admin: TestClient): Promise<SecurityStateStatus> {
  return admin.call<SecurityStateStatus>("security.state.get", {});
}

describe("psyched commands once an admin exists", () => {
  it("devices approve waits 24 hours, shown on every device, and applies on time", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const { key, code } = await pendingCode(gw, "laptop");
    const r = await cli(["devices", "approve", code]);
    expect(r.code).toBe(3);
    expect(r.lines[0]).toMatch(/^waiting: this applies at /);
    expect(getDevice(gw.gateway.context.db, "laptop")?.pairedAt).toBeNull();
    const s = await state(admin);
    expect(s.recoveries[0]).toMatchObject({
      op: "devices.approve",
      status: "waiting",
      deviceId: "laptop",
    });
    expect(s.alerts.map((a) => a.kind)).toContain("recovery_requested");
    await admin.waitForEvent((e) => e.event === "security.state.changed");

    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(gw.gateway.context.db, "laptop")?.scopes).toContain("operator.admin");
    const c = await Client.open(wsUrlOf(gw.gateway));
    open.push(c);
    const res = await handshake(c, gw.gateway.origin, { key, deviceId: "laptop" });
    expect(verified<{ phase: string }>(res).phase).toBe("paired");
    const after = await state(admin);
    expect(after.recoveries[0]?.status).toBe("applied");
    expect(after.alerts.map((a) => a.kind)).toContain("recovery_applied");
    // The "waiting" alert is answered once the recovery is decided.
    expect(
      after.alerts.find((a) => a.kind === "recovery_requested")?.acknowledgedAt,
    ).not.toBeNull();
  });

  it("an admin can approve it now (with presence when enrolled) or cancel it", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const first = await pendingCode(gw, "tablet");
    await cli(["devices", "approve", first.code]);
    const [waiting] = (await state(admin)).recoveries;
    const approved = await admin.call<{ recovery: { status: string } }>(
      "security.recoveries.approve",
      { id: waiting?.id },
      ik(),
    );
    expect(approved.recovery.status).toBe("applied");
    expect(getDevice(gw.gateway.context.db, "tablet")?.pairedAt).not.toBeNull();

    const second = await pendingCode(gw, "phone");
    await cli(["devices", "approve", second.code, "operator.read"]);
    const pending = (await state(admin)).recoveries.find((x) => x.status === "waiting");
    const cancelled = await admin.call<{ recovery: { status: string } }>(
      "security.recoveries.cancel",
      { id: pending?.id },
      ik(),
    );
    expect(cancelled.recovery.status).toBe("cancelled");
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(gw.gateway.context.db, "phone")?.pairedAt).toBeNull();
  });

  it("approving now needs fresh presence once it is enrolled", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    setSetting(gw.gateway.context.db, PRESENCE_ENROLLED_SETTING, true);
    const { code } = await pendingCode(gw, "laptop");
    await cli(["devices", "approve", code]);
    const [waiting] = (await state(admin)).recoveries;
    const res = await admin.request("security.recoveries.approve", { id: waiting?.id }, ik());
    // No verifier can verify in this Gateway: fail closed, never admin alone.
    expect(res).toMatchObject({ ok: false, error: { code: "presence_required" } });
  });

  it("devices grant waits, narrowing too (it could empty the admin set for a first-admin grab)", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const db = gw.gateway.context.db;
    insertDevice(db, {
      id: "ipad",
      name: "iPad",
      platform: "ios",
      role: "client",
      publicKey: Buffer.alloc(32, 9),
      scopes: ["operator.read", "operator.write"],
      pairedAt: db.now(),
    });
    const wide = await cli(["devices", "grant", "ipad", "operator.read,operator.admin"]);
    expect(wide.code).toBe(3);
    expect(getDevice(db, "ipad")?.scopes).toEqual(["operator.read", "operator.write"]);
    const narrow = await cli(["devices", "grant", "ipad", "operator.read"]);
    expect(narrow.code).toBe(3);
    expect(getDevice(db, "ipad")?.scopes).toEqual(["operator.read", "operator.write"]);
  });

  it("no admin left but presence was enrolled: the first admin from the Mac waits too", async () => {
    const gw = await boot();
    setSetting(gw.gateway.context.db, PRESENCE_ENROLLED_SETTING, true);
    const { code } = await pendingCode(gw, "laptop");
    const r = await cli(["devices", "approve", code]);
    expect(r.code).toBe(3);
    expect(getDevice(gw.gateway.context.db, "laptop")?.pairedAt).toBeNull();
  });

  it("makes the first admin at once on a fresh install, with an alert", async () => {
    const gw = await boot();
    const { code } = await pendingCode(gw, "laptop");
    const r = await cli(["devices", "approve", code]);
    expect(r.code).toBe(0);
    expect(getDevice(gw.gateway.context.db, "laptop")?.scopes).toContain("operator.admin");
    expect(gw.gateway.context.securityState?.alerts.open().map((a) => a.kind)).toEqual([
      "local_first_admin",
    ]);
  });

  it("the same request again joins the waiting one; a flood of one kind cannot block another", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    setSetting(gw.gateway.context.db, PRESENCE_ENROLLED_SETTING, true);
    const a = await cli(["presence", "reset"]);
    const b = await cli(["presence", "reset"]);
    expect([a.code, b.code]).toEqual([3, 3]);
    expect(b.lines[0]).toMatch(/already waits/);
    expect((await state(admin)).recoveries.filter((r) => r.status === "waiting")).toHaveLength(1);
  });

  it("a re-seal cannot be cancelled from the Mac, and cancels from the Mac are visible", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const other = openDb(gw.gateway.context.db.path, { migrate: false });
    other.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32));
    other.close();
    expect((await state(admin)).status).toBe("untrusted");
    expect((await cli(["security", "reseal"])).code).toBe(3);
    const [reseal] = (await state(admin)).recoveries;
    const r = await cli(["recovery", "cancel", reseal?.id ?? ""]);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/only from an admin device Psyche still trusts/);
  });

  it("presence reset with nothing enrolled is a no-op; reseal of a sealed state too", async () => {
    await boot();
    expect((await cli(["presence", "reset"])).lines[0]).toMatch(/nothing to reset/);
    const r = await cli(["security", "reseal"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/sealed; nothing to do/);
    const s = await cli(["security", "status"]);
    expect(s.lines[0]).toMatch(/^security records: sealed/);
  });

  it("without a running Gateway nothing changes and the request is taken back", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-rec-off-"));
    const prev = process.env.PSYCHE_HOME;
    process.env.PSYCHE_HOME = home;
    const lines: string[] = [];
    try {
      const code = await runCli(["presence", "reset"], (l) => lines.push(l), {
        waitMs: 100,
        pollMs: 20,
      });
      expect(code).toBe(4);
    } finally {
      if (prev === undefined) delete process.env.PSYCHE_HOME;
      else process.env.PSYCHE_HOME = prev;
    }
    expect(lines[0]).toMatch(/did not answer, so nothing changed/);
    const db = openDb(join(home, "state", "psyche.sqlite"));
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM security_requests").get()).toEqual({
      n: 0,
    });
    db.close();
  });
});

describe("the seal in a running Gateway", () => {
  it("a device row written by another program cannot connect, and every device is told", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const key = newDeviceKey();
    const other = openDb(gw.gateway.context.db.path, { migrate: false });
    insertDevice(other, {
      id: "rogue",
      name: "rogue",
      platform: "macos",
      role: "client",
      publicKey: key.publicKey,
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      pairedAt: other.now(),
    });
    other.close();
    const c = await Client.open(wsUrlOf(gw.gateway));
    open.push(c);
    const res = await handshake(c, gw.gateway.origin, { key, deviceId: "rogue" });
    expect(res.verifyRes).toMatchObject({ payload: { phase: "denied", code: "device_revoked" } });
    const s = await state(admin);
    expect(s.status).toBe("sealed");
    const [alert] = s.alerts;
    expect(alert).toMatchObject({ kind: "state_changed_outside", severity: "warning" });
    expect(alert?.details.changes).toEqual([{ table: "devices", change: "added", name: "rogue" }]);
    // An admin reviews it (presence is not enrolled here, so admin alone).
    const ack = await admin.call<{ alert: { acknowledgedAt: string | null } }>(
      "security.alerts.acknowledge",
      { id: alert?.id },
      ik(),
    );
    expect(ack.alert.acknowledgedAt).not.toBeNull();
  });

  it("a widened scope on a live connection is undone before the next call", async () => {
    const gw = await boot();
    const key = newDeviceKey();
    const c = await Client.open(wsUrlOf(gw.gateway));
    open.push(c);
    await handshake(c, gw.gateway.origin, {
      key,
      deviceId: "desk",
      handshakeSecret: gw.gateway.handshakeSecret,
    });
    const other = openDb(gw.gateway.context.db.path, { migrate: false });
    other.sqlite
      .prepare("UPDATE devices SET scopes = ? WHERE id = 'desk'")
      .run(
        JSON.stringify(["operator.read", "operator.write", "operator.approvals", "operator.admin"]),
      );
    other.close();
    const res = await c.request("devices.list", {});
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("an untrusted state blocks widening and acknowledging, and a re-seal waits a day", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const other = openDb(gw.gateway.context.db.path, { migrate: false });
    other.sqlite.prepare("UPDATE security_seal SET agg = ?").run("00".repeat(32));
    other.close();
    const s = await state(admin);
    expect(s).toMatchObject({ status: "untrusted", reason: "seal_forged" });
    const untrusted = s.alerts.find((a) => a.kind === "state_untrusted");
    const ack = await admin.request("security.alerts.acknowledge", { id: untrusted?.id }, ik());
    expect(ack).toMatchObject({
      ok: false,
      error: { code: "presence_required", details: { reason: "state_untrusted" } },
    });
    const { code } = await pendingCode(gw, "laptop");
    const approve = await admin.request(
      "devices.approve",
      {
        pairingRequestId: gw.gateway.context.db.sqlite
          .prepare("SELECT id FROM pairing_requests WHERE code = ?")
          .pluck()
          .get(code),
        scopes: ["operator.read"],
      },
      ik(),
    );
    expect(approve).toMatchObject({ ok: false, error: { code: "presence_required" } });

    const r = await cli(["security", "reseal"]);
    expect(r.code).toBe(3);
    const [waiting] = (await state(admin)).recoveries;
    expect(
      await admin.request("security.recoveries.approve", { id: waiting?.id }, ik()),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect((await state(admin)).status).toBe("sealed");
  });
});
