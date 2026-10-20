import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RevocationLedger, replayRevocations, writeRestoreMarker } from "../src/index.ts";
import { approve, CTX, call, makeBroker, memoryDb, origin } from "./helpers.ts";

/** Revocation ledger outside the backup scope (S23 design-26). */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempHome = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-revocations-"));
  dirs.push(d);
  return d;
};

function seed(db: ReturnType<typeof memoryDb>) {
  const at = "2026-10-20T00:00:00.000Z";
  db.sqlite
    .prepare(
      "INSERT INTO devices (id, name, platform, role, public_key, token_hash, scopes, paired_at, created_at, updated_at) VALUES (?, 'd', 'macos', 'client', x'00', x'01', '[\"operator.read\"]', ?, ?, ?)",
    )
    .run("dev_a", at, at, at);
  db.sqlite
    .prepare(
      "INSERT INTO grants (id, kind, scope, grant_key, subject, side_effect, use_count, created_at, updated_at) VALUES (?, 'connector_action', 'always', 'k', '{}', 'write', 0, ?, ?)",
    )
    .run("grt_a", at, at);
}
const row = (db: ReturnType<typeof memoryDb>, sql: string, id: string) =>
  db.sqlite.prepare(sql).get(id) as Record<string, unknown>;

describe("revocation ledger", () => {
  it("the broker records every grant revocation", async () => {
    const home = tempHome();
    const ledger = new RevocationLedger(home);
    const h = makeBroker({ revocations: ledger });
    const { approval } = await approve(
      h,
      call("calendar.create", "write", origin("https://c.example")),
      CTX,
      "always",
    );
    await h.broker.revokeGrant(approval.grantId ?? "");
    expect(ledger.entries().filter((e) => e.type === "grant")).toMatchObject([
      { type: "grant", id: approval.grantId, reason: "owner" },
    ]);
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
  });

  it("replay re-revokes what the ledger lists and is idempotent", () => {
    const home = tempHome();
    const db = memoryDb();
    seed(db);
    const ledger = new RevocationLedger(home);
    ledger.recordDevice("dev_a");
    ledger.recordGrant("grt_a", "owner");
    expect(replayRevocations(db.sqlite, home)).toMatchObject({
      devicesRevoked: 1,
      grantsRevoked: 1,
      unknownEpoch: false,
    });
    expect(
      row(db, "SELECT revoked_at, token_hash FROM devices WHERE id = ?", "dev_a"),
    ).toMatchObject({ token_hash: null });
    expect(
      row(db, "SELECT revoked_at FROM devices WHERE id = ?", "dev_a").revoked_at,
    ).not.toBeNull();
    expect(row(db, "SELECT revoked_reason FROM grants WHERE id = ?", "grt_a")).toMatchObject({
      revoked_reason: "owner",
    });
    expect(replayRevocations(db.sqlite, home)).toMatchObject({
      devicesRevoked: 0,
      grantsRevoked: 0,
    });
  });

  it("a restore without a ledger un-pairs devices and revokes every standing grant", () => {
    const home = tempHome();
    const db = memoryDb();
    seed(db);
    writeRestoreMarker(home, { restoredAt: "now", backupCreatedAt: "then" });
    const r = replayRevocations(db.sqlite, home);
    expect(r).toMatchObject({
      unknownEpoch: true,
      devicesUnpaired: 1,
      grantsRevokedUnknownEpoch: 1,
    });
    expect(
      row(db, "SELECT paired_at, scopes, revoked_at FROM devices WHERE id = ?", "dev_a"),
    ).toMatchObject({
      paired_at: null,
      scopes: "[]",
      revoked_at: null,
    });
    expect(row(db, "SELECT revoked_reason FROM grants WHERE id = ?", "grt_a")).toMatchObject({
      revoked_reason: "restore_unknown_epoch",
    });
    // The marker is consumed and a fresh ledger starts.
    expect(existsSync(join(home, "security", "restored.json"))).toBe(false);
    expect(new RevocationLedger(home).exists).toBe(true);
  });

  it("a normal boot without a marker creates the ledger and changes nothing", () => {
    const home = tempHome();
    const db = memoryDb();
    seed(db);
    expect(replayRevocations(db.sqlite, home)).toMatchObject({
      unknownEpoch: false,
      devicesRevoked: 0,
    });
    expect(row(db, "SELECT paired_at FROM devices WHERE id = ?", "dev_a").paired_at).not.toBeNull();
    expect(new RevocationLedger(home).entries()[0]).toMatchObject({ type: "epoch" });
  });
});
