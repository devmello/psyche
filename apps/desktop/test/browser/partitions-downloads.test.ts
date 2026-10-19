import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureQuarantineDir,
  quarantineAttributeValue,
  quarantineDir,
  quarantinePath,
  sanitizeFilename,
  setQuarantineAttribute,
} from "../../src/main/browser/downloads.ts";
import {
  cleanPartition,
  isAgentPartition,
  isPersistentPartition,
  linkProfileDir,
  loggedInPartition,
  partitionStoragePath,
  profileDir,
} from "../../src/main/browser/partitions.ts";

const root = mkdtempSync(join(tmpdir(), "psy-part-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("partitions", () => {
  it("names logged-in and clean partitions", () => {
    expect(loggedInPartition()).toBe("persist:agent-default");
    expect(loggedInPartition("work")).toBe("persist:agent-work");
    expect(() => loggedInPartition("../x")).toThrow();
    expect(() => loggedInPartition("")).toThrow();
    const a = cleanPartition();
    const b = cleanPartition();
    expect(a).toMatch(/^agent-clean-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(cleanPartition(() => "abc")).toBe("agent-clean-abc");
    expect(() => cleanPartition(() => "../x")).toThrow();
    expect(isPersistentPartition(a)).toBe(false);
    expect(isPersistentPartition(loggedInPartition())).toBe(true);
    expect(isAgentPartition(a)).toBe(true);
    expect(isAgentPartition("persist:psyche-app")).toBe(false);
  });

  it("builds profile and partition paths", () => {
    expect(profileDir("/h")).toBe("/h/browser/profiles/default");
    expect(profileDir("/h", "work")).toBe("/h/browser/profiles/work");
    expect(() => profileDir("/h", "a/b")).toThrow();
    expect(partitionStoragePath("/u", "work")).toBe("/u/Partitions/agent-work");
  });

  it("links a new partition to the profile dir (0700)", () => {
    const userData = join(root, "ud1");
    const home = join(root, "home1");
    expect(linkProfileDir(userData, home)).toBe("linked");
    const link = partitionStoragePath(userData);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(profileDir(home));
    expect(statSync(profileDir(home)).mode & 0o777).toBe(0o700);
    // Second call: already there.
    expect(linkProfileDir(userData, home)).toBe("exists");
  });

  it("leaves an existing real partition directory alone", () => {
    const userData = join(root, "ud2");
    const home = join(root, "home2");
    mkdirSync(partitionStoragePath(userData), { recursive: true });
    expect(linkProfileDir(userData, home)).toBe("exists");
    expect(lstatSync(partitionStoragePath(userData)).isDirectory()).toBe(true);
    expect(() => statSync(profileDir(home))).toThrow();
  });

  it("reports failure instead of throwing", () => {
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    expect(linkProfileDir(join(file, "ud"), join(root, "home3"))).toBe("failed");
  });
});

describe("quarantine paths", () => {
  it("sanitizes file names", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFilename("..")).toBe("download");
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename("a\\b/c:d")).toBe("a_b_c_d");
    expect(sanitizeFilename("in\u0000vo\nice\u0007.pdf")).toBe("invoice.pdf");
    expect(sanitizeFilename("photo‮gpj.exe")).toBe("photogpj.exe");
    expect(sanitizeFilename("  trailing. . ")).toBe("trailing");
    expect(sanitizeFilename("")).toBe("download");
    const long = `${"é".repeat(300)}.pdf`;
    const s = sanitizeFilename(long);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(200);
    expect(s.endsWith(".pdf")).toBe(true);
  });

  it("builds <timestamp>-<name> inside the quarantine dir and avoids collisions", () => {
    const home = join(root, "qhome");
    const taken = new Set<string>();
    const opts = { now: () => 1_700_000_000_000, exists: (p: string) => taken.has(p) };
    const p1 = quarantinePath(home, "../x/evil.sh", opts);
    expect(dirname(p1)).toBe(quarantineDir(home));
    expect(basename(p1)).toBe("1700000000000-_x_evil.sh");
    taken.add(p1);
    const p2 = quarantinePath(home, "../x/evil.sh", opts);
    expect(basename(p2)).toBe("1700000000000-1-_x_evil.sh");
    for (const name of ["..", "/", "\\..\\..", "a/../../b", "\u0000"]) {
      expect(dirname(quarantinePath(home, name, opts))).toBe(quarantineDir(home));
    }
  });

  it("creates the quarantine dir 0700", () => {
    const dir = ensureQuarantineDir(join(root, "qh2"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("quarantine attribute", () => {
  it("runs xattr -w through execFile on darwin only", async () => {
    const calls: [string, string[]][] = [];
    const execFile = (file: string, args: string[], cb: (e: Error | null) => void) => {
      calls.push([file, args]);
      cb(null);
    };
    const now = () => 0x65000000 * 1000;
    expect(await setQuarantineAttribute("/q/f", { platform: "linux", execFile })).toBe(false);
    expect(calls).toEqual([]);
    expect(await setQuarantineAttribute("/q/f", { platform: "darwin", execFile, now })).toBe(true);
    expect(calls).toEqual([
      ["/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;65000000;Psyche;", "/q/f"]],
    ]);
    const failing = (_f: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(new Error("nope"));
    expect(await setQuarantineAttribute("/q/f", { platform: "darwin", execFile: failing })).toBe(
      false,
    );
    expect(quarantineAttributeValue(16_000)).toBe("0081;10;Psyche;");
  });

  it.runIf(process.platform === "darwin")("sets the real attribute on macOS", async () => {
    const f = join(ensureQuarantineDir(join(root, "qh3")), "file.bin");
    writeFileSync(f, "x");
    expect(await setQuarantineAttribute(f)).toBe(true);
    const v = execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", f], {
      encoding: "utf8",
    });
    expect(v).toMatch(/^0081;[0-9a-f]+;Psyche;/);
  });
});
