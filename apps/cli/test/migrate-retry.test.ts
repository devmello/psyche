import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import { scriptedPrompter } from "../src/prompt.ts";
import { closedPort } from "./helpers.ts";

/**
 * `psyche migrate --retry`, and the explicit "I restored it myself" for an unfinished restore:
 * it must never let the Gateway start on a missing database or under a running Gateway.
 */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function migrate(home: string, args: string[]) {
  const out: string[] = [];
  const deps: Deps = {
    env: { HOME: home, PSYCHE_HOME: home },
    io: { out: (t) => out.push(t), err: () => {}, stdin: new PassThrough() },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    fetch,
    prompter: scriptedPrompter([], false),
    platform: "linux",
    uid: 501,
    now: () => new Date(),
  };
  const url = `http://127.0.0.1:${await closedPort()}`;
  const code = await run(["migrate", ...args, "--url", url, "--json"], deps);
  return { code, json: JSON.parse(out.join("\n")) as Record<string, unknown> };
}

/** A home with an unfinishable restore: its note, its marker and a snapshot of one database. */
function interrupted() {
  const home = mkdtempSync(join(tmpdir(), "psy-retry-"));
  homes.push(home);
  mkdirSync(join(home, "run"));
  const snapshot = join(home, "backups", "pre-update", "0.4.0-to-0.5.0-x");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(
    join(snapshot, "manifest.json"),
    JSON.stringify({
      entries: [
        { rel: "state/psyche.sqlite" },
        { rel: "config.json" },
        { rel: "state/memory.sqlite" },
      ],
    }),
  );
  writeFileSync(
    join(home, "run", "restore-in-progress.json"),
    JSON.stringify({ snapshot, onlyDatabases: false }),
  );
  writeFileSync(
    join(home, "run", "update-failed.json"),
    JSON.stringify({ key: "restore-interrupted", message: "x" }),
  );
  return home;
}
const put = (home: string, rel: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), "data");
};

describe("psyche migrate --retry", () => {
  it("forgets a failed update but leaves an unfinished restore for the Gateway to finish", async () => {
    const home = interrupted();
    const plain = await migrate(home, ["--retry"]);
    expect(plain.json).toEqual({ retry: true, cleared: true });
    expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(true);
    expect(existsSync(join(home, "run", "update-failed.json"))).toBe(false);
  });
});

describe("psyche migrate --retry --restored-by-hand", () => {
  it("refuses while any file the restore was putting back is missing, and says which", async () => {
    const home = interrupted();
    put(home, "config.json");
    const r = await migrate(home, ["--retry", "--restored-by-hand"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      refused: "missing",
      missing: ["state/psyche.sqlite", "state/memory.sqlite"],
    });
    // Nothing was cleared.
    expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(true);
    expect(existsSync(join(home, "run", "update-failed.json"))).toBe(true);
  });

  it("goes ahead once everything is there", async () => {
    const home = interrupted();
    for (const rel of ["config.json", "state/psyche.sqlite", "state/memory.sqlite"]) put(home, rel);
    const r = await migrate(home, ["--retry", "--restored-by-hand"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ retry: true, cleared: true, restoredByHand: true });
    expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(false);
    expect(existsSync(join(home, "run", "update-failed.json"))).toBe(false);
  });

  it("refuses when there is no unfinished restore to forget", async () => {
    const home = mkdtempSync(join(tmpdir(), "psy-retry-"));
    homes.push(home);
    mkdirSync(join(home, "run"));
    writeFileSync(join(home, "run", "update-failed.json"), JSON.stringify({ key: "build-b" }));
    const r = await migrate(home, ["--retry", "--restored-by-hand"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ refused: "no_note" });
    expect(existsSync(join(home, "run", "update-failed.json"))).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "refuses while a Gateway holds the data folder, even with everything in place",
    async () => {
      const home = interrupted();
      for (const rel of ["config.json", "state/psyche.sqlite", "state/memory.sqlite"])
        put(home, rel);
      // What the Gateway does: an open file with O_EXLOCK on run/gateway.lock, for its life.
      const fd = openSync(
        join(home, "run", "gateway.lock"),
        0x0200 | 0x0002 | 0x0004 | 0x20,
        0o600,
      );
      try {
        const r = await migrate(home, ["--retry", "--restored-by-hand"]);
        expect(r.code).toBe(1);
        expect(r.json).toMatchObject({ refused: "gateway_running" });
        expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(true);
      } finally {
        closeSync(fd);
      }
    },
  );
});
