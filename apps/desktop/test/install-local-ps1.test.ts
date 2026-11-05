import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandFor, toPowerShellArgs } from "../../../scripts/dev/app.mjs";

/**
 * deploy/windows/install-local.ps1 (the counterpart of install-local-script.test.ts) against a
 * temporary USERPROFILE / APPDATA / LOCALAPPDATA and a Task Scheduler task that does not exist.
 * Every run here is a dry run or refuses before anything is stopped, so nothing can reach the real
 * install, task, Credential Manager or ~\.psyche (the script only ever reads them). The wipe
 * itself is not run from a test for that reason; its rules are the refusals and the listing.
 * Windows only (it needs Windows PowerShell).
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deploy",
  "windows",
  "install-local.ps1",
);
const windows = process.platform === "win32";
// Each run starts Windows PowerShell (and reads Task Scheduler and Credential Manager).
vi.setConfig({ testTimeout: 90_000 });

let root: string;
let profile: string;
let installer: string;

const mark = (dir: string) => {
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "psyche.sqlite"), "db");
};

function run(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, installer, ...args],
    {
      encoding: "utf8",
      input: "",
      timeout: 60_000,
      env: {
        ...process.env,
        USERPROFILE: profile,
        APPDATA: join(profile, "AppData", "Roaming"),
        LOCALAPPDATA: join(profile, "AppData", "Local"),
        PSYCHE_HOME: "",
        PSYCHE_TEST_TASK: "\\Psyche\\NoSuchTaskForTests",
        ...env,
      },
    },
  );
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-install-ps1-")));
  profile = join(root, "user");
  mkdirSync(join(profile, "AppData", "Roaming", "Psyche"), { recursive: true });
  mkdirSync(join(profile, "AppData", "Local"), { recursive: true });
  mark(join(profile, ".psyche"));
  installer = join(root, "Psyche-0.0.0-Setup.exe");
  writeFileSync(installer, "not a real installer");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const data = () => join(profile, ".psyche", "state", "psyche.sqlite");

describe.skipIf(!windows)("install-local.ps1", () => {
  it("keeps your data by default and says so", () => {
    const r = run(["-DryRun"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Keeping your data");
    expect(r.out).not.toContain("PERMANENTLY");
    expect(existsSync(data())).toBe(true);
  });

  it("-KeepData is accepted and changes nothing", () => {
    const r = run(["-DryRun", "-KeepData"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Keeping your data");
  });

  it("-Reset prints exactly what it will delete, and only what exists", () => {
    const r = run(["-DryRun", "-Reset"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PERMANENTLY DELETE");
    expect(r.out).toContain(`    ${join(profile, ".psyche")}\n`.replace(/\n/g, "\r\n").trimEnd());
    expect(r.out).toContain(join(profile, "AppData", "Roaming", "Psyche"));
    expect(r.out).not.toContain("com.psyche.helper");
    expect(r.out).not.toContain("vm-images");
    expect(existsSync(data())).toBe(true);
    expect(existsSync(join(profile, "AppData", "Roaming", "Psyche"))).toBe(true);
  });

  it("-Reset without -Yes and without a terminal cancels before anything is stopped or deleted", () => {
    const r = run(["-Reset"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs a\s+terminal to confirm/);
    expect(existsSync(data())).toBe(true);
    expect(r.out).not.toContain("Quitting Psyche");
    expect(r.out).not.toContain("Running Psyche-0.0.0-Setup.exe");
  });

  it("refuses PSYCHE_HOME at the user folder, with or without a trailing slash, and at a drive root", () => {
    for (const bad of [profile, `${profile}\\`, `${profile}\\.`, "C:\\", "C:\\Users"]) {
      const r = run(["-DryRun", "-Reset", "-Yes"], { PSYCHE_HOME: bad });
      expect(r.code, bad).not.toBe(0);
      expect(r.out, bad).toContain("refusing to delete");
      expect(existsSync(data()), bad).toBe(true);
    }
  });

  it("refuses a relative path, folders outside the user folder and the personal folders", () => {
    const outside = join(root, "elsewhere");
    mark(outside);
    mark(join(profile, "Documents"));
    mark(join(profile, "Desktop"));
    for (const bad of [
      "relative\\.psyche",
      outside,
      join(profile, "Documents"),
      join(profile, "desktop"),
    ]) {
      const r = run(["-DryRun", "-Reset"], { PSYCHE_HOME: bad });
      expect(r.code, bad).not.toBe(0);
      expect(r.out, bad).toContain("refusing to delete");
    }
  });

  it("refuses a folder with no Psyche marker, accepts config.json", () => {
    mkdirSync(join(profile, "photos"));
    const no = run(["-DryRun", "-Reset"], { PSYCHE_HOME: join(profile, "photos") });
    expect(no.code).not.toBe(0);
    expect(no.out).toContain("no Psyche marker");
    mkdirSync(join(profile, "other"));
    writeFileSync(join(profile, "other", "config.json"), "{}");
    const yes = run(["-DryRun", "-Reset"], { PSYCHE_HOME: join(profile, "other") });
    expect(yes.code, yes.out).toBe(0);
    expect(yes.out).toContain(join(profile, "other"));
  });

  it("refuses -Yes when the folder is not the default ~\\.psyche", () => {
    mark(join(profile, "other"));
    const r = run(["-DryRun", "-Reset", "-Yes"], { PSYCHE_HOME: join(profile, "other") });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("refusing -Yes");
    // Without -Yes it is listed (the owner confirms it by typing RESET).
    expect(run(["-DryRun", "-Reset"], { PSYCHE_HOME: join(profile, "other") }).code).toBe(0);
  });

  it("-Force is the same switch as -Yes", () => {
    mark(join(profile, "other"));
    const r = run(["-DryRun", "-Reset", "-Force"], { PSYCHE_HOME: join(profile, "other") });
    expect(r.out).toContain("refusing -Yes");
  });

  it("does not look at a data folder at all without -Reset (a bad PSYCHE_HOME is not an error)", () => {
    const r = run(["-DryRun"], { PSYCHE_HOME: profile });
    expect(r.code, r.out).toBe(0);
  });
});

describe("pnpm app:install on Windows", () => {
  it("maps the macOS flags to the script's switches", () => {
    expect(toPowerShellArgs(["--reset", "--yes", "-y", "--keep-data", "--dry-run"])).toEqual([
      "-Reset",
      "-Yes",
      "-Yes",
      "-KeepData",
      "-DryRun",
    ]);
    const [, argv] = commandFor("install", ["--reset"], "win32", "powershell.exe");
    expect(argv.at(-1)).toBe("-Reset");
    expect(argv).toContain(SCRIPT.replace(/\//g, "\\").replace(/\\+/g, "\\"));
  });
});
