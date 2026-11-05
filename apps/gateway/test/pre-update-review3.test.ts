import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { listSnapshots, openDbWithSnapshot, preUpdateDir } from "../src/pre-update.ts";

/** Round-3 review: crash loops, and a release that ran in between. */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const M1 = "202601010000_test_one.sql";
const M2 = "202601020000_test_two.sql";
const M3 = "202601030000_test_three.sql";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "psy-r3-"));
  roots.push(root);
  const home = join(root, "home");
  const migrations = join(root, "migrations");
  const half = join(root, "half");
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(migrations);
  mkdirSync(half);
  const m1 = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);";
  const m2 = "ALTER TABLE notes ADD COLUMN tag TEXT;";
  for (const dir of [migrations, half]) writeFileSync(join(dir, M1), m1);
  for (const dir of [migrations, half]) writeFileSync(join(dir, M2), m2);
  writeFileSync(join(migrations, M3), "CREATE TABLE extra (id INTEGER);");
  const dbPath = join(home, "state", "psyche.sqlite");
  // The installed data is at M1 only: M2 and M3 are the update.
  const v1 = join(root, "v1");
  mkdirSync(v1);
  writeFileSync(join(v1, M1), m1);
  const db = openDb(dbPath, { migrationsDir: v1 });
  db.sqlite.prepare("INSERT INTO notes (body) VALUES ('keep me')").run();
  db.close();
  return { root, home, migrations, half, dbPath };
}

type S = ReturnType<typeof setup>;

const at = (n: number) => () => new Date(Date.UTC(2026, 10, 5, 12, n, 0));
const base = (s: S, over: Record<string, unknown> = {}) => ({
  home: s.home,
  dbPath: s.dbPath,
  version: "0.5.0",
  build: "build-b",
  now: at(0),
  open: { migrationsDir: s.migrations },
  ...over,
});
const bodies = (path: string) => {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    return (d.prepare("SELECT body FROM notes ORDER BY id").all() as { body: string }[]).map(
      (r) => r.body,
    );
  } finally {
    d.close();
  }
};
const displaced = (s: S) =>
  readdirSync(preUpdateDir(s.home)).filter((n) => n.startsWith(".displaced-"));

/** An opener that applies M2 only (half of the update) and then dies the way a crash does. */
const dyingAfterM2 = (s: S) => (path: string) => {
  const d = openDb(path, { migrationsDir: s.half });
  d.sqlite.prepare("INSERT INTO notes (body) VALUES ('written by the half-done start')").run();
  d.close();
  throw new Error("killed");
};

describe("a start that crashes over and over", () => {
  it("keeps the first half-migrated copy only, not one more per lap", async () => {
    const s = setup();
    await expect(openDbWithSnapshot(base(s, { opener: dyingAfterM2(s) }))).rejects.toThrow(
      "killed",
    );
    for (let lap = 1; lap <= 3; lap++)
      await expect(
        openDbWithSnapshot(base(s, { now: at(lap), opener: dyingAfterM2(s) })),
      ).rejects.toThrow("killed");
    // Each lap put the snapshot back and was killed again; one folder, one copy.
    expect(listSnapshots(s.home)).toHaveLength(1);
    const folders = displaced(s);
    expect(folders).toHaveLength(1);
    const copy = join(preUpdateDir(s.home), folders[0] ?? "", "state", "psyche.sqlite");
    expect(bodies(copy)).toEqual(["keep me", "written by the half-done start"]);
    // Only the first copy (the database and its logs): later laps added nothing.
    const names = readdirSync(join(preUpdateDir(s.home), folders[0] ?? "", "state"));
    expect(names.every((n) => n.startsWith("psyche.sqlite"))).toBe(true);
    expect(names.filter((n) => n === "psyche.sqlite")).toHaveLength(1);
  });
});

describe("a release that ran in between", () => {
  it("does not put a snapshot back over the data an intermediate release wrote", async () => {
    const s = setup();
    await expect(openDbWithSnapshot(base(s, { opener: dyingAfterM2(s) }))).rejects.toThrow(
      "killed",
    );
    const snap = listSnapshots(s.home)[0];
    // An intermediate release that knows only part of the migrations booted successfully
    // afterwards (it records that), and its owner added data.
    writeFileSync(
      join(s.home, "state", "last-boot.json"),
      JSON.stringify({
        version: "0.4.9",
        build: "build-mid",
        goodSeq: (snap?.manifest.seq ?? 0) + 1,
      }),
    );
    const d = new DatabaseSync(s.dbPath);
    d.prepare("INSERT INTO notes (body) VALUES ('written by the intermediate release')").run();
    d.close();
    await expect(
      openDbWithSnapshot(base(s, { now: at(5), opener: dyingAfterM2(s) })),
    ).rejects.toThrow("killed");
    // Nothing was displaced, and the intermediate release's data is intact.
    expect(readdirSync(preUpdateDir(s.home)).filter((n) => n.startsWith(".displaced-"))).toEqual(
      [],
    );
    expect(bodies(s.dbPath)).toContain("written by the intermediate release");
    expect(listSnapshots(s.home)).toHaveLength(2);
    expect(readFileSync(join(s.home, "state", "last-boot.json"), "utf8")).toContain("build-mid");
  });

  it("warns, naming the folder, when a restore moves anything aside", async () => {
    const s = setup();
    await expect(openDbWithSnapshot(base(s, { opener: dyingAfterM2(s) }))).rejects.toThrow(
      "killed",
    );
    const lines: string[] = [];
    await expect(
      openDbWithSnapshot(
        base(s, {
          now: at(2),
          opener: dyingAfterM2(s),
          logger: {
            log: (level: string, msg: string, f?: Record<string, unknown>) =>
              lines.push(`${level} ${msg} ${JSON.stringify(f)}`),
          },
        }),
      ),
    ).rejects.toThrow("killed");
    expect(lines.find((l) => l.startsWith("warn a restore moved files aside"))).toContain(
      ".displaced-",
    );
  });
});
