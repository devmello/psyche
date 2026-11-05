import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isHostHelperFamily, isHostHelperKind } from "../src/index.ts";
import {
  fsyncDirSync,
  isNamedPipePath,
  namedPipePath,
  psycheHomeHash,
  restrictDirToCurrentUser,
  usesNamedPipes,
} from "../src/platform.ts";

describe("host helper families", () => {
  it("knows the Mac and Windows helpers and nothing else", () => {
    expect(isHostHelperFamily("mac-helper")).toBe(true);
    expect(isHostHelperFamily("win-helper")).toBe(true);
    for (const f of ["desktop", "psyche-node", "vm-guest", "Mac-Helper", "", undefined, null]) {
      expect(isHostHelperFamily(f)).toBe(false);
    }
    expect(isHostHelperKind("mac-helper")).toBe(true);
    expect(isHostHelperKind("win-helper")).toBe(true);
    expect(isHostHelperKind("remote")).toBe(false);
  });
});

describe("local endpoints", () => {
  it("names the pipes from the first 16 hex of sha256 of the absolute home", () => {
    const home = resolve("some", "psyche-home");
    const hash = createHash("sha256").update(home, "utf8").digest("hex").slice(0, 16);
    expect(psycheHomeHash(home)).toBe(hash);
    expect(namedPipePath("node", home)).toBe(`\\\\.\\pipe\\psyche-node-${hash}`);
    expect(namedPipePath("bridge", home)).toBe(`\\\\.\\pipe\\psyche-bridge-${hash}`);
    // A relative home is made absolute first, so both spellings name one pipe.
    expect(psycheHomeHash(join("some", "psyche-home"))).toBe(hash);
  });

  it("tells pipe paths from socket paths", () => {
    expect(isNamedPipePath("\\\\.\\pipe\\psyche-node-0123456789abcdef")).toBe(true);
    expect(isNamedPipePath("\\\\?\\PIPE\\x")).toBe(true);
    expect(isNamedPipePath("/tmp/psyche/node.sock")).toBe(false);
    expect(isNamedPipePath("C:\\Users\\me\\.psyche\\run\\node.sock")).toBe(false);
    expect(isNamedPipePath("\\\\.\\pipe\\")).toBe(false);
    expect(usesNamedPipes("win32")).toBe(true);
    expect(usesNamedPipes("darwin")).toBe(false);
    expect(usesNamedPipes("linux")).toBe(false);
  });
});

describe("directory helpers", () => {
  it("flushes a directory on POSIX and does nothing on Windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-fsync-"));
    try {
      expect(() => fsyncDirSync(dir)).not.toThrow();
      // Windows cannot open a directory for fsync; the helper must not try.
      expect(() => fsyncDirSync(join(dir, "missing"), "win32")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a directory private to the current user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-acl-"));
    try {
      expect(restrictDirToCurrentUser(dir)).toBe(true);
      if (process.platform === "win32") {
        const { execFileSync } = await import("node:child_process");
        const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
        // Only SYSTEM and the user: nothing inherited from the temp dir's parent.
        const aces = acl
          .split(/\r?\n/)
          .map((l) => l.replace(dir, "").trim())
          .filter((l) => l.includes(":("));
        expect(aces).toHaveLength(2);
        expect(aces.some((a) => a.startsWith("NT AUTHORITY\\SYSTEM:"))).toBe(true);
        expect(acl).not.toMatch(/\(I\)/);
      } else {
        const { statSync } = await import("node:fs");
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
