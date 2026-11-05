import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type GatewayRunState,
  GatewaySupervisor,
  type Runner,
  readBundledBuild,
  renderLaunchAgentPlist,
  withPlistEnv,
} from "../../src/main/supervisor.ts";

/**
 * The Gateway's build in the handshake (updates design §2.10, gap G1). A fake launchd stands in
 * for `launchctl`; nothing here touches the real LaunchAgent.
 */

const down: typeof fetch = () => Promise.reject(new Error("down"));
const up: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

/** Loaded after bootstrap, healthy once kickstarted. */
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
        ? { code: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchFn: typeof fetch = () => (started && loaded && !opts.neverHealthy ? up("") : down(""));
  return { calls, run, fetch: fetchFn };
}

function setup(build = "build-new", fakeOpts: { neverHealthy?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "psy-build-"));
  const program = join(base, "Psyche.app", "psyched", "psyched");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "#!/bin/sh\n");
  writeFileSync(
    join(dirname(program), "build-info.json"),
    JSON.stringify({ version: "0.5.0", build }),
  );
  const fake = launchd(fakeOpts);
  const states: GatewayRunState[] = [];
  const make = (
    expectedBuild: string | undefined,
    extra: Partial<ConstructorParameters<typeof GatewaySupervisor>[0]> = {},
  ) =>
    new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(base, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(base, "LaunchAgents"),
      uid: 501,
      healthTimeoutMs: 0,
      ...(expectedBuild === undefined ? {} : { expectedBuild }),
      run: fake.run,
      fetch: fake.fetch,
      sleep: async () => undefined,
      onState: (s) => states.push(s),
      ...extra,
    });
  return {
    base,
    program,
    fake,
    states,
    make,
    plist: join(base, "LaunchAgents", "com.psyche.gateway.plist"),
  };
}

describe("the Gateway's build", () => {
  it("reads the build of the bundled Gateway from build-info.json", () => {
    const { program } = setup("abc123");
    const info = join(dirname(program), "build-info.json");
    expect(readBundledBuild(info)).toBe("abc123");
    expect(readBundledBuild(join(dirname(program), "missing.json"))).toBeUndefined();
    const bad = join(dirname(program), "bad.json");
    writeFileSync(bad, "{not json");
    expect(readBundledBuild(bad)).toBeUndefined();
    writeFileSync(bad, JSON.stringify({ version: "1.0.0" }));
    expect(readBundledBuild(bad)).toBeUndefined();
  });

  it("writes PSYCHE_BUILD into the plist, so a new build reloads the agent", async () => {
    const { fake, make, plist } = setup();
    await make("build-old").ensureRunning();
    expect(readFileSync(plist, "utf8")).toMatch(
      /<key>PSYCHE_BUILD<\/key>\s*<string>build-old<\/string>/,
    );
    // The app updated in place: same path, new build. The plist differs, so the agent reloads.
    fake.calls.length = 0;
    await make("build-new").ensureRunning();
    expect(readFileSync(plist, "utf8")).toMatch(
      /<key>PSYCHE_BUILD<\/key>\s*<string>build-new<\/string>/,
    );
    const verbs = fake.calls.map((c) => c[0]);
    expect(verbs).toContain("bootout");
    expect(verbs).toContain("bootstrap");
  });

  it("puts nothing in the plist when the bundle has no build", async () => {
    const { make, plist } = setup();
    await make(undefined).ensureRunning();
    expect(readFileSync(plist, "utf8")).not.toContain("PSYCHE_BUILD");
  });

  it("restarts the agent once when the running Gateway reports another build", async () => {
    const { fake, make } = setup();
    const sup = make("build-new");
    await sup.ensureRunning();
    fake.calls.length = 0;
    expect(await sup.checkServerBuild({ build: "build-new" })).toBe("match");
    expect(fake.calls).toEqual([]);
    // An old Gateway left running across the update.
    expect(await sup.checkServerBuild({ build: "build-old" })).toBe("restarted");
    // Unloaded, reloaded from the plist this build wants, started: `kickstart -k` would keep
    // the plist launchd had already read.
    const verbs = fake.calls.map((c) => c[0]);
    expect(verbs.indexOf("bootout")).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf("bootstrap")).toBeGreaterThan(verbs.indexOf("bootout"));
    expect(verbs.indexOf("kickstart")).toBeGreaterThan(verbs.indexOf("bootstrap"));
    expect(fake.calls.some((c) => c.includes("-k"))).toBe(false);
    // Still another build after the restart (a Gateway that predates the field reports none):
    // the agent runs somebody else's psyched. Say so, and do not restart again.
    fake.calls.length = 0;
    expect(await sup.checkServerBuild(undefined)).toBe("mismatch");
    expect(fake.calls.filter((c) => c[0] === "kickstart")).toEqual([]);
    expect(sup.getState()).toMatchObject({
      kind: "stopped",
      reason: expect.stringContaining("Another copy of Psyche runs the Gateway"),
    });
  });

  it("shares one restart between concurrent handshakes, and may restart again after a match", async () => {
    const { fake, make } = setup();
    const sup = make("build-new");
    await sup.ensureRunning();
    fake.calls.length = 0;
    const both = await Promise.all([
      sup.checkServerBuild({ build: "old" }),
      sup.checkServerBuild({ build: "old" }),
    ]);
    expect(both).toEqual(["restarted", "restarted"]);
    expect(fake.calls.filter((c) => c[0] === "kickstart")).toHaveLength(1);
    expect(await sup.checkServerBuild({ build: "build-new" })).toBe("match");
    expect(await sup.checkServerBuild({ build: "old-again" })).toBe("restarted");
  });

  it("leaves a Gateway alone that another copy of Psyche owns, and every non-launchd mode", async () => {
    const { base, fake, make, plist } = setup();
    const sup = make("build-new");
    await sup.ensureRunning();
    // Another copy's psyched is the one the agent runs.
    const other = join(base, "Other.app", "psyched");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "#!/bin/sh\n");
    writeFileSync(
      plist,
      renderLaunchAgentPlist({ program: other, psycheHome: "/h", logDir: "/l" }),
    );
    fake.calls.length = 0;
    expect(await sup.checkServerBuild({ build: "theirs" })).toBe("skipped");
    expect(fake.calls).toEqual([]);

    const dev = new GatewaySupervisor({
      mode: "dev",
      psycheHome: base,
      healthUrl: "http://127.0.0.1:1/healthz",
      expectedBuild: "build-new",
      run: fake.run,
      fetch: down,
    });
    expect(await dev.checkServerBuild({ build: "x" })).toBe("skipped");
    expect(fake.calls).toEqual([]);
  });
});

describe("a Gateway that undid a failed data migration", () => {
  const note = (build: string) =>
    JSON.stringify({ build, message: "Psyche 0.5.0 couldn't update your data. Nothing was lost." });

  it("shows its plain message instead of 'did not answer'", async () => {
    const { base, make } = setup("build-new", { neverHealthy: true });
    mkdirSync(join(base, "home", "run"), { recursive: true });
    writeFileSync(join(base, "home", "run", "update-failed.json"), note("build-new"));
    const sup = make("build-new");
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({
      kind: "stopped",
      reason: "Psyche 0.5.0 couldn't update your data. Nothing was lost.",
    });
  });

  it("ignores a note left by another build", async () => {
    const { base, make } = setup("build-new", { neverHealthy: true });
    mkdirSync(join(base, "home", "run"), { recursive: true });
    writeFileSync(join(base, "home", "run", "update-failed.json"), note("build-old"));
    const sup = make("build-new");
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({
      kind: "stopped",
      reason: expect.stringContaining("did not answer"),
    });
  });
});

describe("restarting for a build mismatch (review M6)", () => {
  it("asks the Gateway to settle first, then restarts, and rewrites the plist it loads", async () => {
    const order: string[] = [];
    const { fake, make, plist } = setup("build-new");
    const sup = make("build-new", {
      prepareRestart: async () => {
        order.push(`prepare after ${fake.calls.length} launchctl calls`);
      },
    });
    await sup.ensureRunning();
    const before = fake.calls.length;
    // The plist on disk is stale (an older app wrote it); the restart loads the current one.
    writeFileSync(plist, readFileSync(plist, "utf8").replace("build-new", "build-old"));
    expect(await sup.checkServerBuild({ build: "build-old" })).toBe("restarted");
    expect(order).toEqual([`prepare after ${before} launchctl calls`]);
    expect(readFileSync(plist, "utf8")).toContain("<string>build-new</string>");
  });

  it("restarts even when the Gateway is too old to know prepareUpdate", async () => {
    const { make } = setup("build-new");
    const sup = make("build-new", {
      prepareRestart: async () => {
        throw new Error("unknown_method");
      },
    });
    await sup.ensureRunning();
    expect(await sup.checkServerBuild({ build: "build-old" })).toBe("restarted");
  });

  it("leaves a Gateway it attached to alone: one it does not run is not its to restart", async () => {
    const { base, program, fake, states } = setup("build-new");
    const attachedFake = {
      ...fake,
      run: async (_f: string, a: string[]) => ({
        code: a[0] === "print" ? 113 : 0,
        stdout: "",
        stderr: "",
      }),
    };
    const sup = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(base, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(base, "LaunchAgents"),
      uid: 501,
      healthTimeoutMs: 0,
      expectedBuild: "build-new",
      run: attachedFake.run,
      fetch: up,
      sleep: async () => undefined,
      onState: (s) => states.push(s),
    });
    await sup.ensureRunning();
    expect(sup.getState()).toMatchObject({ kind: "running" });
    fake.calls.length = 0;
    expect(await sup.checkServerBuild({ build: "someone-elses" })).toBe("skipped");
    expect(fake.calls).toEqual([]);
  });

  it("never restarts while it is still starting the agent", async () => {
    const { make } = setup("build-new");
    let during: string | undefined;
    const sup = make("build-new", {
      onState: (s) => {
        if (s.kind === "starting" && during === undefined)
          void sup.checkServerBuild({ build: "old" }).then((r) => {
            during = r;
          });
      },
    });
    await sup.ensureRunning();
    await new Promise((r) => setTimeout(r, 5));
    expect(during).toBe("skipped");
  });
});

describe("waiting for a long update (L9) and trying again (M5)", () => {
  it("keeps waiting while the Gateway says it is copying or migrating, and stops when it stops", async () => {
    const { base, make } = setup("build-new", { neverHealthy: true });
    mkdirSync(join(base, "home", "run"), { recursive: true });
    const progress = join(base, "home", "run", "update-progress.json");
    writeFileSync(progress, JSON.stringify({ phase: "migrating", at: new Date().toISOString() }));
    let sleeps = 0;
    const sup = make("build-new", {
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 4) rmSync(progress);
      },
    });
    await sup.ensureRunning();
    expect(sleeps).toBeGreaterThanOrEqual(4);
    expect(sup.getState()).toMatchObject({ kind: "stopped" });
  });

  it("does not wait on a progress note from a Gateway that died long ago", async () => {
    const { base, make } = setup("build-new", { neverHealthy: true });
    mkdirSync(join(base, "home", "run"), { recursive: true });
    writeFileSync(
      join(base, "home", "run", "update-progress.json"),
      JSON.stringify({ phase: "migrating", at: new Date(Date.now() - 3_600_000).toISOString() }),
    );
    let sleeps = 0;
    const sup = make("build-new", {
      sleep: async () => {
        sleeps += 1;
      },
    });
    await sup.ensureRunning();
    expect(sleeps).toBe(0);
  });

  it("Try again removes the failed-update note so the Gateway attempts the update", () => {
    const { base, make } = setup("build-new");
    mkdirSync(join(base, "home", "run"), { recursive: true });
    const note = join(base, "home", "run", "update-failed.json");
    writeFileSync(note, "{}");
    const sup = make("build-new");
    expect(sup.retryAfterUpdateFailure()).toBe(true);
    expect(existsSync(note)).toBe(false);
    expect(sup.retryAfterUpdateFailure()).toBe(false);
  });
});

describe("the desktop and the CLI write one plist (L3)", () => {
  it("psyche start keeps the desktop's variables, byte for byte", async () => {
    const { carryDesktopEnv, renderLaunchAgentPlist: cliPlist } = await import(
      "../../../cli/src/supervisor.ts"
    );
    const program = "/Applications/Psyche.app/Contents/Resources/psyched/psyched";
    const home = "/Users/me/.psyche";
    const desktop = withPlistEnv(
      renderLaunchAgentPlist({ program, psycheHome: home, logDir: `${home}/logs` }),
      {
        PSYCHE_VAULT_KEY_FILE: `${home}/secrets/vault.key`,
        PSYCHE_BUILD: "build-new",
      },
    );
    const cli = carryDesktopEnv(cliPlist({ program, psycheHome: home }), desktop);
    expect(cli).toBe(desktop);
    // Nothing to carry for a plist of another program, or none.
    const other = cliPlist({ program: "/elsewhere/psyched", psycheHome: home });
    expect(carryDesktopEnv(other, desktop)).toBe(other);
    expect(carryDesktopEnv(other, undefined)).toBe(other);
  });
});
