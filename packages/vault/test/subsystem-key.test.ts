import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_FILE, privacyOf } from "@psyche/hostfs/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPlainSqlite,
  KeyFileWrapper,
  loadOrCreateSubsystemKey,
  openEncryptedSqlite,
} from "../src/index.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-subkey-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function wrapper(dir: string) {
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, "a".repeat(64), { mode: 0o600 });
  return new KeyFileWrapper(keyFile);
}

describe("subsystem key", () => {
  it("creates a wrapped key once, 0600, and loads the same key again", async () => {
    const dir = tmp();
    const w = wrapper(dir);
    const file = join(dir, "state", "search.key.json");
    const a = await loadOrCreateSubsystemKey(file, w, "test");
    expect(a.created).toBe(true);
    expect(a.key).toHaveLength(32);
    expect(privacyOf(file)).toBe(OWNER_FILE);
    expect(readFileSync(file, "utf8")).not.toContain(a.key.toString("hex"));
    const b = await loadOrCreateSubsystemKey(file, w, "test");
    expect(b.created).toBe(false);
    expect(b.key.equals(a.key)).toBe(true);
  });

  it("refuses a key file of another slot or a wrapper that is unavailable", async () => {
    const dir = tmp();
    const file = join(dir, "k.json");
    writeFileSync(file, JSON.stringify({ v: 1, slot: "keychain", wrapped: {} }));
    await expect(loadOrCreateSubsystemKey(file, wrapper(dir), "t")).rejects.toThrow();
    const missing = new KeyFileWrapper(join(dir, "nope.key"));
    await expect(loadOrCreateSubsystemKey(join(dir, "new.json"), missing, "t")).rejects.toThrow();
  });

  it("encrypts a database with FTS5, rejects a wrong key and hides the plaintext", async () => {
    const dir = tmp();
    const { key } = await loadOrCreateSubsystemKey(join(dir, "k.json"), wrapper(dir), "t");
    const path = join(dir, "search.sqlite");
    const db = openEncryptedSqlite(path, key);
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
    db.prepare("INSERT INTO t (body) VALUES (?)").run("the lisbon budget is secret");
    expect(db.prepare("SELECT count(*) c FROM t WHERE t MATCH 'lisbon'").get()).toEqual({ c: 1 });
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const bytes = readFileSync(path);
    expect(isPlainSqlite(bytes.subarray(0, 16))).toBe(false);
    expect(bytes.includes(Buffer.from("lisbon"))).toBe(false);
    expect(() => openEncryptedSqlite(path, Buffer.alloc(32, 7))).toThrow(/does not open/);
    openEncryptedSqlite(path, key).close();
  });
});
