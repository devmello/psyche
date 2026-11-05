import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PSYCHE_LAUNCHER,
  PSYCHE_LAUNCHER_LINUX,
  PSYCHED_LAUNCHER,
  PSYCHED_LAUNCHER_LINUX,
  // @ts-expect-error plain .mjs without types; importing it does not run the build.
} from "../../../deploy/scripts/build-psyched.mjs";

/** The Linux flavour of the Gateway bundle (deploy/scripts/build-psyched.mjs --platform linux). */

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-psyched-linux-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Linux launchers", () => {
  it("keep the compile cache under XDG_CACHE_HOME or ~/.cache, not ~/Library", () => {
    for (const l of [PSYCHED_LAUNCHER_LINUX, PSYCHE_LAUNCHER_LINUX]) {
      expect(l).toContain("$XDG_CACHE_HOME/psyche/node-compile-cache");
      expect(l).toContain("$HOME/.cache/psyche/node-compile-cache");
      expect(l).not.toContain("Library");
      expect(l).toMatch(/^unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE$/m);
      expect(l.indexOf("unset NODE_OPTIONS")).toBeLessThan(l.indexOf("exec "));
    }
    expect(PSYCHED_LAUNCHER_LINUX).toContain("--max-semi-space-size=4");
  });

  it("leave the macOS launchers as they were", () => {
    expect(PSYCHED_LAUNCHER).toContain(
      "$HOME/Library/Caches/com.psyche.gateway/node-compile-cache",
    );
    expect(PSYCHE_LAUNCHER).toContain("$HOME/Library/Caches/com.psyche.gateway/node-compile-cache");
  });

  it.skipIf(process.platform === "win32")(
    "are valid sh, and set the cache path as designed",
    () => {
      const d = temp();
      mkdirSync(join(d, "runtime"), { recursive: true });
      writeFileSync(join(d, "psyched"), PSYCHED_LAUNCHER_LINUX, { mode: 0o755 });
      // A stand-in runtime that prints what the launcher exported.
      writeFileSync(join(d, "runtime", "node"), '#!/bin/sh\necho "$NODE_COMPILE_CACHE"\n', {
        mode: 0o755,
      });
      const run = (env: Record<string, string>) =>
        spawnSync(join(d, "psyched"), [], {
          env: { PATH: "/usr/bin:/bin", ...env },
          encoding: "utf8",
        });
      expect(run({ HOME: "/home/me" }).stdout.trim()).toBe(
        "/home/me/.cache/psyche/node-compile-cache",
      );
      expect(run({ HOME: "/home/me", XDG_CACHE_HOME: "/c" }).stdout.trim()).toBe(
        "/c/psyche/node-compile-cache",
      );
      expect(run({ HOME: "/home/me", NODE_COMPILE_CACHE: "/mine" }).stdout.trim()).toBe("/mine");
    },
  );
});
