import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  chooseMode,
  type GatewayRunState,
  GatewaySupervisor,
  parseLaunchctlPrint,
  type Runner,
  renderLaunchAgentPlist,
} from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-sup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const down: typeof fetch = () => Promise.reject(new Error("down"));
const up: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

describe("supervisor mode", () => {
  it("defaults to dev unpackaged and launchd packaged; env overrides", () => {
    expect(chooseMode({}, false)).toBe("dev");
    expect(chooseMode({}, true)).toBe("launchd");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "external" }, true)).toBe("external");
    expect(chooseMode({ PSYCHE_GATEWAY_MODE: "bogus" }, true)).toBe("launchd");
  });
});

describe("LaunchAgent plist", () => {
  it("escapes values and keeps the agent alive", () => {
    const xml = renderLaunchAgentPlist({
      program: "/Applications/Psyche.app/Contents/Resources/psyched",
      psycheHome: "/Users/a&b/.psyche",
      logDir: "/Users/a&b/.psyche/logs",
    });
    expect(xml).toContain("<string>com.psyche.gateway</string>");
    expect(xml).toContain("/Users/a&amp;b/.psyche");
    expect(xml).not.toContain("a&b");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("parses launchctl print", () => {
    expect(
      parseLaunchctlPrint("gui/501/com.psyche.gateway = {\n\tstate = running\n\tpid = 4242\n"),
    ).toEqual({
      running: true,
      pid: 4242,
    });
    expect(parseLaunchctlPrint("\tstate = not running\n").running).toBe(false);
  });

  it("installs, bootstraps and kickstarts when nothing answers /healthz", async () => {
    const program = join(dir, "psyched");
    writeFileSync(program, "#!/bin/sh\n");
    const calls: string[][] = [];
    let loaded = false;
    const run: Runner = async (_file, args) => {
      calls.push(args);
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "print")
        return loaded
          ? { code: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" }
          : { code: 113, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const states: GatewayRunState[] = [];
    const sup = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(dir, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(dir, "LaunchAgents"),
      uid: 501,
      run,
      fetch: down,
      onState: (s) => states.push(s),
    });
    await sup.ensureRunning();
    expect(readFileSync(join(dir, "LaunchAgents", "com.psyche.gateway.plist"), "utf8")).toContain(
      program,
    );
    expect(calls.map((c) => c[0])).toEqual(["bootout", "print", "bootstrap", "kickstart", "print"]);
    expect(calls.find((c) => c[0] === "bootstrap")?.[1]).toBe("gui/501");
    expect(sup.getState()).toEqual({ kind: "running", mode: "launchd", pid: 7 });

    calls.length = 0;
    await sup.stopEverything();
    expect(calls).toEqual([["bootout", "gui/501/com.psyche.gateway"]]);
    expect(states.at(-1)?.kind).toBe("stopped");
  });

  it("attaches to a healthy Gateway instead of starting another", async () => {
    const calls: string[][] = [];
    const sup = new GatewaySupervisor({
      mode: "dev",
      psycheHome: dir,
      healthUrl: "http://127.0.0.1:1/healthz",
      gatewayDir: join(dir, "missing"),
      run: async (_f, a) => {
        calls.push(a);
        return { code: 0, stdout: "", stderr: "" };
      },
      fetch: up,
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({ kind: "running", mode: "dev" });
    expect(calls).toEqual([]);
  });

  it("reports a missing gateway package in dev", async () => {
    const sup = new GatewaySupervisor({
      mode: "dev",
      psycheHome: dir,
      healthUrl: "http://127.0.0.1:1/healthz",
      gatewayDir: join(dir, "missing"),
      fetch: down,
    });
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({ kind: "stopped", reason: "apps/gateway not found" });
  });
});
