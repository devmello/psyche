import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";

/** `psyched devices ...` and `presence reset` never migrate the data behind the Gateway's back. */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.PSYCHE_HOME;
  process.env.PSYCHE_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PSYCHE_HOME;
    else process.env.PSYCHE_HOME = prev;
  }
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "psy-clim-"));
  homes.push(h);
  mkdirSync(join(h, "state"));
  return h;
}

describe("the Gateway's own CLI", () => {
  it("stops when the data still needs migrations, and leaves it as it was", () => {
    const h = home();
    const path = join(h, "state", "psyche.sqlite");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE _migrations (id TEXT PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)",
    );
    old.close();
    for (const argv of [
      ["devices", "list"],
      ["presence", "reset"],
      ["devices", "approve", "ABCD-EFGH"],
    ]) {
      const lines: string[] = [];
      expect(withHome(h, () => runCli(argv, (l) => lines.push(l)))).toBe(1);
      expect(lines.join("\n")).toContain("start Psyche (or psyched) once");
    }
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare("SELECT count(*) AS n FROM _migrations").get()).toEqual({ n: 0 });
    check.close();
  });

  it("works as before on data that is up to date, and on a new install", () => {
    const h = home();
    openDb(join(h, "state", "psyche.sqlite")).close();
    const lines: string[] = [];
    expect(withHome(h, () => runCli(["devices", "list"], (l) => lines.push(l)))).toBe(0);
    const fresh = home();
    expect(withHome(fresh, () => runCli(["devices", "list"], () => undefined))).toBe(0);
  });
});
