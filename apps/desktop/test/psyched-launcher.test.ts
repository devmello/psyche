import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PSYCHE_LAUNCHER,
  PSYCHED_HARDEN,
  PSYCHED_LAUNCHER,
  // @ts-expect-error plain .mjs without types; importing it does not run the build.
} from "../../../deploy/scripts/build-psyched.mjs";

/**
 * Electron's fuses do not cover psyched's Node. The launcher clears the environment variables that
 * add code to Node and loads psyched-harden.cjs so the per-user module folders are not searched.
 * The test runs this machine's Node, never the bundled runtime or the app.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("psyched launcher", () => {
  it("unsets NODE_OPTIONS, NODE_PATH and NODE_REPL_EXTERNAL_MODULE and preloads the hardening file", () => {
    const launcher = String(PSYCHED_LAUNCHER);
    expect(launcher).toMatch(/^unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE$/m);
    expect(launcher).toContain('--require "$here/psyched-harden.cjs"');
    // The unset comes before the exec that starts Node.
    expect(launcher.indexOf("unset NODE_OPTIONS")).toBeLessThan(launcher.indexOf("exec "));
  });

  it("the psyche CLI launcher is closed the same way", () => {
    const launcher = String(PSYCHE_LAUNCHER);
    expect(launcher).toMatch(/^unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE$/m);
    expect(launcher).toContain('--require "$here/psyched-harden.cjs"');
    expect(launcher.indexOf("unset NODE_OPTIONS")).toBeLessThan(launcher.indexOf("exec "));
  });

  it("psyched-harden.cjs stops require() from reading ~/.node_modules, and keeps HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-harden-"));
    dirs.push(dir);
    const home = join(dir, "home");
    mkdirSync(join(home, ".node_modules", "psyche_probe"), { recursive: true });
    writeFileSync(
      join(home, ".node_modules", "psyche_probe", "index.js"),
      "module.exports = 'from-home';",
    );
    const harden = join(dir, "harden.cjs");
    writeFileSync(harden, PSYCHED_HARDEN);
    const probe =
      "try { process.stdout.write(require('psyche_probe') + ' ' + process.env.HOME); } catch { process.stdout.write('not-found ' + process.env.HOME); }";
    const run = (args: string[]) =>
      spawnSync(process.execPath, [...args, "-e", probe], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home },
      }).stdout;
    // Control: without the preload, the home folder is searched.
    expect(run([])).toBe(`from-home ${home}`);
    expect(run(["--require", harden])).toBe(`not-found ${home}`);
  });
});
