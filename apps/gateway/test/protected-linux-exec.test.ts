import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { assertNotProtected, isProtectedPath, writeProtectedRoot } from "@psyche/files";
import { defaultDenyRead } from "@psyche/mcp-host";
import {
  inSystemRoot,
  linuxRunCarveOuts,
  refuseFolder,
  writeProtectedHomeRoots,
} from "@psyche/permissions";
import { afterAll, describe, expect, it } from "vitest";
import {
  ownWorkdirs,
  protectedRoots,
  runCarveOuts,
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
  isProtectedPath(path, protectedRoots(PSYCHE_HOME, platform), [], runCarveOuts(platform));

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
  // Windows, with a Windows home path: "writeProtectedHomeRoots carries this PR's entries".
  it.each(["darwin", "linux"] as const)("on %s", (platform) => {
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

/** Review of #1294, round 6, finding 1: the Linux browser, chat and password stores. */
describe("Linux: credential stores are neither read nor written", () => {
  it.each([
    h(".config", "google-chrome", "Default", "Cookies"),
    h(".config", "chromium", "Default", "Login Data"),
    h(".config", "BraveSoftware", "Brave-Browser", "Default", "Cookies"),
    h(".config", "microsoft-edge", "Default", "Cookies"),
    h(".config", "vivaldi", "Default", "Cookies"),
    h(".local", "share", "keyrings", "login.keyring"),
    h(".config", "Signal", "config.json"),
    h(".config", "Slack", "Cookies"),
    h(".config", "discord", "Local Storage", "leveldb", "000003.log"),
    h(".config", "rclone", "rclone.conf"),
    h(".mozilla", "firefox", "abc.default-release", "cookies.sqlite"),
    h(".mozilla", "firefox", "abc.default-release", "logins.json"),
    h(".thunderbird", "abc.default", "key4.db"),
    h(".var", "app", "org.mozilla.firefox", ".mozilla", "firefox", "x", "cookies.sqlite"),
    h(".var", "app", "com.google.Chrome", "config", "google-chrome", "Default", "Cookies"),
    h(".var", "app", "org.chromium.Chromium", "config", "chromium", "Default", "Cookies"),
    h(".var", "app", "com.brave.Browser", "config", "BraveSoftware", "Default", "Cookies"),
    h("snap", "firefox", "common", ".mozilla", "firefox", "x", "cookies.sqlite"),
    h("snap", "chromium", "common", "chromium", "Default", "Cookies"),
    h(".password-store", "bank.gpg"),
    // Round 7: Telegram, Evolution, Teams.
    h(".local", "share", "TelegramDesktop", "tdata", "key_datas"),
    h(".config", "evolution", "sources", "abc.source"),
    h(".local", "share", "evolution", "mail", "local", "folders.db"),
    h(".config", "teams-for-linux", "Cookies"),
    h(".var", "app", "org.telegram.desktop", "data", "TelegramDesktop", "tdata", "key_datas"),
    h(".var", "app", "org.gnome.Evolution", "config", "evolution", "sources"),
    h(".var", "app", "com.github.IsmaelMartinez.teams_for_linux", "config", "Cookies"),
    h("snap", "telegram-desktop", "current", ".local", "share", "TelegramDesktop", "tdata"),
    h("snap", "teams-for-linux", "current", ".config", "teams-for-linux", "Cookies"),
  ])("refuses reading %s", (path) => {
    expect(readRefused(path, "linux")).toBe(true);
    // And MCP servers and host commands never read it either.
    expect(
      defaultDenyRead(PSYCHE_HOME, "linux").some((r) => path === r || path.startsWith(`${r}/`)),
    ).toBe(true);
  });

  it.each([
    h(".config", "nvim", "init.lua"),
    h(".config", "foo", "settings.ini"),
    h(".var", "app", "org.gnome.TextEditor", "config", "settings.ini"),
    h("snap", "code", "current", "notes.md"),
    h(".config", "Signals-notes.txt"),
    h(".local", "share", "TelegramDesktop", "log.txt"),
    h(".config", "evolution-notes.txt"),
  ])("still reads %s (writes stay refused under ~/.config)", (path) => {
    expect(readRefused(path, "linux")).toBe(false);
  });

  it("keeps ~/.config/nvim write-protected while readable", () => {
    expect(writeRefused(h(".config", "nvim", "init.lua"), "linux")).toBe(true);
  });

  // Round 7: developer CLI tokens, on every platform where gh and gcloud are listed.
  describe.each(["linux", "darwin", "win32"] as const)("CLI tokens on %s", (platform) => {
    it.each([
      h(".config", "glab-cli", "config.yml"),
      h(".config", "op", "config"),
      h(".op", "config"),
      h(".azure", "msal_token_cache.json"),
      h(".config", "doctl", "config.yaml"),
      h(".config", "hub"),
      h("Library", "Application Support", "glab-cli", "config.yml"),
      h("Library", "Application Support", "doctl", "config.yaml"),
    ])("refuses reading %s", (path) => {
      expect(
        defaultDenyRead(PSYCHE_HOME, platform).some(
          (r) => path === r || path.startsWith(`${r}/`),
        ),
      ).toBe(true);
      if (platform !== "win32") expect(readRefused(path, platform)).toBe(true);
    });
  });

  it("leaves the macOS deny list as it was", () => {
    const mac = defaultDenyRead(PSYCHE_HOME, "darwin");
    expect(mac).not.toContain(h(".mozilla"));
    expect(mac).toContain(h("Library", "Cookies"));
  });
});

/** Review of #1294, round 6, finding 3: one write-protected list, #1434's. */
describe("writeProtectedHomeRoots carries this PR's entries", () => {
  it("holds ~/.config, ~/.local and ~/.cache on Linux", () => {
    const roots = writeProtectedHomeRoots("/home/owner", "linux");
    for (const rel of [".config", ".local", ".cache", "bin", ".gitconfig", ".config/git"]) {
      expect(roots).toContain(`/home/owner/${rel}`);
    }
    expect(writeProtectedRoots(homedir(), "linux")).toContain(h(".config"));
  });

  it("holds ~/bin and git's config on Windows", () => {
    const roots = writeProtectedHomeRoots("C:\\Users\\owner", "win32");
    expect(roots).toContain("C:\\Users\\owner\\bin");
    expect(roots).toContain("C:\\Users\\owner\\.gitconfig");
    expect(roots).toContain("C:\\Users\\owner\\.config\\git");
  });

  it("does not hold ~/.config wholesale on macOS", () => {
    expect(writeProtectedHomeRoots("/Users/owner", "darwin")).not.toContain("/Users/owner/.config");
  });
});

/** Review of #1294, round 6, finding 3: carve-outs lift the never-read roots, not the write rules. */
describe("carve-outs are not Psyche's own folders", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "psyche-carve-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const run = join(base, "run");
  const drive = join(run, "media", "owner");
  mkdirSync(join(drive, "USB"), { recursive: true });
  const planted = join(drive, "USB", "autorun.sh");
  const refused = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  it("reads and writes on the drive, and the rest of the root stays refused", () => {
    expect(isProtectedPath(join(drive, "USB", "a.jpg"), [run], [], [drive])).toBe(false);
    expect(isProtectedPath(join(run, "user", "1000", "bus"), [run], [], [drive])).toBe(true);
    expect(
      refused(() => assertNotProtected(join(drive, "USB", "a.jpg"), [run], [], [], [drive])),
    ).toBe(false);
  });

  it("keeps every write rule on the drive", () => {
    // A write-protected root inside a carve-out is still refused (it would be skipped for a
    // Psyche-own folder, `ownDirs`).
    expect(refused(() => assertNotProtected(planted, [run], [], [planted], [drive]))).toBe(true);
    expect(refused(() => assertNotProtected(planted, [run], [drive], [planted]))).toBe(false);
  });

  it("is not part of ownWorkdirs", () => {
    expect(ownWorkdirs(join(base, "nowhere"))).toEqual([]);
    expect(runCarveOuts("linux")).toEqual(linuxRunCarveOuts());
    expect(runCarveOuts("darwin")).toEqual([]);
  });
});
