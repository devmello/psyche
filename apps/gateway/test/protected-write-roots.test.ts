import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotProtected } from "@psyche/files";
import { describe, expect, it } from "vitest";
import {
  launchConfigLinks,
  protectedRoots,
  writeProtectedRoots,
  writeProtection,
  writeProtectionFor,
} from "../src/compose/protected-paths.ts";
import { isTarballInstall, psycheServerTarballRoot } from "../src/server-install.ts";

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

/** #1427 review r1, finding 5: the wider macOS list and the dot-entry rule under a home share. */
describe.skipIf(process.platform !== "darwin")(
  "write protection under a home share (macOS)",
  () => {
    const home = "/Users/owner";
    const homeShare = [{ path: home, mode: "rw" as const }];
    const refused = (rel: string, folders = homeShare) => {
      const path = join(home, rel);
      try {
        assertNotProtected(path, [], [], writeProtectionFor(path, folders, home));
        return false;
      } catch (err) {
        return (err as { code?: string }).code === "forbidden";
      }
    };

    it.each([
      "Library/Python/3.12/lib/python/site-packages/x.pth",
      "Library/Spotlight/x.mdimporter/Contents/Info.plist",
      "bin/tool",
      "BIN/tool",
      ".vscode/extensions/x/package.json",
      ".hammerspoon/init.lua",
      ".config/ghostty/config",
      ".config/zed/settings.json",
      ".newrc",
      ".cursor/mcp.json",
    ])("refuses ~/%s", (rel) => {
      expect(refused(rel)).toBe(true);
    });

    it.each(["notes.md", "Projects/app/.env", "binaries/readme.md", "Documents/.hidden-note.md"])(
      "allows ~/%s",
      (rel) => {
        expect(refused(rel)).toBe(false);
      },
    );

    it("leaves a dot folder shared by itself to its grant, and keeps the roots there", () => {
      const own = [...homeShare, { path: join(home, ".dotfiles"), mode: "rw" as const }];
      expect(refused(".dotfiles/zshrc", own)).toBe(false);
      expect(refused(".dotfiles/zshrc")).toBe(true);
      expect(writeProtection(home).dotHome).toBe(home);
    });
  },
);

/** #1434 review r1, finding 3: where symlinked launch config in the shared folders really is. */
describe.skipIf(process.platform === "win32")("launch-config link targets", () => {
  it("walks the shared folders again when they change or the cache is old", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "psyche-links-")));
    try {
      const vault = join(base, "Vault");
      const dotfiles = join(base, "dotfiles", "obsidian");
      mkdirSync(vault, { recursive: true });
      mkdirSync(dotfiles, { recursive: true });
      let folders = [{ path: join(base, "elsewhere"), mode: "rw" as const }];
      let t = 0;
      const links = launchConfigLinks(
        () => folders,
        1_000,
        () => t,
      );
      expect(links()).toEqual([]);
      symlinkSync(dotfiles, join(vault, ".obsidian"));
      folders = [{ path: vault, mode: "rw" as const }];
      expect(links()).toEqual([dotfiles]);
      rmSync(join(vault, ".obsidian"));
      expect(links()).toEqual([dotfiles]);
      t = 1_000;
      expect(links()).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("a psyche-server tarball install's root", () => {
  /** `<root>/releases/<v>/psyched/runtime/node` with the release's psyche-server.json. */
  function layout(kind: string, version = "1.5.0", dirName = version) {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "psy-tarball-")));
    const root = join(top, "my server");
    const release = join(root, "releases", dirName);
    mkdirSync(join(release, "psyched", "runtime"), { recursive: true });
    writeFileSync(join(release, "psyched", "runtime", "node"), "");
    writeFileSync(
      join(release, "psyche-server.json"),
      JSON.stringify({ format: "psyche-server-install", kind, version, arch: "x64" }),
    );
    symlinkSync(join("releases", dirName), join(root, "current"));
    return { top, root, node: join(root, "current", "psyched", "runtime", "node") };
  }

  it("is found from this Gateway's own Node, wherever --root put it, and no grant reaches it", () => {
    const l = layout("tarball");
    try {
      expect(psycheServerTarballRoot(l.node)).toEqual([l.root]);
      expect(isTarballInstall(l.node)).toBe(true);
      expect(() =>
        assertNotProtected(join(l.root, "releases", "1.5.0", "psyched", "app", "x.js"), [
          ...psycheServerTarballRoot(l.node),
        ]),
      ).toThrow();
    } finally {
      rmSync(l.top, { recursive: true, force: true });
    }
  });

  it("must refuse: a deb or rpm, a folder not named as its version, or no description", () => {
    for (const l of [layout("deb"), layout("rpm"), layout("tarball", "1.5.0", "other")]) {
      try {
        expect(psycheServerTarballRoot(l.node)).toEqual([]);
      } finally {
        rmSync(l.top, { recursive: true, force: true });
      }
    }
    expect(psycheServerTarballRoot(process.execPath)).toEqual([]);
    expect(psycheServerTarballRoot("/nonexistent/runtime/node")).toEqual([]);
  });

  it("is in the protected roots on Linux, where this Gateway runs from one", () => {
    // This test process is not a tarball install: nothing is added.
    const linux = protectedRoots("/h/.psyche", "linux", "/h");
    expect(linux.some((p) => p.includes("psyche-server"))).toBe(false);
  });
});
