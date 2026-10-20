import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, RESTORE_MARKER, restoreBackup, verifyBackup } from "../src/index.ts";

/** Archive round trips, wrong keys, tampering and restore rules (moved from apps/cli). */

const FIXED_NOW = new Date("2026-10-19T12:00:00.000Z");
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-backup-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PASS = "correct horse battery";
const FAST = { kind: "passphrase" as const, passphrase: PASS, scryptLogN: 10 };

const INCLUDED: Record<string, string | Buffer> = {
  "state/psyche.sqlite": Buffer.from([0x53, 0x51, 0x4c, 0x00, 0xff, 0x01, 0x02]),
  "state/channels/whatsapp/session.json": '{"session":"abc"}',
  "workspace/MEMORY.md": "# Memory\n- likes tea\n",
  "vault/vault.db": Buffer.from("vault-bytes"),
  "library/a.txt": "library file",
  "audit/2026-10.jsonl": '{"seq":1}\n',
  "config.json": '{"gateway":{"port":7979}}\n',
};
const EXCLUDED: Record<string, string> = {
  "cli/device.json": '{"privateKey":"never-in-a-backup"}',
  "run/gateway.sock": "not a real socket",
  "logs/gateway.err.log": "log line\n",
};

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function fixtureHome(home = join(tempDir(), "home")): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeTree(home, INCLUDED);
  writeTree(home, EXCLUDED);
  return home;
}

function expectRestored(home: string): void {
  for (const [rel, content] of Object.entries(INCLUDED)) {
    expect(readFileSync(join(home, rel)), rel).toEqual(Buffer.from(content));
    expect(statSync(join(home, rel)).mode & 0o777, rel).toBe(0o600);
  }
  for (const dir of [
    "state",
    "state/channels/whatsapp",
    "workspace",
    "vault",
    "library",
    "audit",
  ]) {
    expect(statSync(join(home, dir)).mode & 0o777, dir).toBe(0o700);
  }
  for (const rel of Object.keys(EXCLUDED)) expect(existsSync(join(home, rel)), rel).toBe(false);
}

describe("backup library", () => {
  it("round trip with a passphrase: create → verify → restore into an empty home", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "b.tar.gz.age");
    const manifest = await createBackup(home, file, FAST, "0.0.0-test", { now: FIXED_NOW });
    expect(manifest.entries).toEqual([
      "config.json",
      "state",
      "workspace",
      "vault",
      "library",
      "audit",
    ]);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(Object.keys(INCLUDED).sort());
    expect(manifest.createdAt).toBe(FIXED_NOW.toISOString());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).subarray(0, 21).toString()).toBe("age-encryption.org/v1");

    const v = await verifyBackup(file, { kind: "passphrase", passphrase: PASS }, tempDir());
    expect(v.problems).toEqual([]);
    expect(v.manifest.files).toHaveLength(Object.keys(INCLUDED).length);

    const target = join(tempDir(), "new-home");
    const r = await restoreBackup(file, { kind: "passphrase", passphrase: PASS }, target, {
      force: false,
    });
    expect(r.movedAside).toBeNull();
    expectRestored(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readdirSync(target).filter((n) => n.startsWith(".psyche-restore-"))).toEqual([]);
  });

  it("wrong passphrase → rejects", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "b.age");
    await createBackup(home, file, FAST, "t");
    await expect(
      verifyBackup(file, { kind: "passphrase", passphrase: "wrong horse" }, tempDir()),
    ).rejects.toThrow(/Cannot decrypt/);
  });

  it("recipients mode round trip with an age identity", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const home = fixtureHome();
    const file = join(tempDir(), "b.age");
    await createBackup(home, file, { kind: "recipients", recipients: [recipient] }, "t");
    const v = await verifyBackup(file, { kind: "identities", identities: [identity] }, tempDir());
    expect(v.problems).toEqual([]);
    const other = await generateIdentity();
    await expect(
      verifyBackup(file, { kind: "identities", identities: [other] }, tempDir()),
    ).rejects.toThrow();
    const target = join(tempDir(), "h");
    await restoreBackup(file, { kind: "identities", identities: [identity] }, target, {
      force: false,
    });
    expectRestored(target);
  });

  it("a flipped byte in the middle of the archive → rejects (no hang, no uncaught error)", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "m.age");
    await createBackup(home, file, FAST, "t");
    const bytes = readFileSync(file);
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    writeFileSync(file, bytes);
    await expect(
      verifyBackup(file, { kind: "passphrase", passphrase: FAST.passphrase }, tempDir()),
    ).rejects.toThrow(/damaged or the key is wrong/);
  });

  it("a flipped byte in the age header → rejects", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "b.age");
    await createBackup(home, file, FAST, "t");
    const bytes = readFileSync(file);
    const at = bytes.indexOf("\n---") - 3; // inside the header, before its MAC line
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    writeFileSync(file, bytes);
    await expect(
      verifyBackup(file, { kind: "passphrase", passphrase: PASS }, tempDir()),
    ).rejects.toThrow(/Cannot decrypt/);
    const target = join(tempDir(), "h");
    await expect(
      restoreBackup(file, { kind: "passphrase", passphrase: PASS }, target, { force: false }),
    ).rejects.toThrow(/Cannot decrypt/);
    expect(existsSync(join(target, "state"))).toBe(false);
  });

  it("restore into a non-empty home: refused without force, moved aside with force", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "b.age");
    await createBackup(home, file, FAST, "t");
    const target = join(tempDir(), "h");
    writeTree(target, { "state/old.sqlite": "old state", "config.json": "{}" });
    await expect(
      restoreBackup(file, { kind: "passphrase", passphrase: PASS }, target, { force: false }),
    ).rejects.toThrow(/--force/);
    expect(readFileSync(join(target, "state/old.sqlite"), "utf8")).toBe("old state");

    const r = await restoreBackup(file, { kind: "passphrase", passphrase: PASS }, target, {
      force: true,
      now: FIXED_NOW,
    });
    expect(r.movedAside).toMatch(/^\.pre-restore-2026-10-19T12-00-00-000Z$/);
    const aside = join(target, r.movedAside ?? "");
    expect(readFileSync(join(aside, "state/old.sqlite"), "utf8")).toBe("old state");
    expect(readFileSync(join(aside, "config.json"), "utf8")).toBe("{}");
    expect(existsSync(join(target, "state/old.sqlite"))).toBe(false);
    expectRestored(target);
  });

  it("plain (kind none) round trip", async () => {
    const home = fixtureHome();
    const file = join(tempDir(), "b.tar.gz");
    await createBackup(home, file, { kind: "none" }, "t");
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect((await verifyBackup(file, { kind: "none" }, tempDir())).problems).toEqual([]);
    const target = join(tempDir(), "h");
    await restoreBackup(file, { kind: "none" }, target, { force: false });
    expectRestored(target);
  });

  it("a home without state/ is refused", async () => {
    const home = join(tempDir(), "empty");
    mkdirSync(home);
    await expect(createBackup(home, join(tempDir(), "b"), FAST, "t")).rejects.toThrow(/state/);
  });
});

describe("revocation ledger stays out of backups (S23 design-26)", () => {
  it("never archives security/, and a restore leaves the marker the next boot replays", async () => {
    const home = fixtureHome();
    writeTree(home, {
      "security/revocations.jsonl": '{"type":"device","id":"dev_lost","at":"x"}\n',
    });
    const file = join(tempDir(), "b.tar.gz.age");
    const manifest = await createBackup(home, file, FAST, "0.0.0-test", { now: FIXED_NOW });
    expect(manifest.files.some((f) => f.path.startsWith("security/"))).toBe(false);

    const target = join(tempDir(), "restored");
    await restoreBackup(file, { kind: "passphrase", passphrase: PASS }, target, {
      force: false,
      now: FIXED_NOW,
    });
    expect(existsSync(join(target, "security", "revocations.jsonl"))).toBe(false);
    expect(JSON.parse(readFileSync(join(target, RESTORE_MARKER), "utf8"))).toEqual({
      restoredAt: FIXED_NOW.toISOString(),
      backupCreatedAt: FIXED_NOW.toISOString(),
    });
    expect(statSync(join(target, RESTORE_MARKER)).mode & 0o777).toBe(0o600);
  });
});
