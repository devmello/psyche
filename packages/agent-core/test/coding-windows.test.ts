import { describe, expect, it } from "vitest";
import { canonicalRoot, isGitInternal, isUnder, resolveInRoot } from "../src/coding/workspace.ts";

/**
 * Coding workspaces on Windows: NTFS opens `.git` under other names (the git CVE-2019-1351/1353
 * family), so a model path that spells it another way is refused before `.git` is judged.
 */
describe.runIf(process.platform === "win32")("coding workspace paths on Windows", () => {
  const root = canonicalRoot("C:\\Users\\o\\repo");

  it("canonicalizes the root and compares without case", () => {
    // The drive letter is upper-cased; the rest keeps the case it was given.
    expect(canonicalRoot("c:/users/o/repo/")).toBe("C:\\users\\o\\repo");
    expect(isUnder(resolveInRoot(root, "SRC\\a.ts"), root)).toBe(true);
    expect(resolveInRoot(root, "C:\\USERS\\o\\REPO\\src\\a.ts")).toBe(
      "C:\\USERS\\o\\REPO\\src\\a.ts",
    );
    expect(() => canonicalRoot("/Users/o/repo")).toThrow(/not absolute/);
  });

  it("refuses paths that leave the root, by drive, `..` or another spelling of .git", () => {
    for (const p of [
      "..\\other\\a.ts",
      "D:\\elsewhere\\a.ts",
      "C:\\Users\\o\\repo2\\a.ts",
      ".git::$INDEX_ALLOCATION\\hooks\\pre-commit",
      ".git.\\hooks\\pre-commit",
      "GIT~1\\hooks\\pre-commit",
      "src\\a.ts:hidden",
      "src\\con",
    ]) {
      expect(() => resolveInRoot(root, p), p).toThrow();
    }
    expect(isGitInternal(root, resolveInRoot(root, ".GIT\\config"))).toBe(true);
  });
});
