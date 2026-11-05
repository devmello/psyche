import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { Deps } from "../src/context.ts";
import { scriptedPrompter } from "../src/prompt.ts";
import { closedPort } from "./helpers.ts";

/** `psyche migrate --retry`, and the explicit "I restored it myself" for an unfinished restore. */

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

describe("psyche migrate --retry --restored-by-hand", () => {
  it("leaves an unfinished restore alone unless the owner says they did it themselves", async () => {
    const home = mkdtempSync(join(tmpdir(), "psy-retry-"));
    homes.push(home);
    mkdirSync(join(home, "run"));
    const marker = join(home, "run", "restore-in-progress.json");
    const note = join(home, "run", "update-failed.json");
    writeFileSync(marker, "{}");
    writeFileSync(note, "{}");

    // A plain retry forgets the failed update but not the restore: the Gateway finishes that.
    const plain = await migrate(home, ["--retry"]);
    expect(plain.json).toEqual({ retry: true, cleared: true });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(note)).toBe(false);

    writeFileSync(note, "{}");
    const byHand = await migrate(home, ["--retry", "--restored-by-hand"]);
    expect(byHand.json).toEqual({ retry: true, cleared: true, restoredByHand: true });
    expect(existsSync(marker)).toBe(false);
  });
});
