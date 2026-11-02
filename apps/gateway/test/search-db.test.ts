import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting } from "@psyche/db";
import { isPlainSqlite, KeyFileWrapper } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSearchDatabase,
  resolveSearchKey,
  SEARCH_ENCRYPT_SETTING,
} from "../src/compose/search-db.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-sdb-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(encrypt: boolean | undefined) {
  const dir = tmp();
  const db = openDb(join(dir, "psyche.sqlite"));
  if (encrypt !== undefined) setSetting(db, SEARCH_ENCRYPT_SETTING, encrypt);
  const keyPath = join(dir, "vault.key");
  writeFileSync(keyPath, "b".repeat(64), { mode: 0o600 });
  return {
    dir,
    db,
    wrapper: new KeyFileWrapper(keyPath),
    keyFile: join(dir, "state", "search.key.json"),
  };
}

describe("resolveSearchKey", () => {
  it("is off unless the setting is on", async () => {
    const f = fixture(undefined);
    expect(await resolveSearchKey({ ...f, slot: "key_file" })).toEqual({
      status: { state: "off" },
    });
  });
  it("is unavailable on the interactive keychain slot and never makes a key", async () => {
    const f = fixture(true);
    const r = await resolveSearchKey({ ...f, slot: "keychain" });
    expect(r.key).toBeUndefined();
    expect(r.status.state).toBe("unavailable");
    expect(r.status.reason).toMatch(/Touch ID/);
  });
  it("makes and reuses a wrapped key on a key-file slot", async () => {
    const f = fixture(true);
    const a = await resolveSearchKey({ ...f, slot: "key_file" });
    const b = await resolveSearchKey({ ...f, slot: "key_file" });
    expect(a.status.state).toBe("on");
    expect(b.key?.equals(a.key as Buffer)).toBe(true);
  });
  it("reports a broken wrapper instead of throwing", async () => {
    const f = fixture(true);
    const r = await resolveSearchKey({
      ...f,
      wrapper: new KeyFileWrapper(join(f.dir, "missing.key")),
      slot: "key_file",
    });
    expect(r.status.state).toBe("unavailable");
  });
});

describe("openSearchDatabase", () => {
  const key = Buffer.alloc(32, 9);
  const head = (p: string) => readFileSync(p).subarray(0, 16);

  it("encrypts a plain index by rebuilding it, and back", () => {
    const dir = tmp();
    const path = join(dir, "search.sqlite");
    const plain = openSearchDatabase(path, undefined);
    plain.sqlite.exec("CREATE TABLE t (a)");
    plain.sqlite.prepare("INSERT INTO t VALUES ('old')").run();
    plain.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    plain.sqlite.close();
    expect(isPlainSqlite(head(path))).toBe(true);

    const msgs: string[] = [];
    const enc = openSearchDatabase(path, key, (m) => msgs.push(m));
    expect(enc.rebuilt).toBe(true);
    expect(msgs[0]).toMatch(/encrypting/);
    enc.sqlite.exec("CREATE TABLE t (a)");
    enc.sqlite.prepare("INSERT INTO t VALUES ('new')").run();
    enc.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    enc.sqlite.close();
    expect(isPlainSqlite(head(path))).toBe(false);

    const again = openSearchDatabase(path, key);
    expect(again.rebuilt).toBe(false);
    expect(again.sqlite.prepare("SELECT a FROM t").get()).toEqual({ a: "new" });
    again.sqlite.close();

    const back = openSearchDatabase(path, undefined);
    expect(back.rebuilt).toBe(true);
    back.sqlite.close();
  });

  it("rebuilds when the key no longer opens the file", () => {
    const path = join(tmp(), "search.sqlite");
    const a = openSearchDatabase(path, key);
    a.sqlite.exec("CREATE TABLE t (a)");
    a.sqlite.close();
    const b = openSearchDatabase(path, Buffer.alloc(32, 1));
    expect(b.rebuilt).toBe(true);
    expect(b.sqlite.prepare("SELECT count(*) c FROM sqlite_master").get()).toEqual({ c: 0 });
    b.sqlite.close();
  });
});
