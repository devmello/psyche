import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, insertDevice, openDb, type PsycheDb, setSetting } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsPresence } from "../src/handlers/settings.ts";
import { isSealedSettingKey, isSecuritySettingKey } from "../src/security/seal-spec.ts";
import { StateSeal } from "../src/security/state-seal.ts";

/**
 * `permissions.mode` needs no presence (the owner's one-click choice) but stays a security setting
 * for the seal (PR #1270): a value written straight into the database is undone, and a re-seal
 * never adopts it.
 */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-seal-mode-"));
  dbPath = join(home, "state", "psyche.sqlite");
});
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

const db = (): PsycheDb => {
  const d = openDb(dbPath);
  open.push(d);
  return d;
};

function foreign<T>(fn: (d: PsycheDb) => T): T {
  const d = openDb(dbPath, { migrate: false });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

describe("permissions.mode and the seal", () => {
  it("is a sealed security setting although it needs no presence", () => {
    expect(needsPresence("permissions.mode")).toBe(false);
    expect(isSecuritySettingKey("permissions.mode")).toBe(true);
    expect(isSealedSettingKey("permissions.mode")).toBe(true);
    // A cosmetic setting is neither.
    expect(isSecuritySettingKey("appearance.theme")).toBe(false);
  });

  it("does not keep a tampered value through an untrusted state and a re-seal", async () => {
    const d = db();
    const seal = await StateSeal.open(d, { home });
    insertDevice(d, {
      id: "owner",
      name: "owner",
      platform: "macos",
      role: "client",
      publicKey: Buffer.alloc(32, 7),
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      pairedAt: d.now(),
    });
    setSetting(d, "permissions.mode", "balanced"); // the owner's own write through the Gateway
    seal.ensure();

    // A program on the Mac writes `auto` straight into the file, and the records are broken.
    foreign((f) => {
      setSetting(f, "permissions.mode", "auto");
      f.sqlite.prepare("DELETE FROM security_ledger WHERE pk = ?").run("owner");
    });
    for (const x of open.splice(0)) x.close();
    const d2 = db();
    const again = await StateSeal.open(d2, { home });
    expect(again.status().status).toBe("untrusted");

    again.reseal("recovery");
    expect(again.status().status).toBe("sealed");
    expect(getSetting(d2, "permissions.mode")?.value).not.toBe("auto");
    const adopted = again.alerts.open().find((a) => a.details.reason === "adopted_at_reseal");
    expect(adopted?.details.changes?.map((c) => c.name) ?? []).not.toContain("permissions.mode");
  });
});
