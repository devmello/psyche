import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  detectInstallKind,
  evaluateLinuxGate,
  linuxUpdatePaths,
  type RunCommand,
} from "../../src/packaging/linux-install.ts";

/** Install-kind detection and the Linux updater gate, with a fake `dpkg`/`rpm`. */

function runner(owners: { dpkg?: boolean; rpm?: boolean; missing?: string[] }) {
  const calls: string[][] = [];
  const run: RunCommand = async (file, args) => {
    calls.push([file, ...args]);
    if (owners.missing?.includes(file)) throw new Error("ENOENT");
    const ok =
      file === "/usr/bin/dpkg" ? owners.dpkg : file === "/usr/bin/rpm" ? owners.rpm : false;
    return { code: ok ? 0 : 1, stdout: "", stderr: "" } satisfies CommandResult;
  };
  return { run, calls };
}

const EXE = "/usr/lib/psyche/psyche";

describe("detectInstallKind", () => {
  it("an absolute $APPIMAGE means AppImage, without asking a package manager", async () => {
    const r = runner({ dpkg: true });
    const got = await detectInstallKind({
      env: { APPIMAGE: "/home/me/Applications/Psyche.AppImage" },
      execPath: "/tmp/.mount_x/psyche",
      run: r.run,
    });
    expect(got).toEqual({
      kind: "appimage",
      appImagePath: "/home/me/Applications/Psyche.AppImage",
    });
    expect(r.calls).toEqual([]);
  });

  it("ignores a relative or empty $APPIMAGE", async () => {
    for (const v of ["Psyche.AppImage", "", "  "]) {
      const r = runner({});
      expect(
        await detectInstallKind({ env: { APPIMAGE: v }, execPath: "/opt/x/psyche", run: r.run }),
      ).toBeUndefined();
    }
  });

  it("deb: the app under /usr/lib/psyche owned by dpkg", async () => {
    const r = runner({ dpkg: true });
    expect(await detectInstallKind({ env: {}, execPath: EXE, run: r.run })).toEqual({
      kind: "deb",
    });
    expect(r.calls).toEqual([["/usr/bin/dpkg", "-S", EXE]]);
  });

  it("rpm: not dpkg's, but rpm's", async () => {
    const r = runner({ rpm: true });
    expect(await detectInstallKind({ env: {}, execPath: EXE, run: r.run })).toEqual({
      kind: "rpm",
    });
  });

  it("an rpm system without dpkg installed still resolves", async () => {
    const r = runner({ rpm: true, missing: ["/usr/bin/dpkg"] });
    expect(await detectInstallKind({ env: {}, execPath: EXE, run: r.run })).toEqual({
      kind: "rpm",
    });
  });

  it("a tarball, a moved copy or a development build has no kind", async () => {
    const r = runner({ dpkg: true, rpm: true });
    for (const execPath of [
      "/opt/Psyche/psyche",
      "/home/me/dev/node_modules/electron/dist/electron",
      "/usr/lib/psyche-evil/psyche",
    ]) {
      expect(await detectInstallKind({ env: {}, execPath, run: r.run })).toBeUndefined();
    }
    expect(r.calls).toEqual([]);
  });

  it("under /usr/lib/psyche but owned by no package: none", async () => {
    const r = runner({});
    expect(await detectInstallKind({ env: {}, execPath: EXE, run: r.run })).toBeUndefined();
  });
});

describe("evaluateLinuxGate", () => {
  const base = {
    platform: "linux",
    isPackaged: true,
    keyCount: 1,
    install: { kind: "deb" as const },
  };

  it("runs for a packaged, keyed, known install and says which kind", () => {
    expect(evaluateLinuxGate(base)).toEqual({ run: true, kind: "deb" });
  });
  it("stays off for other systems, dev builds and unknown installs", () => {
    expect(evaluateLinuxGate({ ...base, platform: "darwin" })).toMatchObject({
      run: false,
      state: "disabled",
    });
    expect(evaluateLinuxGate({ ...base, isPackaged: false })).toMatchObject({
      run: false,
      state: "disabled",
    });
    expect(evaluateLinuxGate({ ...base, install: undefined })).toMatchObject({
      run: false,
      state: "disabled",
    });
  });
  it("stays off while no release key is embedded", () => {
    expect(evaluateLinuxGate({ ...base, keyCount: 0 })).toMatchObject({
      run: false,
      state: "no_keys",
    });
  });
});

describe("linuxUpdatePaths", () => {
  it("follows XDG when the variables are absolute, else ~/.cache and ~/.local/share", () => {
    expect(linuxUpdatePaths({}, "/home/me")).toEqual({
      updatesDir: "/home/me/.cache/psyche/updates",
      packageDir: "/home/me/.cache/psyche/installed",
      previousPackageDir: "/home/me/.cache/psyche/previous",
      previousImageDir: "/home/me/.local/share/psyche/previous",
    });
    const p = linuxUpdatePaths({ XDG_CACHE_HOME: "/c", XDG_DATA_HOME: "/d" }, "/home/me");
    expect(p.updatesDir).toBe("/c/psyche/updates");
    expect(p.previousImageDir).toBe("/d/psyche/previous");
    expect(linuxUpdatePaths({ XDG_CACHE_HOME: "relative" }, "/home/me").updatesDir).toBe(
      "/home/me/.cache/psyche/updates",
    );
  });
});
