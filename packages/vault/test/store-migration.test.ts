import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { VAULT_SCHEMA_VERSION, VaultStore } from "../src/store.ts";

/** A v1 vault (before signing_key) opens, keeps its items, and takes signing keys after. */
describe("vault store migration v1 → v2", () => {
  it("rebuilds the items table with signing_key allowed and keeps every row", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-vault-mig-"));
    const path = join(dir, "vault.db");
    const dek = randomBytes(32);
    try {
      // Write a v1 vault the way the v1 code did.
      const db = new Database(path);
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      db.pragma(`key="x'${dek.toString("hex")}'"`);
      db.exec(`
CREATE TABLE header (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login','api_key','oauth_token','ssh_key','note','payment_link')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL CHECK (json_valid(secret)),
  bindings TEXT NOT NULL CHECK (json_valid(bindings)),
  attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  owner_connector_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO header (key, value) VALUES ('version', '1');
INSERT INTO items VALUES ('c1', 'login', 'Site', 'site', '{"password":"pw"}', '[]', '{}', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
      db.close();

      const store = VaultStore.open(path, dek);
      expect(store.header("version")).toBe(String(VAULT_SCHEMA_VERSION));
      expect(store.get("c1")).toMatchObject({
        kind: "login",
        slug: "site",
        secret: { password: "pw" },
      });
      store.insert({
        id: "c2",
        kind: "signing_key",
        name: "Web Bot Auth key",
        slug: "web-bot-auth",
        secret: { privateKey: "pem" },
        bindings: [],
        attrs: {},
        ownerConnectorId: null,
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
      });
      expect(
        store
          .all()
          .map((i) => i.kind)
          .sort(),
      ).toEqual(["login", "signing_key"]);
      store.close();
      // Opening again is a no-op.
      const again = VaultStore.open(path, dek);
      expect(again.all()).toHaveLength(2);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
