import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  renderPlistTemplate,
} from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-sup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const down: typeof fetch = () => Promise.reject(new Error("down"));
const up: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

/** A fake launchd: loaded after bootstrap, healthy once kickstarted (unless told otherwise). */
function launchd(opts: { neverHealthy?: boolean } = {}) {
  const calls: string[][] = [];
  let loaded = false;
  let started = false;
  const run: Runner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = started = false;
    if (args[0] === "kickstart") started = true;
    if (args[0] === "print")
      return loaded
        ? opts.neverHealthy
          ? { code: 0, stdout: "\tstate = not running\n\tlast exit code = 1\n", stderr: "" }
          : { code: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchFn: typeof fetch = () => (started && loaded && !opts.neverHealthy ? up("") : down(""));
  return { calls, run, fetch: fetchFn };
}

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

  it("fills the S22 template with escaped paths", () => {
    expect(
      renderPlistTemplate("<string>{{PSYCHED}}</string><string>{{PSYCHE_HOME}}/logs</string>", {
        program: "/Applications/P&Q.app/Contents/Resources/psyched/psyched",
        psycheHome: "/Users/a<b>/.psyche",
      }),
    ).toBe(
      "<string>/Applications/P&amp;Q.app/Contents/Resources/psyched/psyched</string><string>/Users/a&lt;b&gt;/.psyche/logs</string>",
    );
    expect(
      parseLaunchctlPrint("\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n"),
    ).toEqual({
      running: false,
      lastExit: "78: EX_CONFIG",
    });
  });

  it("installs from the bundled template, bootstraps, kickstarts and waits for /healthz", async () => {
    const program = join(dir, "psyched");
    writeFileSync(program, "#!/bin/sh\n");
    const template = join(dir, "com.psyche.gateway.plist");
    writeFileSync(template, "<plist>{{PSYCHED}} {{PSYCHE_HOME}}</plist>");
    const fake = launchd();
    const states: GatewayRunState[] = [];
    const sup = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(dir, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      bundledPlist: template,
      launchAgentsDir: join(dir, "LaunchAgents"),
      uid: 501,
      run: fake.run,
      fetch: fake.fetch,
      sleep: async () => undefined,
      onState: (s) => states.push(s),
    });
    await sup.ensureRunning();
    const plist = join(dir, "LaunchAgents", "com.psyche.gateway.plist");
    expect(readFileSync(plist, "utf8")).toBe(`<plist>${program} ${join(dir, "home")}</plist>`);
    expect(fake.calls.map((c) => c[0])).toEqual([
      "print",
      "-dr",
      "bootstrap",
      "kickstart",
      "print",
    ]);
    expect(fake.calls.find((c) => c[0] === "bootstrap")?.[1]).toBe("gui/501");
    expect(fake.calls.find((c) => c[0] === "-dr")).toEqual(["-dr", "com.apple.quarantine", dir]);
    expect(existsSync(join(dir, "home", "logs"))).toBe(true);
    expect(states.map((s) => s.kind)).toEqual(["starting", "running"]);
    expect(sup.getState()).toEqual({ kind: "running", mode: "launchd", pid: 7 });

    // Next launch, same build: nothing is rewritten or reloaded.
    fake.calls.length = 0;
    await sup.ensureRunning();
    expect(fake.calls.map((c) => c[0])).toEqual(["print", "print"]);

    // A moved or updated app changes the plist: reload it.
    writeFileSync(template, "<plist>v2 {{PSYCHED}}</plist>");
    fake.calls.length = 0;
    await sup.ensureRunning();
    expect(fake.calls.map((c) => c[0])).toEqual([
      "print",
      "bootout",
      "-dr",
      "bootstrap",
      "kickstart",
      "print",
    ]);

    // Quit entirely uninstalls; a plain quit (onAppQuit) never touches launchd.
    fake.calls.length = 0;
    await sup.onAppQuit();
    expect(fake.calls).toEqual([]);
    await sup.stopEverything();
    expect(fake.calls).toEqual([["bootout", "gui/501/com.psyche.gateway"]]);
    expect(existsSync(plist)).toBe(false);
    expect(states.at(-1)?.kind).toBe("stopped");
  });

  it("reports a Gateway that never answers with its last exit code and the logs folder", async () => {
    const program = join(dir, "psyched-dead");
    writeFileSync(program, "#!/bin/sh\n");
    const fake = launchd({ neverHealthy: true });
    const sup = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(dir, "home2"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(dir, "LaunchAgents2"),
      uid: 501,
      healthTimeoutMs: 0,
      run: fake.run,
      fetch: fake.fetch,
      sleep: async () => undefined,
    });
    await sup.ensureRunning();
    expect(sup.getState()).toEqual({
      kind: "stopped",
      mode: "launchd",
      reason: "The Gateway did not answer within 0 s (last exit code 1)",
      logs: join(dir, "home2", "logs"),
    });
  });

  it("refuses a translocated app and attaches to a Gateway it did not install", async () => {
    const fake = launchd();
    const translocated = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: dir,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram:
        "/private/var/folders/x/AppTranslocation/ABC/d/Psyche.app/Contents/Resources/psyched/psyched",
      run: fake.run,
      fetch: down,
    });
    await translocated.ensureRunning();
    expect(translocated.getState()).toMatchObject({
      kind: "stopped",
      reason: expect.stringContaining("Applications"),
    });
    const program = join(dir, "psyched-foreign");
    writeFileSync(program, "#!/bin/sh\n");
    const foreign = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: dir,
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(dir, "LaunchAgents3"),
      run: fake.run,
      fetch: up,
    });
    fake.calls.length = 0;
    await foreign.ensureRunning();
    expect(foreign.getState()).toEqual({ kind: "running", mode: "launchd" });
    expect(fake.calls.map((c) => c[0])).toEqual(["print"]);
    expect(existsSync(join(dir, "LaunchAgents3", "com.psyche.gateway.plist"))).toBe(false);
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
