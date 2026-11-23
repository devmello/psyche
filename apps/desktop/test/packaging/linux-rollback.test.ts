import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  linuxRollbackHooks,
  psychedRunner,
  SKIP_BUILDS_FILE,
  skippedReleases,
} from "../../src/packaging/linux-rollback.ts";

/** The Linux "Go back" hooks: the psyched commands they run and `run/skip-builds.json`. */

let home: string;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fresh() {
  home = mkdtempSync(join(tmpdir(), "psyche-rollback-"));
  dirs.push(home);
  return home;
}
const ok = { code: 0, output: "" };

describe("restoreSnapshot / undoRestore", () => {
  it("run the Gateway's go-back commands for that version", async () => {
    const ran: string[][] = [];
    const h = linuxRollbackHooks({
      home: fresh(),
      run: async (a) => (ran.push(a), ok),
    });
    await h.restoreSnapshot("0.4.0");
    await h.undoRestore("0.4.0");
    expect(ran).toEqual([
      ["pre-update", "go-back", "0.4.0"],
      ["pre-update", "go-back-undo", "0.4.0"],
    ]);
  });

  it("throw, with what psyched said, on a non-zero exit", async () => {
    const h = linuxRollbackHooks({
      home: fresh(),
      run: async () => ({ code: 1, output: "error: 2 file(s) could not be put back\n" }),
    });
    await expect(h.restoreSnapshot("0.4.0")).rejects.toThrow(/exit 1.*could not be put back/);
    await expect(h.undoRestore("0.4.0")).rejects.toThrow(/newer data could not be put back/);
  });

  it("throw when psyched cannot be started", async () => {
    const h = linuxRollbackHooks({
      home: fresh(),
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    await expect(h.undoRestore("0.4.0")).rejects.toThrow(/ENOENT/);
  });
});

describe("recordSkipBuild", () => {
  it("writes run/skip-builds.json, keeps earlier entries and replaces the same release", async () => {
    const dir = fresh();
    const h = linuxRollbackHooks({
      home: dir,
      now: () => new Date("2026-11-22T10:00:00Z"),
      run: async () => ok,
    });
    await h.recordSkipBuild({ release: "1.1.0", build: "b1" });
    await h.recordSkipBuild({ release: "1.2.0" });
    await h.recordSkipBuild({ release: "1.1.0", build: "b2" });
    const file = JSON.parse(readFileSync(join(dir, SKIP_BUILDS_FILE), "utf8"));
    expect(file.skipped).toEqual([
      { release: "1.2.0", at: "2026-11-22T10:00:00.000Z" },
      { release: "1.1.0", build: "b2", at: "2026-11-22T10:00:00.000Z" },
    ]);
    expect(skippedReleases(dir)).toEqual(["1.2.0", "1.1.0"]);
    expect(h.isSkipped("1.1.0")).toBe(true);
    expect(h.isSkipped("1.3.0")).toBe(false);
  });

  it("starts over from a damaged file", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "run"));
    writeFileSync(join(dir, SKIP_BUILDS_FILE), "{broken");
    const h = linuxRollbackHooks({ home: dir, run: async () => ok });
    expect(h.isSkipped("1.1.0")).toBe(false);
    await h.recordSkipBuild({ release: "1.1.0" });
    expect(skippedReleases(dir)).toEqual(["1.1.0"]);
  });

  it("still writes the skip entry when the commit fails, and says so", async () => {
    const dir = fresh();
    const h = linuxRollbackHooks({
      home: dir,
      run: async () => ({ code: 1, output: "error: nope" }),
    });
    await expect(h.recordSkipBuild({ release: "1.1.0" })).rejects.toThrow(/could not record/);
    expect(skippedReleases(dir)).toEqual(["1.1.0"]);
  });
});

describe("psychedRunner", () => {
  it("runs the launch program with its leading args, PSYCHE_HOME set, and reports the exit code", async () => {
    const dir = fresh();
    const script = join(dir, "fake-psyched.sh");
    writeFileSync(script, '#!/bin/sh\necho "args=$*"\necho "home=$PSYCHE_HOME"\nexit 3\n', {
      mode: 0o755,
    });
    const run = psychedRunner(
      { program: script, args: ["--psyched"] },
      { PATH: "/usr/bin:/bin" },
      dir,
    );
    const res = await run(["pre-update", "go-back", "0.4.0"]);
    expect(res.code).toBe(3);
    expect(res.output).toContain("args=--psyched pre-update go-back 0.4.0");
    expect(res.output).toContain(`home=${dir}`);
  });
});
