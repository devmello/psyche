import { join } from "node:path";
import { assertNotProtected } from "@psyche/files";
import { describe, expect, it } from "vitest";
import { protectedRoots, writeProtectedRoots } from "../src/compose/protected-paths.ts";

/**
 * Write-only protected roots (apps.open review, findings 1 and 2): the launch location the Mac
 * helper trusts, Psyche.app's own install folders and the persistence locations under the owner's
 * home. Reads there are untouched.
 */
describe.skipIf(process.platform === "win32")("write-protected roots", () => {
  const home = "/Users/owner";
  const roots = writeProtectedRoots(home);

  it("covers ~/Applications, Psyche.app in both install folders and the persistence paths", () => {
    expect(roots).toEqual(
      expect.arrayContaining([
        join(home, "Applications"),
        join(home, "Applications", "Psyche.app"),
        "/Applications/Psyche.app",
        join(home, "Library/LaunchAgents"),
        join(home, ".zshrc"),
        join(home, ".gitconfig"),
      ]),
    );
  });

  it.each([
    "Applications/Notes.app/Contents/MacOS/Notes",
    "Applications/Psyche.app/Contents/Resources/helper",
    "Library/LaunchAgents/x.plist",
    ".zshenv",
    ".config/fish/conf.d/x.fish",
  ])("refuses writing ~/%s, while reading it follows the grants", (rel) => {
    const path = join(home, rel);
    expect(() => assertNotProtected(path, [], [], roots)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => assertNotProtected(path, [])).not.toThrow();
  });

  it("refuses writing into Psyche.app in /Applications", () => {
    expect(() =>
      assertNotProtected("/Applications/Psyche.app/Contents/MacOS/Psyche", [], [], roots),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("leaves ordinary folders writable and keeps the read-and-write roots as they were", () => {
    expect(() =>
      assertNotProtected(join(home, "Projects/app/src/index.ts"), [], [], roots),
    ).not.toThrow();
    expect(protectedRoots("/tmp/psyche-home")).not.toContain(join(home, "Applications"));
  });
});
