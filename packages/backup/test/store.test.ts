import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupFileName,
  createBackup,
  deleteBackup,
  ensureBackupsDir,
  extractAndVerify,
  listBackups,
  markVerified,
  resolveBackupFile,
  timeFromName,
} from "../src/index.ts";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-backup-store-"));
  dirs.push(d);
  mkdirSync(join(d, "state"), { recursive: true });
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createBackup with snapshots (the Gateway keeps running)", () => {
  it("archives the snapshot instead of the live file and leaves its WAL siblings out", async () => {
    const h = home();
    writeFileSync(join(h, "state/psyche.sqlite"), "LIVE-HALF-WRITTEN");
    writeFileSync(join(h, "state/psyche.sqlite-wal"), "wal");
    writeFileSync(join(h, "state/psyche.sqlite-shm"), "shm");
    writeFileSync(join(h, "state/other.json"), "{}");
    const out = join(ensureBackupsDir(h), backupFileName(new Date(), false));
    const manifest = await createBackup(h, out, { kind: "none" }, "test", {
      snapshots: {
        "state/psyche.sqlite": async (dest) => writeFileSync(dest, "CONSISTENT-SNAPSHOT"),
      },
    });
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      "state/other.json",
      "state/psyche.sqlite",
    ]);
    const { dir, problems } = await extractAndVerify(out, { kind: "none" }, h);
    expect(problems).toEqual([]);
    expect(readFileSync(join(dir, "state/psyche.sqlite"), "utf8")).toBe("CONSISTENT-SNAPSHOT");
    rmSync(dir, { recursive: true, force: true });
    // The live file is untouched and no staging is left behind.
    expect(readFileSync(join(h, "state/psyche.sqlite"), "utf8")).toBe("LIVE-HALF-WRITTEN");
    expect(listBackups(h).map((b) => b.file)).toEqual([out.split("/").at(-1)]);
  });
});

describe("backups directory", () => {
  it("names, lists newest first, records verification and deletes", () => {
    const h = home();
    const dir = ensureBackupsDir(h);
    const older = backupFileName(new Date("2026-10-01T00:00:00.000Z"), true);
    const newer = backupFileName(new Date("2026-10-02T03:04:05.678Z"), false);
    expect(newer).toBe("psyche-2026-10-02T03-04-05-678Z.tar.gz");
    expect(timeFromName(newer)).toBe("2026-10-02T03:04:05.678Z");
    writeFileSync(join(dir, older), "x");
    writeFileSync(join(dir, newer), "yy");
    writeFileSync(join(dir, "notes.txt"), "not a backup");
    markVerified(h, older, new Date("2026-10-03T00:00:00.000Z"));
    expect(listBackups(h)).toEqual([
      {
        file: newer,
        createdAt: "2026-10-02T03:04:05.678Z",
        bytes: 2,
        encrypted: false,
        verifiedAt: null,
      },
      {
        file: older,
        createdAt: "2026-10-01T00:00:00.000Z",
        bytes: 1,
        encrypted: true,
        verifiedAt: "2026-10-03T00:00:00.000Z",
      },
    ]);
    deleteBackup(h, older);
    expect(listBackups(h).map((b) => b.file)).toEqual([newer]);
  });

  it.each(["../psyche-x.tar.gz", "psyche-a/b.tar.gz", "notes.txt", ".verified.json", ""])(
    "refuses the file name %j",
    (name) => {
      const h = home();
      ensureBackupsDir(h);
      expect(() => resolveBackupFile(h, name)).toThrow();
    },
  );

  it("refuses a backup name that is a symlink out of the directory", () => {
    const h = home();
    const dir = ensureBackupsDir(h);
    writeFileSync(join(h, "secret"), "x");
    symlinkSync(join(h, "secret"), join(dir, "psyche-evil.tar.gz"));
    expect(() => resolveBackupFile(h, "psyche-evil.tar.gz")).toThrow(/outside/);
  });
});
