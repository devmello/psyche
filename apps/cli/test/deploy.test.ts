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
      renderLaunchAgentPlist({
        program: "/usr/local/bin/psyched",
        psycheHome: "/Users/you/.psyche",
      }),
    );
  });

  it.skipIf(!existsSync("/usr/bin/plutil"))("passes plutil -lint", () => {
    expect(() =>
      execFileSync("/usr/bin/plutil", [
        "-lint",
        resolve(deploy, "launchd/com.psyche.gateway.plist"),
      ]),
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
    const r = spawnSync(
      "systemd-analyze",
      ["--user", "verify", resolve(deploy, "systemd/psyche-gateway.service")],
      {
        encoding: "utf8",
      },
    );
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
    expect(dockerfile).toMatch(/node:24\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).not.toMatch(/EXPOSE/);
  });
});

describe("deploy/docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  it("keeps the Gateway on loopback with no published ports", () => {
    // No PSYCHE_HOST: the Gateway's default is loopback and env would override config.json.
    expect(compose).not.toMatch(/PSYCHE_(HOST|PORT|ALLOWED_ORIGINS):/);
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/psyche-home:\/data/);
    // The Docker socket mount stays commented out (documented as a risk).
    expect(compose).not.toMatch(/^\s+- \/var\/run\/docker\.sock/m);
  });

  it.skipIf(!has("docker"))("is valid for every profile", () => {
    for (const args of [
      [],
      ["--profile", "tailscale", "--profile", "cloudflare", "--profile", "browser"],
    ]) {
      const r = spawnSync(
        "docker",
        ["compose", "-f", resolve(deploy, "docker-compose.yml"), ...args, "config", "-q"],
        {
          encoding: "utf8",
        },
      );
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

describe("deploy/sandbox-image/publish.sh --dry-run (what the release job runs before a tag)", () => {
  it.skipIf(!has("jq"))(
    "prints build, push and sign for every variant and leaves versions.json alone",
    () => {
      const script = resolve(deploy, "sandbox-image/publish.sh");
      const before = read("sandbox-image/versions.json");
      const r = spawnSync(
        "bash",
        [script, "--dry-run", "--version", "1.2.3", "core", "base", "full"],
        {
          encoding: "utf8",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const out = `${r.stdout}${r.stderr}`;
      for (const tag of ["1.2.3-core", "1.2.3", "1.2.3-full"]) {
        expect(out).toContain(`ghcr.io/devmello/psyche-sandbox:${tag}`);
      }
      expect(out.match(/\+ cosign sign --yes/g)).toHaveLength(3);
      expect(out).toContain("--provenance=mode=max");
      expect(read("sandbox-image/versions.json")).toBe(before);
      expect(
        spawnSync("bash", [script, "--dry-run", "--version", "1.2"], { encoding: "utf8" }).status,
      ).toBe(2);
    },
  );
});

describe("deploy/scripts/node-pins.mjs (#295)", () => {
  const script = resolve(deploy, "scripts/node-pins.mjs");

  it("every Node pin in the repository is an exact, digest-pinned version, and they agree", () => {
    const r = spawnSync(process.execPath, [script, "check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/deploy\/Dockerfile: node:24\.\d+\.\d+-bookworm-slim@sha256:/);
    expect(r.stdout).toMatch(
      /deploy\/sandbox-image\/Dockerfile: node:24\.\d+\.\d+-trixie-slim@sha256:/,
    );
  });

  it("finds floating and disagreeing pins, and rewrites every variant to one version", async () => {
    const { checkPins, findPins, repin } = (await import(script)) as {
      checkPins: (b: Record<string, unknown[]>) => { problems: string[] };
      findPins: (t: string) => { version: string; variant: string }[];
      repin: (t: string, v: string, d: (tag: string) => Promise<string>) => Promise<string>;
    };
    const d = (c: string) => c.repeat(64);
    const text = `FROM node:24-bookworm@sha256:${d("a")}\nARG X=node:24.22.0-trixie-slim@sha256:${d("b")}\n`;
    expect(findPins(text).map((p) => `${p.version}-${p.variant}`)).toEqual([
      "24-bookworm",
      "24.22.0-trixie-slim",
    ]);
    expect(checkPins({ f: findPins(text) }).problems).toEqual([
      "f: node:24-bookworm is not an exact version",
      "pins disagree: 24, 24.22.0",
    ]);
    const out = await repin(text, "24.22.1", async (tag) =>
      tag.endsWith("trixie-slim") ? d("d") : d("c"),
    );
    expect(out).toBe(
      `FROM node:24.22.1-bookworm@sha256:${d("c")}\nARG X=node:24.22.1-trixie-slim@sha256:${d("d")}\n`,
    );
    expect(checkPins({ f: findPins(out) }).problems).toEqual([]);
  });
});
