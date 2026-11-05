import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_UNIT_MARKER,
  parseGatewayUnit,
  renderGatewayDropIn,
  renderGatewayUnit,
  renderHelperUnit,
  sdQuote,
  userUnitDir,
} from "../../src/platform/systemd-unit.ts";

const deploy = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "deploy",
  "systemd",
);
const read = (name: string) => readFileSync(join(deploy, name), "utf8");
const hasAnalyze = spawnSync("systemd-analyze", ["--version"]).status === 0;

describe("gateway unit text", () => {
  const desktop = renderGatewayUnit({
    program: "/opt/Psyche Dir/psyched",
    args: ["--psyched"],
    psycheHome: "/home/me/.psyche",
    profile: "desktop",
    build: "abc123",
    vaultKeyFile: "/home/me/.psyche/secrets/vault.key",
  });

  it("desktop profile follows the design: default.target, no graphical session, a throttle not a kill", () => {
    expect(desktop).toContain("After=default.target");
    expect(desktop).not.toContain("graphical-session.target\nAfter");
    expect(desktop).not.toMatch(/^PartOf=/m);
    expect(desktop).toMatch(/^MemoryHigh=768M$/m);
    expect(desktop).not.toMatch(/^MemoryMax=/m);
    expect(desktop).not.toMatch(/DISPLAY/);
    for (const k of [
      "NoNewPrivileges=yes",
      "LockPersonality=yes",
      "RestrictSUIDSGID=yes",
      "UMask=0077",
    ]) {
      expect(desktop).toContain(k);
    }
    expect(desktop).toMatch(/^Restart=on-failure$/m);
    expect(desktop).toMatch(/^WantedBy=default\.target$/m);
    expect(desktop).toContain(DESKTOP_UNIT_MARKER);
  });

  it("quotes ExecStart and carries the environment", () => {
    expect(desktop).toContain('ExecStart="/opt/Psyche Dir/psyched" "--psyched"');
    expect(desktop).toContain('Environment="PSYCHE_BUILD=abc123"');
    expect(desktop).toContain(
      'Environment="PSYCHE_VAULT_KEY_FILE=/home/me/.psyche/secrets/vault.key"',
    );
  });

  it("escapes $ only in ExecStart and % everywhere", () => {
    expect(sdQuote("a$b%c", true)).toBe('"a$$b%%c"');
    expect(sdQuote("a$b%c")).toBe('"a$b%%c"');
  });

  it("parses back what it renders, and tells the profiles apart", () => {
    expect(parseGatewayUnit(desktop)).toMatchObject({
      program: "/opt/Psyche Dir/psyched",
      args: ["--psyched"],
      profile: "desktop",
      env: { PSYCHE_BUILD: "abc123", PSYCHE_HOME: "/home/me/.psyche" },
    });
    expect(parseGatewayUnit(renderGatewayUnit({ program: "/x/psyched" }))?.profile).toBe("server");
    expect(parseGatewayUnit("[Unit]\n")).toBeUndefined();
  });

  it("the drop-in has only a [Service] section with the per-machine values", () => {
    const d = renderGatewayDropIn({ psycheHome: "/h", build: "b", vaultKeyFile: "/k" });
    expect(d).toContain("[Service]");
    expect(d).not.toContain("ExecStart");
    expect(d).toContain('Environment="PSYCHE_BUILD=b"');
  });

  it("user unit dir honours XDG_CONFIG_HOME", () => {
    expect(userUnitDir({}, "/home/me")).toBe("/home/me/.config/systemd/user");
    expect(userUnitDir({ XDG_CONFIG_HOME: "/x" }, "/home/me")).toBe("/x/systemd/user");
    expect(userUnitDir({ XDG_CONFIG_HOME: "" }, "/home/me")).toBe("/home/me/.config/systemd/user");
  });
});

describe("helper unit", () => {
  const unit = renderHelperUnit({ program: "/h/psyche-helper", psycheHome: "/home/me/.psyche" });
  it("starts on demand, needs a display, and has no sandboxing keys", () => {
    expect(unit).not.toMatch(/^\[Install\]$/m);
    expect(unit).toMatch(/^PartOf=graphical-session\.target$/m);
    expect(unit).toMatch(/^After=graphical-session\.target$/m);
    expect(unit).toMatch(/^Restart=no$/m);
    for (const k of ["NoNewPrivileges", "UMask", "RestrictSUIDSGID", "MemoryHigh"]) {
      expect(unit).not.toContain(k);
    }
  });
});

describe("deploy/systemd/ is pinned to the renderer", () => {
  it("psyche-gateway.service is the server profile for its example input", () => {
    expect(read("psyche-gateway.service")).toBe(
      renderGatewayUnit({
        program: "/usr/local/bin/psyched",
        psycheHome: "/home/you/.psyche",
        profile: "server",
      }),
    );
  });

  it("psyche-gateway-desktop.service is the packaged desktop unit under /usr/lib/psyche", () => {
    const text = read("psyche-gateway-desktop.service");
    expect(text).toBe(
      renderGatewayUnit({
        program: "/usr/lib/psyche/resources/psyched/psyched",
        profile: "desktop",
      }),
    );
    // The per-machine values come from the drop-in the desktop writes, never from the package.
    expect(text).not.toContain("PSYCHE_HOME");
    expect(text).not.toContain("PSYCHE_BUILD");
  });

  it("psyche-helper.service is the on-demand helper unit", () => {
    expect(read("psyche-helper.service")).toBe(
      renderHelperUnit({ program: "/usr/lib/psyche/resources/linux-helper/psyche-helper" }),
    );
  });

  it.skipIf(!hasAnalyze)(
    "every rendered unit passes systemd-analyze verify (missing binaries aside)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "psyche-verify-"));
      try {
        for (const name of [
          "psyche-gateway.service",
          "psyche-gateway-desktop.service",
          "psyche-helper.service",
        ]) {
          const file = join(dir, name);
          // Point ExecStart at a binary that exists so only real syntax problems show.
          writeFileSync(file, read(name).replace(/ExecStart="[^"]+"/, 'ExecStart="/bin/true"'));
          const r = spawnSync("systemd-analyze", ["--user", "verify", file]);
          expect(`${name}: ${String(r.stderr)}`).toBe(`${name}: `);
          expect(r.status).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
