import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  authenticodeAcceptable,
  authenticodeStatus,
  HelperLauncher,
  type HelperRunState,
  helperCanHoldKeychain,
  helperExecutable,
  helperPathFor,
  isHostHelperKind,
  readHelperIdentity,
} from "../../src/main/helper-launcher.ts";
import type { Runner } from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-winhelper-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const exe = join(dir, "win-helper", "psyche-helper.exe");
mkdirSync(join(dir, "win-helper"), { recursive: true });
writeFileSync(exe, "");

describe("the Windows helper's location", () => {
  it("is in the packaged resources, else the repo's Rust build (release before debug)", () => {
    expect(
      helperPathFor({
        platform: "win32",
        packaged: true,
        resourcesPath: "C:\\P\\resources",
        appPath: "C:\\P\\resources\\app.asar",
      }),
    ).toBe(join("C:\\P\\resources", "win-helper", "psyche-helper.exe"));
    const desktop = join("D:\\repo", "apps", "desktop");
    const target = join(desktop, "..", "win-helper", "target");
    const release = join(target, "release", "psyche-helper.exe");
    const debug = join(target, "debug", "psyche-helper.exe");
    const dev = (have: string[]) =>
      helperPathFor({
        platform: "win32",
        packaged: false,
        resourcesPath: "x",
        appPath: desktop,
        exists: (p) => have.includes(p),
      });
    expect(dev([release, debug])).toBe(release);
    expect(dev([debug])).toBe(debug);
    expect(dev([])).toBeUndefined();
    // macOS keeps its rule: packaged only.
    expect(
      helperPathFor({ platform: "darwin", packaged: false, resourcesPath: "/R", appPath: "/A" }),
    ).toBeUndefined();
    expect(
      helperPathFor({ platform: "darwin", packaged: true, resourcesPath: "/R", appPath: "/A" }),
    ).toBe(join("/R", "PsycheHelper.app"));
  });

  it("treats the Mac and the Windows helper as this computer's helper", () => {
    expect(isHostHelperKind("mac-helper")).toBe(true);
    expect(isHostHelperKind("win-helper")).toBe(true);
    expect(isHostHelperKind("vm-guest")).toBe(false);
    expect(isHostHelperKind(undefined)).toBe(false);
  });

  it("runs the .exe itself for its identity, and never offers the Keychain slot", async () => {
    expect(helperExecutable(exe)).toBe(exe);
    expect(helperExecutable("/R/PsycheHelper.app")).toBe(
      join("/R/PsycheHelper.app", "Contents", "MacOS", "psyche-helper"),
    );
    const seen: string[] = [];
    const id = await readHelperIdentity(exe, "C:\\h", async (file) => {
      seen.push(file);
      return { code: 0, stdout: JSON.stringify({ deviceId: "dev_abcdefghijklmnopqrstuv" }) };
    });
    expect(seen).toEqual([exe]);
    expect(id).toEqual({ deviceId: "dev_abcdefghijklmnopqrstuv" });
    const never: Runner = async () => {
      throw new Error("codesign must not run on Windows");
    };
    expect(await helperCanHoldKeychain(exe, never)).toBe(false);
  });
});

describe("HelperLauncher on Windows", () => {
  function fake(o: { signature?: string; spawnError?: string } = {}) {
    const spawned: { file: string; home?: string }[] = [];
    const ran: string[][] = [];
    let started = false;
    let t = 0;
    const states: HelperRunState[] = [];
    const launcher = new HelperLauncher({
      appPath: exe,
      psycheHome: "C:\\Users\\a\\.psyche-test",
      platform: "win32",
      run: async (file, args) => {
        ran.push([file, ...args]);
        return { code: 0, stdout: `${o.signature ?? "NotSigned"}\r\n`, stderr: "" };
      },
      verifySignature: o.signature !== undefined,
      launchDetached: async (file, _args, env) => {
        spawned.push({ file, ...(env.PSYCHE_HOME ? { home: env.PSYCHE_HOME } : {}) });
        if (o.spawnError) return { ok: false, error: o.spawnError };
        started = true;
        return { ok: true };
      },
      isPaired: async () => started,
      onState: (s) => states.push(s),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    return { launcher, spawned, ran, states, advance: (ms: number) => (t += ms) };
  }

  it("starts the .exe detached with PSYCHE_HOME, once, and waits for it to pair", async () => {
    const f = fake();
    await Promise.all([f.launcher.launch(), f.launcher.launch()]);
    expect(f.spawned).toEqual([{ file: exe, home: "C:\\Users\\a\\.psyche-test" }]);
    expect(f.states.map((s) => s.kind)).toEqual(["starting", "paired"]);
    // No LaunchServices, no codesign on Windows.
    expect(f.ran).toEqual([]);
  });

  it("reports a spawn failure", async () => {
    const f = fake({ spawnError: "spawn EACCES" });
    await f.launcher.launch();
    expect(f.launcher.getState()).toEqual({ kind: "offline", reason: "spawn EACCES" });
  });

  it("checks a packaged helper's Authenticode signature: valid or unsigned launch, a bad one never", async () => {
    for (const ok of ["Valid", "NotSigned"]) {
      const f = fake({ signature: ok });
      await f.launcher.launch();
      expect(f.launcher.getState().kind).toBe("paired");
      expect(f.ran[0]?.[0]).toMatch(/powershell\.exe$/);
    }
    const bad = fake({ signature: "HashMismatch" });
    await bad.launcher.launch();
    expect(bad.launcher.getState()).toEqual({
      kind: "offline",
      reason: "the helper's signature is not valid",
    });
    expect(bad.spawned).toEqual([]);
  });

  it("reads Get-AuthenticodeSignature's status safely", async () => {
    const calls: string[][] = [];
    const run: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: "Valid\r\n", stderr: "" };
    };
    expect(await authenticodeStatus("C:\\it's\\x.exe", run, "C:\\Windows")).toBe("Valid");
    expect(calls[0]?.[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]?.at(-1)).toContain("-LiteralPath 'C:\\it''s\\x.exe'");
    expect(authenticodeAcceptable("Valid")).toBe(true);
    expect(authenticodeAcceptable("NotSigned")).toBe(true);
    expect(authenticodeAcceptable(undefined)).toBe(true);
    expect(authenticodeAcceptable("NotTrusted")).toBe(false);
  });
});
