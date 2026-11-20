import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { isProtectedPath, writeProtectedRoot } from "@psyche/files";
import { inSystemRoot, linuxRunCarveOuts, refuseFolder } from "@psyche/permissions";
import { afterAll, describe, expect, it } from "vitest";
import {
  ownWorkdirs,
  protectedRoots,
  writeProtectedRoots,
} from "../src/compose/protected-paths.ts";

/**
 * Review of #1294, rounds 3 to 5, in #1427's model: where a written file runs code later is
 * write-protected (folded and by identity, `writeProtectedRoots`); reads there follow the grants.
 * Only secrets and `/run`, `/proc`, `/sys` are neither read nor written (`protectedRoots`).
 */
const h = (...p: string[]) => join(homedir(), ...p);
const PSYCHE_HOME = "/h/.psyche";
const writeRefused = (path: string, platform: NodeJS.Platform, home = homedir()): boolean =>
  writeProtectedRoot(path, writeProtectedRoots(home, platform)) !== undefined;
const readRefused = (path: string, platform: NodeJS.Platform): boolean =>
  isProtectedPath(path, protectedRoots(PSYCHE_HOME, platform), ownWorkdirs(PSYCHE_HOME, platform));

/** Linux paths no agent write may reach, whatever folder was granted earlier. */
const LINUX_WRITE_REFUSED = [
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
  h(".local", "share", "dbus-1", "services", "org.gnome.TextEditor.service"),
  h(".local", "share", "gnome-shell", "extensions", "evil@x", "extension.js"),
  h(".local", "lib", "python3.12", "site-packages", "evil.pth"),
  h(".cache", "xdg-terminal-exec"),
  h(".bashrc"),
  h(".profile"),
  h(".zshrc"),
  h(".bash_profile"),
  h(".xprofile"),
  h(".pam_environment"),
  h(".gitconfig"),
  h("bin", "ls"),
];

/** Ordinary places a granted folder may still write. */
const WRITE_ALLOWED = [
  h("Documents", "notes.txt"),
  h("Projects", "app", ".config", "local.json"),
  h(".configs-backup", "a.txt"),
  h("cache", "data.csv"),
  h("binder", "page.md"),
  h(".gitconfig-notes.md"),
  "/srv/data/report.csv",
];

describe("Linux: written-file-runs-code paths are write-protected", () => {
  it.each(LINUX_WRITE_REFUSED)("refuses writing %s", (path) => {
    expect(writeRefused(path, "linux")).toBe(true);
  });

  it.each(WRITE_ALLOWED)("allows writing %s", (path) => {
    expect(writeRefused(path, "linux")).toBe(false);
  });

  // Reads follow the grants (#1427): the agent may read the owner's nvim config or `.bashrc`.
  it.each(LINUX_WRITE_REFUSED)("does not refuse reading %s", (path) => {
    expect(readRefused(path, "linux")).toBe(false);
  });

  it("keeps the CLI binary folders (`~/.local/bin`) neither read nor written", () => {
    expect(writeRefused(h(".local", "bin", "ls"), "linux")).toBe(true);
    expect(readRefused(h(".local", "bin", "ls"), "linux")).toBe(true);
  });

  it("refuses writing under an older pick of a subfolder (~/.config/foo)", () => {
    expect(writeRefused(h(".config", "foo"), "linux")).toBe(true);
    expect(writeRefused(h(".config", "foo", "a", "b.txt"), "linux")).toBe(true);
  });

  it.each([
    h(".config"),
    h(".config", "foo"),
    h(".local"),
    h(".local", "share", "flatpak", "overrides"),
    h(".cache"),
    h("bin"),
    h(".config", "git"),
    "/run/user/1000",
    "/proc",
    "/sys/fs",
  ])("refuses a new pick of %s on Linux", (folder) => {
    expect(refuseFolder(folder, { psycheHome: PSYCHE_HOME, platform: "linux" })).toBe(
      "sensitive_root",
    );
  });

  it.each([h("Documents"), h("Projects", "app"), "/srv/data", "/mnt/usb"])(
    "still lets the owner pick %s on Linux",
    (folder) => {
      expect(refuseFolder(folder, { psycheHome: PSYCHE_HOME, platform: "linux" })).toBeUndefined();
    },
  );
});

/** Review of #1294, round 5, finding 3: the owner's drives and network mounts under `/run`. */
describe("Linux: /run, /proc and /sys", () => {
  const uid = process.getuid?.() ?? 1000;
  const drive = join("/run/media", userInfo().username, "USB");
  const gvfs = `/run/user/${uid}/gvfs/smb-share:server=nas,share=photos`;

  it("names the carve-outs for this account", () => {
    expect(linuxRunCarveOuts()).toEqual([
      join("/run/media", userInfo().username),
      `/run/user/${uid}/gvfs`,
    ]);
  });

  it.each([
    `/run/user/${uid}/dbus-1/services/org.gnome.TextEditor.service`,
    `/run/user/${uid}/systemd/user/evil.service`,
    `/run/user/${uid}/keyring/control`,
    "/run/media/someone-else/USB/a.txt",
    "/run/systemd/notify",
    "/proc/self/environ",
    "/sys/kernel/debug",
  ])("neither reads nor writes %s", (path) => {
    expect(readRefused(path, "linux")).toBe(true);
  });

  it.each([join(drive, "photo.jpg"), join(gvfs, "2024", "a.jpg")])(
    "reads and writes the owner's own mount %s",
    (path) => {
      expect(readRefused(path, "linux")).toBe(false);
      expect(writeRefused(path, "linux")).toBe(false);
    },
  );

  it("lets the owner pick a drive or a network mount, never the rest of /run", () => {
    const env = { psycheHome: PSYCHE_HOME, platform: "linux" as const };
    expect(refuseFolder(drive, env)).toBeUndefined();
    expect(refuseFolder(gvfs, env)).toBeUndefined();
    expect(refuseFolder(`/run/user/${uid}`, env)).toBe("sensitive_root");
    expect(refuseFolder(`/run/user/${uid}/systemd`, env)).toBe("sensitive_root");
    expect(refuseFolder("/run/media/someone-else/USB", env)).toBe("sensitive_root");
  });

  it("treats an older grant under /run, /proc or /sys as a system root on Linux only", () => {
    for (const p of [`/run/user/${uid}`, "/proc/1", "/sys/class"]) {
      expect(inSystemRoot(p, { platform: "linux" })).toBe(true);
      expect(inSystemRoot(p, { platform: "darwin" })).toBe(false);
    }
    expect(inSystemRoot(drive, { platform: "linux" })).toBe(false);
    expect(inSystemRoot(gvfs, { platform: "linux" })).toBe(false);
  });
});

describe("every platform: git's config and ~/bin are write-protected", () => {
  it.each(["darwin", "linux", "win32"] as const)("on %s", (platform) => {
    for (const p of [h(".gitconfig"), h(".config", "git", "config"), h("bin", "tool")]) {
      expect(writeRefused(p, platform)).toBe(true);
      expect(readRefused(p, platform)).toBe(false);
    }
  });

  it.runIf(process.platform === "darwin")(
    "folds the name as APFS does: ~/BIN/tool and ~/.GITCONFIG",
    () => {
      expect(writeRefused(h("BIN", "tool"), "darwin")).toBe(true);
      expect(writeRefused(h(".GITCONFIG"), "darwin")).toBe(true);
      expect(writeRefused(h(".config", "GIT", "config"), "darwin")).toBe(true);
    },
  );

  it("leaves macOS's other dot-folders writable", () => {
    expect(writeRefused(h(".config", "foo", "a.txt"), "darwin")).toBe(false);
    expect(readRefused(h(".ssh", "id_ed25519"), "darwin")).toBe(true);
  });
});

/** Review of #1294, round 5, finding 1: dotfiles linked from a repository (stow, chezmoi, yadm). */
describe("symlinked dotfiles", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "psyche-dotfiles-")));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "code", "dotfiles"), { recursive: true });
  mkdirSync(join(home, "code", "app"), { recursive: true });
  mkdirSync(join(home, "scripts"), { recursive: true });
  writeFileSync(join(home, "code", "dotfiles", "gitconfig"), "[core]\n");
  writeFileSync(join(home, "code", "dotfiles", "bashrc"), "# rc\n");
  symlinkSync(join(home, "code", "dotfiles", "gitconfig"), join(home, ".gitconfig"));
  symlinkSync(join(home, "code", "dotfiles", "bashrc"), join(home, ".bashrc"));
  symlinkSync(join(home, "scripts"), join(home, "bin"));

  it.each(["darwin", "linux"] as const)(
    "on %s, the folders holding the targets stay pickable, and the targets are not writable",
    (platform) => {
      const env = {
        home,
        psycheHome: PSYCHE_HOME,
        platform,
        protectedRoots: protectedRoots(PSYCHE_HOME, platform, home),
      };
      for (const folder of ["code", join("code", "dotfiles"), join("code", "app"), "scripts"]) {
        expect(refuseFolder(join(home, folder), env)).toBeUndefined();
      }
      for (const target of [
        join("code", "dotfiles", "gitconfig"),
        join("code", "dotfiles", "bashrc"),
        join("scripts", "tool"),
      ]) {
        expect(writeRefused(join(home, target), platform, home)).toBe(true);
      }
      // The repository's other files stay writable.
      expect(writeRefused(join(home, "code", "dotfiles", "README.md"), platform, home)).toBe(false);
      expect(writeRefused(join(home, "code", "app", "main.ts"), platform, home)).toBe(false);
    },
  );
});
