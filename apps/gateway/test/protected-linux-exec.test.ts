import { homedir } from "node:os";
import { join } from "node:path";
import { refuseFolder } from "@psyche/permissions";
import { describe, expect, it } from "vitest";
import { protectedRoots } from "../src/compose/protected-paths.ts";

/**
 * Review of #1294, round 3, finding 1: on Linux a file tool must not write where a file runs as
 * the owner later (a desktop entry `apps.open` would launch, autostart, user services, the shell's
 * start-up files), whatever folder the owner granted.
 */
const h = (...p: string[]) => join(homedir(), ...p);

describe("Linux exec paths are protected", () => {
  it.each([
    h(".local", "share", "applications"),
    h(".local", "share", "flatpak", "exports"),
    h(".local", "share", "dbus-1"),
    h(".local", "share", "xdg-terminals"),
    h(".config", "autostart"),
    h(".config", "systemd", "user"),
    h(".config", "environment.d"),
    h(".config", "xdg-terminals.list"),
    h(".config", "fish", "config.fish"),
    h(".bashrc"),
    h(".profile"),
    h(".zshrc"),
    h(".bash_profile"),
    h(".xprofile"),
  ])("%s on Linux", (path) => {
    expect(protectedRoots("/h/.psyche", "linux")).toContain(path);
  });

  it("a granted folder that contains one is refused on Linux", () => {
    const roots = protectedRoots("/h/.psyche", "linux");
    for (const folder of [h(".local", "share"), h(".config", "systemd")]) {
      expect(refuseFolder(folder, { psycheHome: "/h/.psyche", protectedRoots: roots })).toBe(
        "contains_sensitive_root",
      );
    }
  });

  it("leaves macOS and Windows as they were", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const roots = protectedRoots("/h/.psyche", platform);
      expect(roots).not.toContain(h(".bashrc"));
      expect(roots).not.toContain(h(".local", "share", "applications"));
      // What every platform protects is still there.
      expect(roots).toContain(h(".ssh"));
    }
  });
});
