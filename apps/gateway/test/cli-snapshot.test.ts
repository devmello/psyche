import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, takeExclusiveFileLock } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { GATEWAY_LOCK_FILE, listSnapshots } from "../src/pre-update.ts";

/**
 * `psyched snapshot <to>` (linux-helper-only design §3.2, wave B1): the pre-update snapshot that
 * `psyche update` asks the installed build for before it replaces it.
 */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PSYCHE_HOME;
  process.env.PSYCHE_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PSYCHE_HOME;
    else process.env.PSYCHE_HOME = prev;
  }
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "psy-snap-"));
  homes.push(h);
  mkdirSync(join(h, "state"));
  return h;
}

const run = async (h: string, argv: string[]) => {
  const lines: string[] = [];
  const code = await withHome(h, () => runCli(argv, (l) => lines.push(l)));
  return { code, lines };
};

describe("psyched snapshot", () => {
  it("copies the databases and config.json into backups/pre-update and prints the folder", async () => {
    const h = home();
    const db = openDb(join(h, "state", "psyche.sqlite"));
    db.sqlite.exec("CREATE TABLE marker (v TEXT)");
    db.sqlite.prepare("INSERT INTO marker VALUES ('before the update')").run();
    db.close();
    writeFileSync(join(h, "config.json"), '{"gateway":{}}\n');
    const { code, lines } = await run(h, ["snapshot", "9.9.9"]);
    expect(code).toBe(0);
    const dir = lines.at(-1) as string;
    expect(dir).toContain(join(h, "backups", "pre-update"));
    expect(dir).toMatch(/-to-9\.9\.9-/);
    const [snap] = listSnapshots(h);
    expect(snap?.manifest.to).toBe("9.9.9");
    const rels = snap?.manifest.entries.map((e) => e.rel).sort();
    expect(rels).toEqual(["config.json", "state/psyche.sqlite"]);
    expect(readFileSync(join(dir, "files", "config.json"), "utf8")).toBe('{"gateway":{}}\n');
  });

  it("refuses while a Gateway holds the data folder, and copies nothing", async () => {
    const h = home();
    openDb(join(h, "state", "psyche.sqlite")).close();
    mkdirSync(join(h, "run"), { recursive: true });
    const held = takeExclusiveFileLock(join(h, GATEWAY_LOCK_FILE));
    expect(held).not.toBeNull();
    try {
      const { code, lines } = await run(h, ["snapshot", "9.9.9"]);
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("psyched is running");
      expect(listSnapshots(h)).toEqual([]);
    } finally {
      held?.release();
    }
  });

  it("needs a release version, and does nothing without a data folder", async () => {
    const h = home();
    for (const bad of [[], ["latest"], ["1.2"], ["../1.2.3"], ["1.2.3/x"]]) {
      expect((await run(h, ["snapshot", ...bad])).code).toBe(2);
    }
    expect(existsSync(join(h, "backups"))).toBe(false);
    const gone = join(h, "nowhere");
    const { code, lines } = await run(gone, ["snapshot", "1.2.3"]);
    expect(code).toBe(5);
    expect(lines.join("\n")).toContain("nothing to copy");
    expect(existsSync(gone)).toBe(false);
  });
});
