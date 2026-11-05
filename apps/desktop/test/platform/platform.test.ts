import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockPolicy } from "../../src/main/dock-policy.ts";
import { LoginItem } from "../../src/main/login-item.ts";
import { quickEntryShortcuts } from "../../src/main/shortcuts.ts";
import type { Runner } from "../../src/main/supervisor-base.ts";
import {
  autostartPath,
  desktopExecArg,
  renderAutostartEntry,
} from "../../src/platform/autostart.ts";
import { checkDiskEncryption, parseLsblk } from "../../src/platform/disk-encryption.ts";
import { quitsOnLastWindowClosed, traitsFor } from "../../src/platform/index.ts";
import {
  linuxAutostartExec,
  linuxGatewayLaunch,
  linuxInstallKind,
  linuxPackageManager,
} from "../../src/platform/install-kind.ts";
import { Linger } from "../../src/platform/linger.ts";
import { guardSafeStorage, type SafeStorageLike } from "../../src/platform/secrets.ts";
import { statusNotifierAvailable } from "../../src/platform/tray-support.ts";

const ok = { code: 0, stdout: "", stderr: "" };

describe("traits", () => {
  it("macOS keeps its Dock and quarantine; Windows and Linux have neither", () => {
    expect(traitsFor("darwin")).toMatchObject({
      dock: true,
      quarantine: true,
      trayTitle: true,
      glass: true,
    });
    for (const p of ["win32", "linux"] as const) {
      expect(traitsFor(p)).toMatchObject({
        dock: false,
        quarantine: false,
        trayTitle: false,
        glass: false,
      });
    }
  });

  it("Linux uses Ctrl+Alt+Space; Windows and macOS keep today's lists", () => {
    expect(traitsFor("linux").quickEntry).toEqual(["Control+Alt+Space"]);
    expect(quickEntryShortcuts("linux")).toEqual(["Control+Alt+Space"]);
    expect(quickEntryShortcuts("win32")).toEqual(traitsFor("win32").quickEntry);
    expect(quickEntryShortcuts("darwin")).toEqual(["Alt+Space", "Control+Alt+Space"]);
  });

  it("last window: macOS and Windows stay; Linux stays only with a tray", () => {
    expect(quitsOnLastWindowClosed("darwin", false)).toBe(false);
    expect(quitsOnLastWindowClosed("win32", false)).toBe(false);
    expect(quitsOnLastWindowClosed("linux", true)).toBe(false);
    expect(quitsOnLastWindowClosed("linux", false)).toBe(true);
    expect(quitsOnLastWindowClosed("freebsd", true)).toBe(true);
  });

  it("only Linux asks for the system's own title bar", () => {
    expect(traitsFor("linux").nativeTitleBar).toBe(true);
    expect(traitsFor("darwin").nativeTitleBar).toBe(false);
    expect(traitsFor("win32").nativeTitleBar).toBe(false);
  });

  it("the dock policy does nothing off macOS", () => {
    const calls: string[] = [];
    const app = { setActivationPolicy: (p: string) => calls.push(p), focus: () => undefined };
    const linux = new DockPolicy({ app, platform: "linux", graceMs: 0 });
    linux.windowsChanged(0);
    expect(calls).toEqual([]);
    const mac = new DockPolicy({ app, platform: "darwin", graceMs: 0 });
    mac.windowsChanged(0);
    expect(calls).toEqual(["accessory"]);
  });
});

describe("install kind", () => {
  it("AppImage runs itself with --psyched and owns the unit; a package uses /usr/lib/psyche", () => {
    const env = { APPIMAGE: "/home/me/Psyche.AppImage", APPDIR: "/tmp/.mount_PsycheAbc" };
    const probe = {
      execPath: "/tmp/.mount_PsycheAbc/usr/lib/psyche/psyche",
      mountInfo: () =>
        "36 35 0:42 / /tmp/.mount_PsycheAbc ro,nosuid - fuse.Psyche.AppImage /home/me/Psyche.AppImage ro
",
    };
    expect(linuxInstallKind(env, probe)).toBe("appimage");
    expect(linuxGatewayLaunch(env, probe)).toEqual({
      program: "/home/me/Psyche.AppImage",
      args: ["--psyched"],
      install: "user",
    });
    expect(linuxGatewayLaunch({})).toEqual({
      program: "/usr/lib/psyche/resources/psyched/psyched",
      args: [],
      install: "packaged",
    });
    expect(linuxAutostartExec({})).toEqual(["/usr/bin/psyche"]);
    expect(linuxAutostartExec(env, probe)).toEqual(["/home/me/Psyche.AppImage"]);
  });

  it("finds the package manager with dpkg -S, then rpm -qf, on /usr/lib/psyche", async () => {
    const seen: string[] = [];
    const mk =
      (good: string): Runner =>
      async (file, args) => {
        seen.push(`${file} ${args.join(" ")}`);
        return file === good ? ok : { ...ok, code: 1 };
      };
    expect(await linuxPackageManager(mk("dpkg"))).toBe("apt");
    expect(await linuxPackageManager(mk("rpm"))).toBe("dnf");
    expect(await linuxPackageManager(mk("none"))).toBeUndefined();
    expect(seen).toContain("dpkg -S /usr/lib/psyche");
    expect(seen).toContain("rpm -qf /usr/lib/psyche");
  });
});

describe("autostart and the login item on Linux", () => {
  it("renders an XDG entry that starts the app hidden, quoting what needs it", () => {
    const text = renderAutostartEntry(["/home/me/My Apps/Psyche.AppImage", "--background"]);
    expect(text).toContain('Exec="/home/me/My Apps/Psyche.AppImage" --background');
    expect(text).toContain("Type=Application");
    expect(desktopExecArg("100%")).toBe("100%%");
    expect(autostartPath({}, "/home/me")).toBe("/home/me/.config/autostart/psyche.desktop");
    expect(autostartPath({ XDG_CONFIG_HOME: "/c" }, "/home/me")).toBe(
      "/c/autostart/psyche.desktop",
    );
  });

  it("LoginItem writes and removes the entry only when given autostart options", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-autostart-"));
    try {
      const file = join(dir, "autostart", "psyche.desktop");
      const electronCalls: unknown[] = [];
      const app = { setLoginItemSettings: (s: unknown) => electronCalls.push(s) };
      new LoginItem(app, { platform: "linux" }).set(true);
      expect(existsSync(file)).toBe(false);
      const item = new LoginItem(app, {
        platform: "linux",
        autostart: { file, exec: ["/usr/bin/psyche"] },
      });
      item.set(true);
      expect(readFileSync(file, "utf8")).toContain("Exec=/usr/bin/psyche --background");
      item.set(false);
      expect(existsSync(file)).toBe(false);
      expect(electronCalls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linger", () => {
  it("reads and changes lingering through loginctl, only when it differs", async () => {
    const calls: string[] = [];
    let linger = "no";
    const run: Runner = async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (args[0] === "show-user") return { ...ok, stdout: `${linger}\n` };
      if (args[0] === "enable-linger") linger = "yes";
      return ok;
    };
    const l = new Linger(run, { platform: "linux", user: "me" });
    expect(await l.status()).toBe(false);
    expect(await l.set(true)).toBe(true);
    expect(calls).toContain("loginctl enable-linger");
    const n = calls.length;
    expect(await l.set(true)).toBe(true);
    expect(calls.slice(n)).toEqual(["loginctl show-user me -p Linger --value"]);
    expect(await new Linger(run, { platform: "darwin" }).set(true)).toBe(false);
  });
});

describe("tray probe", () => {
  it("is available when a StatusNotifierWatcher owns its name, via busctl or gdbus", async () => {
    const watcher: Runner = async (file, args) =>
      file === "busctl" && args.includes("org.kde.StatusNotifierWatcher")
        ? { ...ok, stdout: "b true\n" }
        : { ...ok, stdout: "b false\n" };
    expect(await statusNotifierAvailable(watcher)).toBe(true);
    const gdbusOnly: Runner = async (file) =>
      file === "gdbus" ? { ...ok, stdout: "(true,)\n" } : { ...ok, code: 127 };
    expect(await statusNotifierAvailable(gdbusOnly)).toBe(true);
  });

  it("is unavailable on stock GNOME or when the bus cannot be asked", async () => {
    expect(await statusNotifierAvailable(async () => ({ ...ok, stdout: "b false\n" }))).toBe(false);
    expect(await statusNotifierAvailable(async () => ({ ...ok, code: 1 }))).toBe(false);
  });
});

describe("safeStorage guard", () => {
  const storage = (backend: string, available = true): SafeStorageLike => ({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from(s),
  });

  it("refuses to store anything under basic_text", () => {
    const s = storage("basic_text");
    expect(guardSafeStorage(s, "linux")).toMatchObject({ usable: false, reason: "basic_text" });
    expect(s.isEncryptionAvailable()).toBe(false);
    expect(() => s.encryptString("x")).toThrow(/will not store secrets/);
  });

  it("leaves a real keyring backend, and other platforms, alone", () => {
    const s = storage("gnome_libsecret");
    expect(guardSafeStorage(s, "linux")).toEqual({ usable: true, backend: "gnome_libsecret" });
    expect(s.encryptString("x").toString()).toBe("x");
    const mac = storage("basic_text");
    expect(guardSafeStorage(mac, "darwin")).toMatchObject({ usable: true });
    expect(mac.encryptString("x").toString()).toBe("x");
  });
});

describe("full-disk-encryption check", () => {
  const tree = (nodes: unknown) => JSON.stringify({ blockdevices: nodes });
  it("finds LUKS under the volume that holds the home folder", () => {
    const luks = tree([
      {
        type: "crypt",
        mountpoints: ["/"],
        children: [{ type: "part", mountpoints: [null] }],
      },
    ]);
    expect(parseLsblk(luks, "/home/me/.psyche")).toEqual({ status: "encrypted", mount: "/" });
  });

  it("uses the longest covering mount: an unencrypted /home on an encrypted /", () => {
    const t = tree([
      { type: "crypt", mountpoints: ["/"], children: [] },
      { type: "part", mountpoints: ["/home"], children: [{ type: "disk", mountpoints: [null] }] },
    ]);
    expect(parseLsblk(t, "/home/me")).toEqual({ status: "not_encrypted", mount: "/home" });
  });

  it("is unknown for bad output or no covering mount", async () => {
    expect(parseLsblk("not json", "/home/me")).toEqual({ status: "unknown" });
    expect(parseLsblk(tree([]), "/home/me")).toEqual({ status: "unknown" });
    expect(await checkDiskEncryption(async () => ({ ...ok, code: 1 }), "/home/me")).toEqual({
      status: "unknown",
    });
  });
});
