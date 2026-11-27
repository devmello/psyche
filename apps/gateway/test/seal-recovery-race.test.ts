import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairingRequest, getDevice, insertDevice, openDb, type PsycheDb } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../src/auth.ts";
import { SecurityRecoveries } from "../src/security/recoveries.ts";
import { StateSeal } from "../src/security/state-seal.ts";

/**
 * A `security_recoveries` row another connection inserts after `seal.ensure()` verified and
 * before the recovery code reads it. While sealed, `genuine()` vouches for every row, so before
 * the fix such a row applied in the same poll (`state_changed_outside, recovery_applied`). Now a
 * recovery is applied, approved or cancelled only from the row the Gateway itself committed.
 */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];
let clock = Date.parse("2026-01-01T00:00:00Z");
const DELAY = 5_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-race-"));
  dbPath = join(home, "psyche.sqlite");
  clock = Date.parse("2026-01-01T00:00:00Z");
});
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const d = openDb(dbPath);
  open.push(d);
  const seal = await StateSeal.open(d, { home, now: () => new Date(clock) });
  let presence: "off" | "ready" = "ready";
  let forgot = 0;
  const rec = new SecurityRecoveries({
    db: d,
    seal,
    now: () => new Date(clock),
    delayMs: DELAY,
    presence: {
      state: () => presence,
      forget: () => {
        forgot++;
        presence = "off";
      },
    },
  });
  return { d, seal, rec, forgot: () => forgot };
}

/** Another program on the Mac, through its own connection (no seal, no triggers). */
function foreign(fn: (f: PsycheDb) => void): void {
  const f = openDb(dbPath, { migrate: false });
  try {
    fn(f);
  } finally {
    f.close();
  }
}

function plantRecovery(id: string, op: string, params: unknown, notBefore = ""): void {
  foreign((f) => {
    const at = new Date(clock).toISOString();
    f.sqlite
      .prepare(
        "INSERT INTO security_recoveries (id, op, params, status, seen_at, not_before, created_at, updated_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)",
      )
      .run(id, op, JSON.stringify(params), at, notBefore, at, at);
  });
}

/** What `psyched presence reset` does: a request row in the inbox. */
function cliRequest(id: string, op: string, params: unknown = {}): void {
  foreign((f) => {
    const at = new Date(clock).toISOString();
    f.sqlite
      .prepare(
        "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)",
      )
      .run(id, op, JSON.stringify(params), at, at);
  });
}

const alertKinds = (d: PsycheDb) =>
  (
    d.sqlite.prepare("SELECT kind FROM security_alerts ORDER BY created_at, id").all() as {
      kind: string;
    }[]
  ).map((a) => a.kind);

/** A device the Gateway created from a network pairing request: genuine, not paired yet. */
function pendingDevice(d: PsycheDb) {
  const publicKey = randomBytes(32).toString("base64url");
  return insertDevice(d, {
    id: "stranger",
    name: "stranger",
    platform: "macos",
    role: "client",
    publicKey,
    scopes: [],
  });
}

describe("a foreign recovery row between the seal check and apply", () => {
  it("presence.reset: never applied in the same poll, and gone after the next check", async () => {
    const { d, seal, rec, forgot } = await setup();
    rec.tick();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {});
    rec.tick();
    expect(forgot()).toBe(0);
    expect(alertKinds(d)).not.toContain("recovery_applied");
    // The next poll's check removes it and says so; nothing was applied meanwhile.
    seal.ensure();
    rec.tick();
    expect(forgot()).toBe(0);
    expect(d.sqlite.prepare("SELECT id FROM security_recoveries").all()).toEqual([]);
    expect(alertKinds(d)).toContain("state_changed_outside");
    expect(alertKinds(d)).not.toContain("recovery_applied");
  });

  it("devices.approve on a device row the Gateway made: never applied, no admin granted", async () => {
    const { d, seal, rec } = await setup();
    const dev = pendingDevice(d);
    rec.tick();
    seal.ensure();
    plantRecovery("planted", "devices.approve", {
      deviceId: dev.id,
      deviceName: dev.name,
      fingerprint: keyFingerprint(dev.publicKey),
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
    rec.tick();
    expect(getDevice(d, dev.id)?.pairedAt).toBeNull();
    expect(getDevice(d, dev.id)?.scopes).toEqual([]);
    expect(alertKinds(d)).not.toContain("recovery_applied");
  });

  it("applyDue called straight after the planted insert applies nothing either", async () => {
    const { d, seal, rec, forgot } = await setup();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {});
    expect(rec.applyDue()).toBe(0);
    expect(forgot()).toBe(0);
    expect(alertKinds(d)).not.toContain("recovery_applied");
  });

  it("a genuine row changed outside (params, not_before) is not applied from the changed row", async () => {
    const { d, seal, rec } = await setup();
    const dev = pendingDevice(d);
    // A genuine waiting devices.grant-like recovery is hard to make without a paired device;
    // a genuine presence.reset waits, and the foreign write turns it into a device approval due now.
    cliRequest("q1", "presence.reset");
    rec.tick();
    const id = d.sqlite.prepare("SELECT id FROM security_recoveries").pluck().get() as string;
    seal.ensure();
    foreign((f) =>
      f.sqlite
        .prepare("UPDATE security_recoveries SET op = ?, params = ?, not_before = '' WHERE id = ?")
        .run(
          "devices.approve",
          JSON.stringify({
            deviceId: dev.id,
            fingerprint: keyFingerprint(dev.publicKey),
            scopes: ["operator.admin"],
          }),
          id,
        ),
    );
    rec.tick();
    expect(getDevice(d, dev.id)?.pairedAt).toBeNull();
    expect(alertKinds(d)).not.toContain("recovery_applied");
    // The next check puts the genuine row back; it still waits for its own time.
    seal.ensure();
    rec.tick();
    expect(
      d.sqlite.prepare("SELECT op, status FROM security_recoveries WHERE id = ?").get(id),
    ).toEqual({ op: "presence.reset", status: "waiting" });
  });

  it("approveNow on a planted row id is refused and applies nothing", async () => {
    const { d, seal, rec, forgot } = await setup();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {}, "2099-01-01T00:00:00.000Z");
    expect(() =>
      rec.approveNow("planted", "admin-device", { op: "presence.reset", params: {} }),
    ).toThrow();
    expect(() => rec.subject("planted")).toThrow();
    expect(forgot()).toBe(0);
    expect(alertKinds(d)).not.toContain("recovery_applied");
  });

  it("cancel on a planted row id is refused and records nothing", async () => {
    const { d, seal, rec } = await setup();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {}, "2099-01-01T00:00:00.000Z");
    expect(() => rec.cancel("planted", "admin-device", { trustedAdmin: true })).toThrow();
    expect(seal.recoveryDecided("planted")).toBe(false);
    expect(alertKinds(d)).not.toContain("recovery_cancelled");
  });

  it("a cancel from the Mac (recovery.cancel request) naming a planted row is refused", async () => {
    const { d, seal, rec } = await setup();
    rec.tick();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {}, "2099-01-01T00:00:00.000Z");
    cliRequest("c1", "recovery.cancel", { id: "planted" });
    rec.tick();
    expect(
      d.sqlite.prepare("SELECT status FROM security_requests WHERE id = 'c1'").pluck().get(),
    ).toBe("refused");
    expect(alertKinds(d)).not.toContain("recovery_cancelled");
  });
});

describe("intake never joins a planted row", () => {
  it("a CLI presence reset queues its own recovery, not the planted one", async () => {
    const { d, seal, rec } = await setup();
    rec.tick();
    seal.ensure();
    plantRecovery("planted", "presence.reset", {}, "2099-01-01T00:00:00.000Z");
    cliRequest("q1", "presence.reset");
    rec.tick();
    const req = d.sqlite
      .prepare("SELECT status, recovery_id FROM security_requests WHERE id = 'q1'")
      .get() as { status: string; recovery_id: string | null };
    expect(req.status).toBe("waiting");
    expect(req.recovery_id).not.toBe("planted");
    expect(req.recovery_id).not.toBeNull();
    // Positive control: a second request joins the genuine one.
    cliRequest("q2", "presence.reset");
    clock += 1000;
    rec.tick();
    expect(
      d.sqlite.prepare("SELECT recovery_id FROM security_requests WHERE id = 'q2'").pluck().get(),
    ).toBe(req.recovery_id);
  });
});

describe("genuine recoveries still work (positive controls)", () => {
  it("a CLI presence reset applies on the first tick after not_before", async () => {
    const { d, seal, rec, forgot } = await setup();
    cliRequest("q1", "presence.reset");
    seal.ensure();
    rec.tick();
    expect(rec.waitingCount()).toBe(1);
    clock += DELAY - 1;
    seal.ensure();
    rec.tick();
    expect(forgot()).toBe(0);
    clock += 2;
    seal.ensure();
    rec.tick();
    expect(forgot()).toBe(1);
    expect(d.sqlite.prepare("SELECT status FROM security_recoveries").pluck().get()).toBe(
      "applied",
    );
    expect(alertKinds(d)).toContain("recovery_applied");
    expect(alertKinds(d)).not.toContain("state_changed_outside");
  });

  it("a genuine recovery is still applied when a foreign row lands in the same poll", async () => {
    const { d, seal, rec, forgot } = await setup();
    cliRequest("q1", "presence.reset");
    seal.ensure();
    rec.tick();
    clock += DELAY + 1;
    seal.ensure();
    plantRecovery("planted", "presence.reset", {});
    rec.tick();
    expect(forgot()).toBe(1);
    const rows = d.sqlite
      .prepare("SELECT id, status FROM security_recoveries ORDER BY id")
      .all() as { id: string; status: string }[];
    // The planted row never applies (the seal check the apply's own writes run may already have
    // removed it).
    expect(rows.find((r) => r.id === "planted")?.status ?? "removed").not.toBe("applied");
    expect(rows.find((r) => r.id !== "planted")?.status).toBe("applied");
  });

  it("cancel and approveNow still work on a genuine waiting row", async () => {
    const { d, seal, rec, forgot } = await setup();
    const waiting = () =>
      d.sqlite
        .prepare("SELECT id FROM security_recoveries WHERE status = 'waiting'")
        .pluck()
        .get() as string;
    cliRequest("q1", "presence.reset");
    seal.ensure();
    rec.tick();
    expect(rec.cancel(waiting(), "admin-device", { trustedAdmin: true }).status).toBe("cancelled");

    cliRequest("q2", "presence.reset");
    clock += 1000;
    seal.ensure();
    rec.tick();
    const id = waiting();
    const s = rec.subject(id);
    expect(rec.approveNow(id, "admin-device", { op: s.op, params: s.params }).status).toBe(
      "applied",
    );
    expect(forgot()).toBe(1);
  });
});

describe("devices.approve pairs only the device recorded at intake", () => {
  const CODE = "ABCD23";
  const FULL = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];

  function device(d: PsycheDb, id: string) {
    return insertDevice(d, {
      id,
      name: id,
      platform: "macos",
      role: "client",
      publicKey: randomBytes(32).toString("base64url"),
      scopes: [],
    });
  }

  /** A, the owner's new device, with its pairing request; B, the attacker's unpaired device. */
  async function waitingApproval(expiresAt?: string) {
    const s = await setup();
    const a = device(s.d, "owner-a");
    const b = device(s.d, "attacker-b");
    const req = createPairingRequest(s.d, {
      kind: "device",
      code: CODE,
      deviceId: a.id,
      display: a.name,
      publicKeyFingerprint: keyFingerprint(a.publicKey),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    cliRequest("q1", "devices.approve", { code: CODE });
    s.seal.ensure();
    s.rec.tick();
    expect(s.rec.waitingCount()).toBe(1);
    const due = () => {
      clock += DELAY + 1;
      s.seal.ensure();
      s.rec.tick();
    };
    return { ...s, a, b, req, due };
  }

  type Dev = { id: string; publicKey: string };
  const swaps: [string, (b: Dev) => Record<string, string>][] = [
    [
      "device and key",
      (b) => ({ device_id: b.id, public_key_fingerprint: keyFingerprint(b.publicKey) }),
    ],
    ["device only", (b) => ({ device_id: b.id })],
    ["key only", (b) => ({ public_key_fingerprint: keyFingerprint(b.publicKey) })],
  ];

  it.each(swaps)(
    "a request rewritten outside (%s) pairs nobody and fails visibly",
    async (_n, swap) => {
      const { d, a, b, req, due } = await waitingApproval();
      foreign((f) => {
        const set: Record<string, string> = {
          ...swap(b),
          status: "pending",
          expires_at: "2099-01-01T00:00:00.000Z",
        };
        const cols = Object.keys(set);
        f.sqlite
          .prepare(
            `UPDATE pairing_requests SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
          )
          .run(...cols.map((c) => set[c]), req.id);
      });
      due();
      expect(getDevice(d, b.id)?.pairedAt).toBeNull();
      expect(getDevice(d, b.id)?.scopes).toEqual([]);
      expect(getDevice(d, a.id)?.pairedAt).toBeNull();
      expect(d.sqlite.prepare("SELECT status FROM security_recoveries").pluck().get()).toBe(
        "failed",
      );
      expect(alertKinds(d)).toContain("recovery_failed");
      expect(alertKinds(d)).not.toContain("recovery_applied");
    },
  );

  it("positive control: an untouched approval pairs A with its scopes and answers the card", async () => {
    const { d, a, b, req, due } = await waitingApproval();
    due();
    expect(getDevice(d, a.id)?.pairedAt).not.toBeNull();
    expect(getDevice(d, a.id)?.scopes).toEqual(FULL);
    expect(getDevice(d, b.id)?.pairedAt).toBeNull();
    expect(
      d.sqlite.prepare("SELECT status FROM pairing_requests WHERE id = ?").pluck().get(req.id),
    ).toBe("approved");
    expect(alertKinds(d)).toContain("recovery_applied");
  });

  it("a request that expired still pairs A and only A, and is marked expired", async () => {
    const { d, a, b, req, due } = await waitingApproval(new Date(Date.now() - 1000).toISOString());
    due();
    expect(getDevice(d, a.id)?.scopes).toEqual(FULL);
    expect(getDevice(d, b.id)?.pairedAt).toBeNull();
    expect(
      d.sqlite.prepare("SELECT status FROM pairing_requests WHERE id = ?").pluck().get(req.id),
    ).toBe("expired");
  });

  it("a request another program deleted still pairs A and only A", async () => {
    const { d, a, b, req, due } = await waitingApproval();
    foreign((f) => f.sqlite.prepare("DELETE FROM pairing_requests WHERE id = ?").run(req.id));
    due();
    expect(getDevice(d, a.id)?.scopes).toEqual(FULL);
    expect(getDevice(d, b.id)?.pairedAt).toBeNull();
  });
});
