import { describe, expect, it } from "vitest";
import { assertGranted, canonicalTarget, isProtectedPath } from "../src/paths.ts";
import { gitInternal } from "../src/tools.ts";

/** The executors' own checks behind the broker, with Windows paths (NTFS ignores case). */
describe.runIf(process.platform === "win32")("Windows paths in the file executors", () => {
  it("canonicalizes drive paths and refuses names Win32 would rewrite", () => {
    expect(canonicalTarget("c:/Users/o/Docs/../a.txt")).toBe("C:\\Users\\o\\a.txt");
    for (const p of [
      "C:\\Users\\o\\a.txt:hidden",
      "C:\\Users\\o\\.ssh.\\id",
      "C:\\Users\\o\\DOCUME~1",
      "C:\\Users\\o\\NUL",
      "/Users/o/a.txt",
      "\\Users\\o\\a.txt",
    ]) {
      expect(() => canonicalTarget(p), p).toThrow();
    }
  });

  it("checks grants and protected roots without case, by whole segments", () => {
    const folders = [{ path: "C:\\Users\\o\\Docs", mode: "rw" as const }];
    expect(() => assertGranted("C:\\USERS\\o\\docs\\a.txt", folders, "write")).not.toThrow();
    expect(() => assertGranted("C:\\Users\\o\\Docs2\\a.txt", folders, "read")).toThrow(
      /outside every granted folder/,
    );
    const roots = ["C:\\Users\\o\\.psyche"];
    const own = ["C:\\Users\\o\\.psyche\\cli\\claude-code"];
    expect(isProtectedPath("c:\\users\\o\\.PSYCHE\\vault\\vault.db", roots, own)).toBe(true);
    expect(isProtectedPath("C:\\Users\\o\\.psyche\\cli\\claude-code\\notes.md", roots, own)).toBe(
      false,
    );
    for (const name of ["claude.md", "Agents.MD", ".mcp.json"]) {
      expect(isProtectedPath(`C:\\Users\\o\\.psyche\\cli\\claude-code\\${name}`, roots, own)).toBe(
        true,
      );
    }
  });

  it("sees a .git segment with either separator and any case", () => {
    expect(gitInternal("C:\\repo\\.GIT\\config")).toBe(true);
    expect(gitInternal("C:\\repo\\.git\\hooks\\pre-commit")).toBe(true);
    expect(gitInternal("C:\\repo\\src\\a.ts")).toBe(false);
  });
});
