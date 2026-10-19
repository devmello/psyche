import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockGateway } from "@psyche/web/testing";
import { afterEach, describe, expect, it } from "vitest";
import { renderLaunchAgentPlist as desktopPlist } from "../../desktop/src/main/supervisor.ts";
import { run } from "../src/cli.ts";
import { renderLaunchAgentPlist, renderSystemdUnit } from "../src/supervisor.ts";
import {
  cleanupTempDirs,
  closedPort,
  type ExecScript,
  err,
  makeDeps,
  out,
  runJson,
  type TestDeps,
  tempDir,
} from "./helpers.ts";

const running: MockGateway[] = [];
afterEach(async () => {
  for (const g of running.splice(0)) await g.stop();
  cleanupTempDirs();
});

const LABEL = "com.psyche.gateway";
const TARGET = `gui/501/${LABEL}`;
const hasPlutil = existsSync("/usr/bin/plutil");
const hasSystemdAnalyze = spawnSync("systemd-analyze", ["--version"]).status === 0;

describe("LaunchAgent plist", () => {
  const input = {
    program: "/Applications/Psyche & Co.app/Contents/MacOS/psyched",
    args: ["--port", "7979"],
    psycheHome: "/Users/me/.psyche <test>",
  };

  it("has KeepAlive, RunAtLoad, PSYCHE_HOME and logs under $PSYCHE_HOME/logs", () => {
    const plist = renderLaunchAgentPlist(input);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    expect(plist).toContain(
      "<key>PSYCHE_HOME</key>\n    <string>/Users/me/.psyche &lt;test&gt;</string>",
    );
    expect(plist).toContain("<string>/Users/me/.psyche &lt;test&gt;/logs/gateway.out.log</string>");
    expect(plist).toContain("<string>/Users/me/.psyche &lt;test&gt;/logs/gateway.err.log</string>");
    expect(plist).toContain("<string>--port</string>");
  });

  it("XML-escapes & in paths", () => {
    const plist = renderLaunchAgentPlist(input);
    expect(plist).toContain("Psyche &amp; Co.app");
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it.skipIf(!hasPlutil)("passes plutil -lint", () => {
    const file = join(tempDir(), "p.plist");
    writeFileSync(file, renderLaunchAgentPlist(input));
    expect(execFileSync("/usr/bin/plutil", ["-lint", file]).toString()).toContain("OK");
  });

  it("is byte-identical to the desktop's plist for the same input", () => {
    for (const home of ["/Users/me/.psyche", "/Users/me/Psyche & <data>"]) {
      const i = { program: "/usr/local/bin/psyched", args: ["--x"], psycheHome: home };
      expect(renderLaunchAgentPlist(i)).toBe(desktopPlist({ ...i, logDir: join(home, "logs") }));
    }
  });

  // Regression: the CLI used to escape `'` as `&apos;` while the desktop leaves it literal.
  it("is byte-identical to the desktop's plist for a path with an apostrophe", () => {
    const i = { program: "/usr/local/bin/psyched", psycheHome: "/Users/o'brien/.psyche" };
    expect(renderLaunchAgentPlist(i)).toBe(
      desktopPlist({ ...i, logDir: join(i.psycheHome, "logs") }),
    );
  });
});

describe("systemd unit", () => {
  const unit = renderSystemdUnit({
    program: "/opt/psyche $HOME/bin/psyched",
    args: ["--flag=50%", 'say "hi"'],
    psycheHome: "/home/me/.psyche %h",
  });

  it("quotes ExecStart and escapes $ and %", () => {
    expect(unit).toContain(
      'ExecStart="/opt/psyche $$HOME/bin/psyched" "--flag=50%%" "say \\"hi\\""',
    );
  });

  it("escapes % (but not $) in Environment=", () => {
    expect(unit).toContain('Environment="PSYCHE_HOME=/home/me/.psyche %%h"');
  });

  it("restarts on failure, keeps files private and installs into default.target", () => {
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^UMask=0077$/m);
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
    expect(unit).toMatch(/^Type=simple$/m);
  });

  it.skipIf(!hasSystemdAnalyze)("passes systemd-analyze verify", () => {
    const dir = tempDir();
    const file = join(dir, "psyche-gateway.service");
    writeFileSync(file, renderSystemdUnit({ program: "/bin/true", psycheHome: join(dir, "home") }));
    const r = spawnSync("systemd-analyze", ["--user", "verify", file]);
    expect(r.status, String(r.stderr)).toBe(0);
  });
});

/** Fake psyched binary (only its existence is checked). */
function psychedBin(): string {
  const file = join(tempDir(), "psyched");
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

const launchctl = (deps: TestDeps) =>
  deps.execCalls.filter((c) => c.cmd === "/bin/launchctl").map((c) => c.args);
const systemctl = (deps: TestDeps) =>
  deps.execCalls.filter((c) => c.cmd === "systemctl").map((c) => c.args);

describe("service commands on darwin (launchd)", () => {
  const notLoaded: ExecScript = (cmd, args) =>
    cmd === "/bin/launchctl" && args[0] === "print"
      ? { code: 113, stderr: "not found" }
      : undefined;

  const darwin = (execScript?: ExecScript) => {
    const bin = psychedBin();
    return {
      bin,
      deps: makeDeps({ platform: "darwin", execScript, extraEnv: { PSYCHE_GATEWAY_BIN: bin } }),
    };
  };

  it("start writes the LaunchAgent and runs print → bootstrap → kickstart", async () => {
    const { bin, deps } = darwin(notLoaded);
    expect(await run(["start", "--no-wait"], deps)).toBe(0);
    const plist = join(deps.userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
    expect(readFileSync(plist, "utf8")).toBe(
      renderLaunchAgentPlist({ program: bin, psycheHome: deps.home }),
    );
    expect(launchctl(deps)).toEqual([
      ["bootout", TARGET],
      ["print", TARGET],
      ["bootstrap", "gui/501", plist],
      ["kickstart", TARGET],
    ]);
    expect(out(deps)).toContain(`Gateway started (${plist})`);
    expect(existsSync(join(deps.home, "logs"))).toBe(true);
  });

  it("start --json; an unchanged, loaded agent is only kickstarted", async () => {
    const { bin, deps } = darwin();
    const first = await runJson(["start", "--no-wait"], deps);
    expect(first.code).toBe(0);
    expect(first.json).toEqual({
      started: true,
      file: join(deps.userHome, "Library", "LaunchAgents", `${LABEL}.plist`),
      program: bin,
      healthy: null,
    });
    deps.execCalls.length = 0;
    expect(await run(["start", "--no-wait"], deps)).toBe(0);
    expect(launchctl(deps)).toEqual([
      ["print", TARGET],
      ["kickstart", TARGET],
    ]);
  });

  it("start waits for /healthz when a Gateway answers", async () => {
    const gw = await new MockGateway().start();
    running.push(gw);
    const { deps } = darwin(notLoaded);
    const { code, json } = await runJson(["start", "--url", gw.origin], deps);
    expect(code).toBe(0);
    expect(json.healthy).toBe(true);
  });

  it("stop boots the agent out", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const { deps } = darwin();
    expect(await run(["stop", "--url", url], deps)).toBe(0);
    expect(launchctl(deps)).toEqual([["bootout", TARGET]]);
    expect(out(deps)).toBe("Gateway stopped");
  });

  it("stop treats 'not loaded' as already stopped (--json)", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const { deps } = darwin((cmd) =>
      cmd === "/bin/launchctl" ? { code: 3, stderr: "No such process" } : undefined,
    );
    const { code, json } = await runJson(["stop", "--url", url], deps);
    expect(code).toBe(0);
    expect(json).toEqual({ stopped: true });
  });

  it("restart kickstarts with -k", async () => {
    const gw = await new MockGateway().start();
    running.push(gw);
    const { deps } = darwin();
    const { code, json } = await runJson(["restart", "--url", gw.origin], deps);
    expect(code).toBe(0);
    expect(json).toEqual({ restarted: true, healthy: true });
    expect(launchctl(deps)).toEqual([["kickstart", "-k", TARGET]]);
  });

  it("status reports the launchd state and pid", async () => {
    const gw = await new MockGateway().start();
    running.push(gw);
    const { deps } = darwin((cmd, args) =>
      cmd === "/bin/launchctl" && args[0] === "print"
        ? { stdout: "gui/501/com.psyche.gateway = {\n\tstate = running\n\tpid = 4242\n}\n" }
        : undefined,
    );
    expect(await run(["status", "--url", gw.origin], deps)).toBe(0);
    expect(out(deps)).toMatch(/service:\s+launchd: running \(pid 4242\), not installed/);
    const j = makeDeps({
      platform: "darwin",
      execScript: (cmd, args) =>
        cmd === "/bin/launchctl" && args[0] === "print"
          ? { stdout: "state = running\npid = 7\n" }
          : undefined,
    });
    const { code, json } = await runJson(["status", "--url", gw.origin], j);
    expect(code).toBe(0);
    expect(json.service).toMatchObject({
      kind: "launchd",
      running: true,
      pid: 7,
      installed: false,
    });
  });

  it("status exits 1 when the Gateway is not healthy", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const { deps } = darwin(notLoaded);
    const { code, json } = await runJson(["status", "--url", url], deps);
    expect(code).toBe(1);
    expect(json.gateway).toMatchObject({ reachable: false, healthy: false });
    expect(json.service).toMatchObject({ kind: "launchd", running: false, detail: "not loaded" });
  });
});

describe("service commands on linux (systemd --user)", () => {
  const linux = (extra: ExecScript = () => undefined) => {
    const bin = psychedBin();
    const xdg = join(tempDir(), "xdg");
    const deps = makeDeps({
      platform: "linux",
      execScript: extra,
      extraEnv: { PSYCHE_GATEWAY_BIN: bin, XDG_CONFIG_HOME: xdg },
    });
    return { bin, xdg, deps };
  };

  it("start writes the unit, reloads and enables it", async () => {
    const { bin, xdg, deps } = linux();
    expect(await run(["start", "--no-wait"], deps)).toBe(0);
    const unit = join(xdg, "systemd", "user", "psyche-gateway.service");
    expect(readFileSync(unit, "utf8")).toBe(
      renderSystemdUnit({ program: bin, psycheHome: deps.home }),
    );
    expect(systemctl(deps)).toEqual([
      ["--user", "show-environment"],
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "psyche-gateway.service"],
    ]);
    expect(deps.execCalls[0]).toEqual({
      cmd: "/bin/sh",
      args: ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", "systemctl"],
    });
  });

  it("start --json; an unchanged unit is not reloaded", async () => {
    const { xdg, deps } = linux();
    const { code, json } = await runJson(["start", "--no-wait"], deps);
    expect(code).toBe(0);
    expect(json.file).toBe(join(xdg, "systemd", "user", "psyche-gateway.service"));
    deps.execCalls.length = 0;
    expect(await run(["start", "--no-wait"], deps)).toBe(0);
    expect(systemctl(deps)).toEqual([
      ["--user", "show-environment"],
      ["--user", "enable", "--now", "psyche-gateway.service"],
    ]);
  });

  it("stop and restart call systemctl --user", async () => {
    const gw = await new MockGateway().start();
    running.push(gw);
    const url = `http://127.0.0.1:${await closedPort()}`;
    const { deps } = linux();
    expect(await run(["stop", "--url", url], deps)).toBe(0);
    expect(systemctl(deps).at(-1)).toEqual(["--user", "stop", "psyche-gateway.service"]);
    expect(await run(["restart", "--url", gw.origin], deps)).toBe(0);
    expect(systemctl(deps).at(-1)).toEqual(["--user", "restart", "psyche-gateway.service"]);
  });

  it("a failing systemctl is reported (exit 1)", async () => {
    const { deps } = linux((cmd, args) =>
      cmd === "systemctl" && args[1] === "enable" ? { code: 1, stderr: "Unit failed" } : undefined,
    );
    expect(await run(["start", "--no-wait"], deps)).toBe(1);
    expect(err(deps)).toContain("systemctl enable --now failed: Unit failed");
  });

  it("without a systemd user session start points at Docker Compose", async () => {
    const { deps } = linux((cmd, args) =>
      cmd === "/bin/sh" && args.includes("systemctl") ? { code: 1 } : undefined,
    );
    expect(await run(["start", "--no-wait"], deps)).toBe(1);
    expect(err(deps)).toContain("docker compose");
  });
});

describe("finding psyched", () => {
  it("start without psyched → exit 2 with a hint", async () => {
    const deps = makeDeps({
      execScript: (cmd, args) =>
        cmd === "/bin/sh" && args[1] === "command -v psyched" ? { code: 1 } : undefined,
    });
    expect(await run(["start", "--no-wait"], deps)).toBe(2);
    expect(err(deps)).toContain("Cannot find psyched");
    expect(err(deps)).toContain("PSYCHE_GATEWAY_BIN");
    expect(deps.execCalls.some((c) => c.cmd === "systemctl")).toBe(false);
  });

  it("PSYCHE_GATEWAY_BIN pointing at a missing file → exit 2", async () => {
    const deps = makeDeps({ extraEnv: { PSYCHE_GATEWAY_BIN: "/nonexistent/psyched" } });
    expect(await run(["start", "--no-wait"], deps)).toBe(2);
    expect(err(deps)).toContain("psyched not found at /nonexistent/psyched");
  });

  it("psyched on PATH is used", async () => {
    const bin = psychedBin();
    const deps = makeDeps({
      extraEnv: { XDG_CONFIG_HOME: join(tempDir(), "xdg") },
      execScript: (cmd, args) =>
        cmd === "/bin/sh" && args[1] === "command -v psyched" ? { stdout: `${bin}\n` } : undefined,
    });
    const { code, json } = await runJson(["start", "--no-wait"], deps);
    expect(code).toBe(0);
    expect(json.program).toBe(bin);
  });

  it("--psyched overrides the environment", async () => {
    const bin = psychedBin();
    const deps = makeDeps({
      extraEnv: { PSYCHE_GATEWAY_BIN: "/nonexistent", XDG_CONFIG_HOME: join(tempDir(), "xdg") },
    });
    const { code, json } = await runJson(["start", "--no-wait", "--psyched", bin], deps);
    expect(code).toBe(0);
    expect(json.program).toBe(bin);
  });
});
