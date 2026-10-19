import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLaunchAgentPlist, renderSystemdUnit } from "../src/supervisor.ts";

/** The files in deploy/ are the CLI's renderers' output, and each one validates. */

const deploy = resolve(import.meta.dirname, "../../../deploy");
const read = (p: string) => readFileSync(resolve(deploy, p), "utf8");
const has = (cmd: string) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`]).status === 0;

describe("deploy/launchd/com.psyche.gateway.plist", () => {
  it("is what `psyche start` writes for the example paths", () => {
    expect(read("launchd/com.psyche.gateway.plist")).toBe(
      renderLaunchAgentPlist({ program: "/usr/local/bin/psyched", psycheHome: "/Users/you/.psyche" }),
    );
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("passes plutil -lint", () => {
    expect(() =>
      execFileSync("/usr/bin/plutil", ["-lint", resolve(deploy, "launchd/com.psyche.gateway.plist")]),
    ).not.toThrow();
  });
});

describe("deploy/systemd/psyche-gateway.service", () => {
  it("is what `psyche start` writes for the example paths", () => {
    expect(read("systemd/psyche-gateway.service")).toBe(
      renderSystemdUnit({ program: "/usr/local/bin/psyched", psycheHome: "/home/you/.psyche" }),
    );
  });

  it.skipIf(!has("systemd-analyze"))("passes systemd-analyze verify", () => {
    const r = spawnSync("systemd-analyze", ["--user", "verify", resolve(deploy, "systemd/psyche-gateway.service")], {
      encoding: "utf8",
    });
    // The example ExecStart path does not exist on the runner; every other complaint is a failure.
    const problems = r.stderr
      .split("\n")
      .filter((l) => l.trim() && !/is not executable|No such file|Command .* not found/.test(l));
    expect(problems).toEqual([]);
  });
});

describe("deploy/Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("runs as a non-root user with a /healthz healthcheck on Node 24", () => {
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\n.*\/healthz/m);
    expect(dockerfile).toMatch(/node:24-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).not.toMatch(/EXPOSE/);
  });
});

describe("deploy/docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  it("keeps the Gateway on loopback with no published ports", () => {
    expect(compose).toMatch(/PSYCHE_HOST: 127\.0\.0\.1/);
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/psyche-home:\/data/);
    // The Docker socket mount stays commented out (documented as a risk).
    expect(compose).not.toMatch(/^\s+- \/var\/run\/docker\.sock/m);
  });

  it.skipIf(!has("docker"))("is valid for every profile", () => {
    for (const args of [[], ["--profile", "tailscale", "--profile", "cloudflare", "--profile", "browser"]]) {
      const r = spawnSync("docker", ["compose", "-f", resolve(deploy, "docker-compose.yml"), ...args, "config", "-q"], {
        encoding: "utf8",
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });
});

describe("deploy/backup", () => {
  it.each(["backup.sh", "restore.sh", "verify.sh"])("%s is valid sh", (name) => {
    const r = spawnSync("/bin/sh", ["-n", resolve(deploy, "backup", name)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
