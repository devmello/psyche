import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/backup.ts";
import { validateConfig } from "../src/config-file.ts";
import type { Exec } from "../src/exec.ts";
import { serviceCommand } from "../src/supervisor.ts";

/** Regressions from the S22 review: untrusted manifests, node shims, non-loopback hosts. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const manifest = (entries: unknown, files: unknown) =>
  JSON.stringify({
    format: "psyche-backup",
    version: 1,
    createdAt: "",
    cliVersion: "t",
    entries,
    files,
  });
const file = (path: string) => ({ path, size: 1, sha256: "00" });

describe("parseManifest (the manifest is untrusted archive content)", () => {
  it("accepts known entries and files under them", () => {
    const m = parseManifest(
      manifest(["state", "config.json"], [file("state/a.db"), file("config.json")]),
      "b",
    );
    expect(m.entries).toEqual(["state", "config.json"]);
  });

  it.each([
    [["../.bashrc"], []],
    [[".bashrc"], []],
    [["state/../../x"], []],
    [["state", "state"], []],
    [["state"], [file("../etc/passwd")]],
    [["state"], [file("/etc/passwd")]],
    [["state"], [file("state/../../x")]],
    [["state"], [file("workspace/a.md")]],
    [["state"], [file("state//a")]],
    ["state", []],
  ])("rejects entries %j with files %j", (entries, files) => {
    expect(() => parseManifest(manifest(entries, files), "b")).toThrow(/invalid manifest/);
  });

  it("rejects a foreign format", () => {
    expect(() => parseManifest(JSON.stringify({ format: "x", version: 1 }), "b")).toThrow(
      /unsupported/,
    );
  });
});

describe("serviceCommand (launchd and systemd have a minimal PATH)", () => {
  const exec: Exec = async (_cmd, args) =>
    String(args[1]).includes("command -v node")
      ? { code: 0, stdout: "/opt/node/bin/node\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "" };

  it("runs an `env node` script with node's absolute path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psy-shim-"));
    dirs.push(dir);
    const shim = join(dir, "psyched");
    writeFileSync(shim, "#!/usr/bin/env node\nimport('x');\n");
    const env = { env: {}, exec, platform: "darwin" as const, uid: 501, home: dir };
    expect(await serviceCommand(env, shim)).toEqual({
      program: "/opt/node/bin/node",
      args: [shim],
    });
  });

  it("leaves a native executable alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psy-bin-"));
    dirs.push(dir);
    const bin = join(dir, "psyched");
    writeFileSync(bin, "\x7fELF....");
    const env = { env: {}, exec, platform: "linux" as const, uid: 1000, home: dir };
    expect(await serviceCommand(env, bin)).toEqual({ program: bin, args: [] });
  });
});

describe("validateConfig", () => {
  it("refuses a non-loopback gateway.host like the Gateway does", () => {
    expect(validateConfig({ gateway: { host: "0.0.0.0" } }).join()).toMatch(/not loopback/);
    expect(validateConfig({ gateway: { host: "::1" } })).toEqual([]);
  });
});
