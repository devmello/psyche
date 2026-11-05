import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hostHelperKindOf, isHostHelperFamily, isHostHelperKind } from "../src/index.ts";
import {
  fsyncDirSync,
  LINUX_PACKAGED_HELPER_PATH,
  isNamedPipePath,
  namedPipePath,
  psycheHomeHash,
  usesNamedPipes,
} from "../src/platform.ts";

describe("the packaged Linux helper path", () => {
  it("is the one the design, the packaging and the peer check agree on", () => {
    expect(LINUX_PACKAGED_HELPER_PATH).toBe(
      "/usr/lib/psyche/resources/linux-helper/psyche-helper",
    );
  });
});

describe("host helper families", () => {
  it("knows the Mac, Windows and Linux helpers and nothing else", () => {
    expect(isHostHelperFamily("mac-helper")).toBe(true);
    expect(isHostHelperFamily("win-helper")).toBe(true);
    expect(isHostHelperFamily("linux-helper")).toBe(true);
    for (const f of ["desktop", "psyche-node", "vm-guest", "Mac-Helper", "", undefined, null]) {
      expect(isHostHelperFamily(f)).toBe(false);
    }
    expect(isHostHelperKind("mac-helper")).toBe(true);
    expect(isHostHelperKind("win-helper")).toBe(true);
    expect(isHostHelperKind("host-helper")).toBe(true);
    expect(isHostHelperKind("remote")).toBe(false);
    expect(isHostHelperKind("guest")).toBe(false);
  });

  it("stores a Linux helper as host-helper and keeps the Mac and Windows kinds", () => {
    expect(hostHelperKindOf("linux-helper")).toBe("host-helper");
    expect(hostHelperKindOf("mac-helper")).toBe("mac-helper");
    expect(hostHelperKindOf("win-helper")).toBe("win-helper");
  });
});

describe("local endpoints", () => {
  it("names the pipes from the first 16 hex of sha256 of the absolute home", () => {
    const home = resolve("some", "psyche-home");
    const hash = createHash("sha256").update(home, "utf8").digest("hex").slice(0, 16);
    expect(psycheHomeHash(home)).toBe(hash);
    expect(namedPipePath("node", home)).toBe(`\\\\.\\pipe\\psyche-node-${hash}`);
    const lower = createHash("sha256")
      .update(home.toLowerCase(), "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(namedPipePath("bridge", home)).toBe(`\\\\.\\pipe\\psyche-${lower}-browser-bridge`);
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
});
