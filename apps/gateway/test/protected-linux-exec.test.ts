import { homedir } from "node:os";
import { join } from "node:path";
import { assertNotProtected } from "@psyche/files";
import { inSystemRoot, refuseFolder } from "@psyche/permissions";
import { describe, expect, it } from "vitest";
import { protectedRoots } from "../src/compose/protected-paths.ts";

/**
 * Review of #1294, rounds 3 and 4: on Linux no file tool writes, and no folder card grants, where
 * a written file runs code as the owner later. `~/.config`, `~/.local` and `~/.cache` are
 * protected wholesale (as `~/Library` is on macOS), and so are the shell start-up files; `~/bin`
 * and git's own config on every platform; `/run`, `/proc` and `/sys` are system roots on Linux.
 */
const h = (...p: string[]) => join(homedir(), ...p);
const PSYCHE_HOME = "/h/.psyche";
const linuxRoots = () => protectedRoots(PSYCHE_HOME, "linux");
const useTimeRefused = (path: string, roots: readonly string[]): boolean => {
  try {
    assertNotProtected(path, roots);
    return false;
  } catch {
    return true;
  }
};

/** Paths a file tool must never write on Linux, whatever folder was granted earlier. */
const MUST_REFUSE = [
  h(".config", "foo", "settings.ini"),
  h(".config", "autostart", "evil.desktop"),
  h(".config", "systemd", "user", "evil.service"),
  h(".config", "environment.d", "10-path.conf"),
  h(".config", "ubuntu-xdg-terminals.list"),
  h(".config", "GIMP", "2.10", "plug-ins", "evil.py"),
  h(".config", "blender", "4.1", "scripts", "startup", "evil.py"),
  h(".config", "libreoffice", "4", "user", "registrymodifications.xcu"),
  h(".config", "git", "config"),
  h(".local", "share", "applications", "org.gnome.Notes2.desktop"),
  h(".local", "share", "flatpak", "overrides", "global"),
  h(".local", "share", "flatpak", "overrides", "org.gnome.TextEditor"),
  h(".local", "share", "dbus-1", "services", "org.gnome.TextEditor.service"),
  h(".local", "share", "gnome-shell", "extensions", "evil@x", "extension.js"),
  h(".local", "share", "nautilus-python", "extensions", "evil.py"),
  h(".local", "lib", "python3.12", "site-packages", "evil.pth"),
  h(".local", "bin", "ls"),
  h(".cache", "xdg-terminal-exec"),
  h(".bashrc"),
  h(".profile"),
  h(".zshrc"),
  h(".bash_profile"),
  h(".gitconfig"),
  h("bin", "ls"),
  "/run/user/1000/dbus-1/services/org.gnome.TextEditor.service",
  "/run/user/1000/systemd/user/evil.service",
  "/proc/self/mem",
  "/sys/kernel/debug",
];

/** Ordinary places a granted folder may still reach. */
const MUST_ALLOW = [
  h("Documents", "notes.txt"),
  h("Projects", "app", ".git", "HEAD"),
  h("Projects", "app", ".config", "local.json"),
  h(".configs-backup", "a.txt"),
  h(".localized"),
  h("cache", "data.csv"),
  h("binder", "page.md"),
  h(".gitconfig-notes.md"),
  "/srv/data/report.csv",
  "/mnt/usb/photo.jpg",
  "/running/notes.txt",
];

describe("Linux: written-file-runs-code paths are protected", () => {
  it.each(MUST_REFUSE)("refuses %s at use time", (path) => {
    expect(useTimeRefused(path, linuxRoots())).toBe(true);
  });

  it.each(MUST_ALLOW)("allows %s", (path) => {
    expect(useTimeRefused(path, linuxRoots())).toBe(false);
  });

  it("refuses an older pick of a subfolder (~/.config/foo) when it is used", () => {
    // The grant was made before `~/.config` was protected: its paths are refused anyway.
    expect(useTimeRefused(h(".config", "foo"), linuxRoots())).toBe(true);
    expect(useTimeRefused(h(".config", "foo", "a", "b.txt"), linuxRoots())).toBe(true);
  });

  it.each([
    [h(".config"), "sensitive_root"],
    [h(".config", "foo"), "sensitive_root"],
    [h(".local"), "sensitive_root"],
    [h(".local", "share", "flatpak", "overrides"), "sensitive_root"],
    [h(".local", "lib"), "sensitive_root"],
    [h(".cache"), "sensitive_root"],
    [h("bin"), "sensitive_root"],
    [h(".config", "git"), "sensitive_root"],
    ["/run/user/1000", "sensitive_root"],
    ["/proc", "sensitive_root"],
    ["/sys/fs", "sensitive_root"],
  ])("refuses a new pick of %s on Linux", (folder, reason) => {
    expect(refuseFolder(folder, { psycheHome: PSYCHE_HOME, platform: "linux" })).toBe(reason);
  });

  it.each([h("Documents"), h("Projects", "app"), "/srv/data", "/mnt/usb"])(
    "still lets the owner pick %s on Linux",
    (folder) => {
      expect(refuseFolder(folder, { psycheHome: PSYCHE_HOME, platform: "linux" })).toBeUndefined();
    },
  );

  it("treats an older grant under /run, /proc or /sys as a system root on Linux only", () => {
    for (const p of ["/run/user/1000", "/proc/1", "/sys/class"]) {
      expect(inSystemRoot(p, { platform: "linux" })).toBe(true);
      expect(inSystemRoot(p, { platform: "darwin" })).toBe(false);
    }
  });
});

describe("every platform: git's config and ~/bin", () => {
  it.each(["darwin", "linux"] as const)("are protected on %s", (platform) => {
    const roots = protectedRoots(PSYCHE_HOME, platform);
    for (const p of [h(".gitconfig"), h(".config", "git", "config"), h("bin", "tool")]) {
      expect(useTimeRefused(p, roots)).toBe(true);
    }
    expect(refuseFolder(h("bin"), { psycheHome: PSYCHE_HOME, platform })).toBe("sensitive_root");
  });

  it("leaves macOS's other dot-folders as they were", () => {
    const roots = protectedRoots(PSYCHE_HOME, "darwin");
    expect(useTimeRefused(h(".config", "foo", "a.txt"), roots)).toBe(false);
    expect(useTimeRefused(h(".bashrc"), roots)).toBe(false);
    expect(refuseFolder(h(".config", "foo"), { psycheHome: PSYCHE_HOME, platform: "darwin" })).toBe(
      undefined,
    );
    // What every platform protects is still there.
    expect(useTimeRefused(h(".ssh", "id_ed25519"), roots)).toBe(true);
  });
});
