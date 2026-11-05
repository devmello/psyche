import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "../src/index.ts";

/**
 * Chat messages the Gateway held across an update (`state/channels/held.json`) belong to the
 * Gateway that held them: not in a backup, and not brought back by a restore (review round 3).
 */

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-backup-held-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAST = { kind: "passphrase" as const, passphrase: "correct horse battery", scryptLogN: 10 };
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe("held channel messages and backups", () => {
  it("are not in a backup", async () => {
    const home = join(temp(), "home");
    put(home, "state/psyche.sqlite", "db");
    put(home, "state/channels/held.json", '{"v":1,"items":[]}');
    put(home, "state/channels/whatsapp/session.json", "{}");
    const file = join(temp(), "b.age");
    const manifest = await createBackup(home, file, FAST, "t");
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("state/channels/whatsapp/session.json");
    expect(paths).not.toContain("state/channels/held.json");
    expect(
      (await verifyBackup(file, { kind: "passphrase", passphrase: FAST.passphrase }, temp()))
        .problems,
    ).toEqual([]);
  });

  it("are dropped by a restore, even one already sitting in the folder", async () => {
    const home = join(temp(), "home");
    put(home, "state/psyche.sqlite", "db");
    const file = join(temp(), "b.age");
    await createBackup(home, file, FAST, "t");
    const target = join(temp(), "target");
    put(target, "state/psyche.sqlite", "newer");
    put(target, "state/channels/held.json", '{"v":1,"items":["old"]}');
    await restoreBackup(file, { kind: "passphrase", passphrase: FAST.passphrase }, target, {
      force: true,
    });
    expect(existsSync(join(target, "state", "channels", "held.json"))).toBe(false);
  });

  it("and the last-boot note is neither backed up nor kept across a restore", async () => {
    const home = join(temp(), "home");
    put(home, "state/psyche.sqlite", "db");
    put(home, "state/last-boot.json", '{"version":"0.4.0","build":"x","goodSeq":2}');
    const file = join(temp(), "b.age");
    const manifest = await createBackup(home, file, FAST, "t");
    expect(manifest.files.map((f) => f.path)).not.toContain("state/last-boot.json");
    const target = join(temp(), "target");
    put(target, "state/psyche.sqlite", "newer");
    put(target, "state/last-boot.json", '{"version":"0.5.0","build":"y","goodSeq":9}');
    await restoreBackup(file, { kind: "passphrase", passphrase: FAST.passphrase }, target, {
      force: true,
    });
    expect(existsSync(join(target, "state", "last-boot.json"))).toBe(false);
  });
});
