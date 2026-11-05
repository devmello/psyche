import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupervisor } from "../../src/main/supervisor.ts";
import type { Runner } from "../../src/main/supervisor-base.ts";
import { chooseMode, serviceModeFor } from "../../src/main/supervisor-base.ts";
import {
  parseSystemctlShow,
  type SystemdOptions,
  SystemdUserSupervisor,
  systemctlUser,
} from "../../src/platform/systemd-supervisor.ts";

/**
 * A fake `systemctl --user` stands in for systemd: it records every argv, tracks whether the unit
 * is enabled and active, and makes the fake Gateway answer `/healthz` while the unit is active.
 * Nothing here touches the real user manager.
 */

let root: string;
let unitDir: string;
let program: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-systemd-"));
  unitDir = join(root, "units");
  program = join(root, "psyched");
  writeFileSync(program, "#!/bin/sh\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function systemd(opts: { noUserSession?: boolean; startFails?: boolean; packaged?: boolean } = {}) {
  const calls: string[][] = [];
  const state = { active: false, loaded: false, healthy: false, externalHealthy: false };
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    const [, verb] = args;
    const ok = { code: 0, stdout: "", stderr: "" };
    if (verb === "show-environment") return opts.noUserSession ? { ...ok, code: 1 } : ok;
    if (verb === "cat") return opts.packaged === false ? { ...ok, code: 1 } : ok;
    if (verb === "daemon-reload") return ok;
    if (verb === "enable" || verb === "start" || verb === "restart") {
      if (opts.startFails) return { code: 1, stdout: "", stderr: "Failed to start" };
      state.active = state.loaded = state.healthy = true;
      return ok;
    }
    if (verb === "stop" || verb === "disable") {
      state.active = state.healthy = false;
      return ok;
    }
    if (verb === "show") {
      return {
        code: 0,
        stdout: `LoadState=${state.loaded ? "loaded" : "not-found"}\nActiveState=${state.active ? "active" : "inactive"}\nMainPID=${state.active ? 4242 : 0}\nResult=success\nExecMainStatus=0\n`,
        stderr: "",
      };
    }
    return ok;
  };
  const fetchFn: typeof fetch = () =>
    state.healthy || state.externalHealthy
      ? Promise.resolve(new Response("{}", { status: 200 }))
      : Promise.reject(new Error("down"));
  const build = (extra: Partial<SystemdOptions> = {}) =>
    new SystemdUserSupervisor({
      mode: "systemd",
      psycheHome: join(root, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      gatewayProgram: program,
      install: "user",
      unitDir,
      run,
      fetch: fetchFn,
      sleep: async () => undefined,
      healthTimeoutMs: 50,
      expectedBuild: "b1",
      ...extra,
    });
  const verbs = () => calls.map((c) => c.slice(1).join(" "));
  return { calls, state, build, verbs };
}

const unitFile = () => join(unitDir, "psyche-gateway.service");

describe("modes", () => {
  it("systemd is the packaged mode on Linux and createSupervisor builds it", () => {
    expect(serviceModeFor("linux")).toBe("systemd");
    expect(chooseMode({}, true, "linux")).toBe("systemd");
    expect(chooseMode({}, false, "linux")).toBe("dev");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "systemd" }, true, "linux")).toBe("systemd");
    // A forced mode of another OS is ignored.
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "systemd" }, true, "darwin")).toBe("launchd");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "launchd" }, true, "linux")).toBe("systemd");
    expect(serviceModeFor("darwin")).toBe("launchd");
    expect(serviceModeFor("win32")).toBe("taskscheduler");
    const sup = createSupervisor(
      { mode: "systemd", psycheHome: root, healthUrl: "http://x/healthz", unitDir },
      "linux",
    );
    expect(sup).toBeInstanceOf(SystemdUserSupervisor);
  });
});

describe("SystemdUserSupervisor", () => {
  it("installs the unit, enables it with --now and reports running", async () => {
    const s = systemd();
    const sup = s.build();
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({ kind: "running", mode: "systemd", pid: 4242 });
    expect(s.verbs()).toEqual([
      "--user show-environment",
      "--user show psyche-gateway.service -p LoadState -p ActiveState -p MainPID -p Result -p ExecMainStatus",
      "--user daemon-reload",
      "--user enable --now psyche-gateway.service",
      "--user show psyche-gateway.service -p LoadState -p ActiveState -p MainPID -p Result -p ExecMainStatus",
    ]);
    expect(s.calls.every((c) => c[0] === "systemctl")).toBe(true);
    const text = readFileSync(unitFile(), "utf8");
    expect(text).toContain(`ExecStart="${program}"`);
    expect(text).toContain('Environment="PSYCHE_BUILD=b1"');
    expect(text).not.toMatch(/^MemoryMax=/m);
  });

  it("the content-change rule: a second launch with the same content changes nothing", async () => {
    const s = systemd();
    await s.build().ensureRunning();
    const before = s.calls.length;
    const mtimeText = readFileSync(unitFile(), "utf8");
    await s.build().ensureRunning();
    const verbs = s.verbs().slice(before);
    expect(verbs.some((v) => /daemon-reload|enable|restart|start/.test(v))).toBe(false);
    expect(readFileSync(unitFile(), "utf8")).toBe(mtimeText);
  });

  it("a new build rewrites the unit and restarts the running one", async () => {
    const s = systemd();
    await s.build().ensureRunning();
    const before = s.calls.length;
    const sup = s.build({ expectedBuild: "b2" });
    await sup.ensureRunning();
    const verbs = s.verbs().slice(before);
    expect(verbs).toContain("--user daemon-reload");
    expect(verbs).toContain("--user restart psyche-gateway.service");
    expect(readFileSync(unitFile(), "utf8")).toContain("PSYCHE_BUILD=b2");
    expect(sup.getState().kind).toBe("running");
  });

  it("AppImage: ExecStart is the image run with --psyched", async () => {
    const s = systemd();
    await s.build({ gatewayArgs: ["--psyched"] }).ensureRunning();
    expect(readFileSync(unitFile(), "utf8")).toContain(`ExecStart="${program}" "--psyched"`);
  });

  it("passes the vault key file into the unit", async () => {
    const s = systemd();
    await s
      .build({ vaultKeyFile: async () => "/home/me/.psyche/secrets/vault.key" })
      .ensureRunning();
    expect(readFileSync(unitFile(), "utf8")).toContain(
      'Environment="PSYCHE_VAULT_KEY_FILE=/home/me/.psyche/secrets/vault.key"',
    );
  });

  it("packaged install: writes only a drop-in and never the unit", async () => {
    const s = systemd();
    await s.build({ install: "packaged" }).ensureRunning();
    expect(s.verbs()).toContain("--user cat psyche-gateway.service");
    expect(existsSync(unitFile())).toBe(false);
    const dropIn = readFileSync(
      join(unitDir, "psyche-gateway.service.d", "10-psyche-desktop.conf"),
      "utf8",
    );
    expect(dropIn).toContain("[Service]");
    expect(dropIn).toContain("PSYCHE_BUILD=b1");
    expect(dropIn).not.toContain("ExecStart");
  });

  it("packaged install without the packaged unit says to reinstall", async () => {
    const s = systemd({ packaged: false });
    const sup = s.build({ install: "packaged" });
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({
      kind: "stopped",
      reason: expect.stringContaining("reinstall"),
    });
  });

  it("no systemd user session: stops with a plain reason and touches nothing", async () => {
    const s = systemd({ noUserSession: true });
    const sup = s.build();
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({ kind: "stopped", mode: "systemd" });
    expect(existsSync(unitFile())).toBe(false);
  });

  it("attaches to a Gateway someone else serves instead of starting a second one", async () => {
    const s = systemd();
    s.state.externalHealthy = true;
    const sup = s.build();
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({ kind: "running", mode: "systemd" });
    expect(s.verbs().some((v) => v.includes("enable"))).toBe(false);
    // An attached Gateway is never restarted for its build.
    expect(await sup.checkServerBuild({ build: "other" })).toBe("skipped");
  });

  it("a start that systemctl refuses is reported with its message", async () => {
    const s = systemd({ startFails: true });
    const sup = s.build();
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({
      kind: "stopped",
      reason: expect.stringContaining("Failed to start"),
    });
  });

  describe("build mismatch", () => {
    it("restarts once, asks prepareRestart first, and answers restarted", async () => {
      const s = systemd();
      let prepared = 0;
      const sup = s.build({ prepareRestart: async () => void prepared++ });
      await sup.ensureRunning();
      const before = s.calls.length;
      expect(await sup.checkServerBuild({ build: "b0" })).toBe("restarted");
      expect(prepared).toBe(1);
      expect(s.verbs().slice(before)).toContain("--user restart psyche-gateway.service");
      expect(await sup.checkServerBuild({ build: "b1" })).toBe("match");
    });

    it("gives up after one restart when the running build is still another", async () => {
      const s = systemd();
      const sup = s.build();
      await sup.ensureRunning();
      expect(await sup.checkServerBuild({ build: "b0" })).toBe("restarted");
      const before = s.calls.length;
      expect(await sup.checkServerBuild({ build: "b0" })).toBe("mismatch");
      expect(s.calls.length).toBe(before);
      expect(sup.getState()).toMatchObject({ kind: "stopped" });
    });

    it("leaves a unit that runs another copy's psyched alone", async () => {
      const s = systemd();
      await s.build().ensureRunning();
      const other = s.build({ gatewayProgram: join(root, "elsewhere") });
      expect(await other.checkServerBuild({ build: "zzz" })).toBe("skipped");
    });

    it("restart('update') after stopForUpdate starts the stopped unit again", async () => {
      const s = systemd();
      let prepared = 0;
      const sup = s.build({ prepareRestart: async () => void prepared++ });
      await sup.ensureRunning();
      await sup.stopForUpdate();
      expect(s.verbs()).toContain("--user stop psyche-gateway.service");
      expect(sup.getState()).toMatchObject({ kind: "stopped", reason: "updating" });
      await sup.restart("update");
      expect(prepared).toBe(0);
      expect(sup.getState()).toMatchObject({ kind: "running" });
    });
  });

  it("onAppQuit leaves the unit running; quitEntirely disables it and removes the unit", async () => {
    const s = systemd();
    const sup = s.build();
    await sup.ensureRunning();
    const before = s.calls.length;
    await sup.onAppQuit();
    expect(s.calls.length).toBe(before);
    await sup.quitEntirely();
    expect(s.verbs()).toContain("--user disable --now psyche-gateway.service");
    expect(existsSync(unitFile())).toBe(false);
    expect(sup.getState()).toMatchObject({ kind: "stopped", reason: "quit" });
  });

  it("quitEntirely leaves another copy's unit alone", async () => {
    const s = systemd();
    mkdirSync(unitDir, { recursive: true });
    const foreign = join(root, "foreign-psyched");
    writeFileSync(foreign, "x");
    writeFileSync(unitFile(), `[Service]\nExecStart="${foreign}"\n`);
    await s.build().quitEntirely();
    expect(s.verbs().some((v) => v.includes("disable"))).toBe(false);
    expect(existsSync(unitFile())).toBe(true);
  });

  it("writes psyche-helper.service only when its content changes", async () => {
    const s = systemd();
    const sup = s.build();
    expect(await sup.ensureHelperUnit({ program: "/usr/lib/psyche/h" })).toBe(true);
    expect(await sup.ensureHelperUnit({ program: "/usr/lib/psyche/h" })).toBe(false);
    expect(s.verbs().filter((v) => v === "--user daemon-reload")).toHaveLength(1);
    expect(readFileSync(join(unitDir, "psyche-helper.service"), "utf8")).toContain(
      "PartOf=graphical-session.target",
    );
  });
});

describe("systemctl argv and show parsing", () => {
  it("builds the argv the supervisor and the docs use", () => {
    expect(systemctlUser.enableNow()).toEqual([
      "--user",
      "enable",
      "--now",
      "psyche-gateway.service",
    ]);
    expect(systemctlUser.restart("x.service")).toEqual(["--user", "restart", "x.service"]);
  });

  it("parses loaded, active, pid and a failed result", () => {
    expect(
      parseSystemctlShow(
        "LoadState=loaded\nActiveState=active\nMainPID=99\nResult=success\nExecMainStatus=0\n",
      ),
    ).toEqual({ loaded: true, active: true, pid: 99 });
    expect(
      parseSystemctlShow(
        "LoadState=loaded\nActiveState=failed\nMainPID=0\nResult=exit-code\nExecMainStatus=1\n",
      ),
    ).toEqual({ loaded: true, active: false, lastExit: "exit-code (status 1)" });
    expect(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\n")).toEqual({
      loaded: false,
      active: false,
    });
  });
});
