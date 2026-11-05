import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type GatewayRunState,
  GatewaySupervisor,
  type Runner,
  readBundledBuild,
  renderLaunchAgentPlist,
} from "../../src/main/supervisor.ts";

/**
 * The Gateway's build in the handshake (updates design §2.10, gap G1). A fake launchd stands in
 * for `launchctl`; nothing here touches the real LaunchAgent.
 */

const down: typeof fetch = () => Promise.reject(new Error("down"));
const up: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

/** Loaded after bootstrap, healthy once kickstarted. */
function launchd() {
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
  const fetchFn: typeof fetch = () => (started && loaded ? up("") : down(""));
  return { calls, run, fetch: fetchFn };
}

function setup(build = "build-new") {
  const base = mkdtempSync(join(tmpdir(), "psy-build-"));
  const program = join(base, "Psyche.app", "psyched", "psyched");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "#!/bin/sh\n");
  writeFileSync(
    join(dirname(program), "build-info.json"),
    JSON.stringify({ version: "0.5.0", build }),
  );
  const fake = launchd();
  const states: GatewayRunState[] = [];
  const make = (expectedBuild: string | undefined) =>
    new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(base, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      launchAgentsDir: join(base, "LaunchAgents"),
      uid: 501,
      ...(expectedBuild === undefined ? {} : { expectedBuild }),
      run: fake.run,
      fetch: fake.fetch,
      sleep: async () => undefined,
      onState: (s) => states.push(s),
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
    expect(fake.calls.find((c) => c[0] === "kickstart")).toEqual([
      "kickstart",
      "-k",
      "gui/501/com.psyche.gateway",
    ]);
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
