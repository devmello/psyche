import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { expireScreenFrames, SCREEN_TAG } from "../src/retention.ts";

/** G8: the bounded screen-frame sweep deletes exactly the rows the original query selected. */

const dirs: string[] = [];
const dbs: PsycheDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small seeded generator, so the random table is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BASE = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const TAG_SETS = ['["screen"]', '["screen","pinned"]', '["other"]', "[]", '["notscreen"]'];

function seedLibrary(db: PsycheDb, seed: number, rows: number): void {
  const next = rng(seed);
  const insert = db.sqlite.prepare(
    `INSERT INTO library_items (id, kind, name, mime, path, size, sha256, origin, thread_id, tags, created_at)
     VALUES (?, 'image', 'frame', 'image/jpeg', ?, 1, 'h', 'agent', ?, ?, ?)`,
  );
  for (let i = 0; i < rows; i++) {
    const created = BASE + Math.floor(next() * 30) * 86_400_000 + Math.floor(next() * 86_400_000);
    const thread = next() < 0.5 ? null : `thread-${Math.floor(next() * 4)}`;
    const tags = TAG_SETS[Math.floor(next() * TAG_SETS.length)] ?? "[]";
    insert.run(`item-${i}`, `library/screen/item-${i}.jpg`, thread, tags, iso(created));
  }
}

/** The query `expireScreenFrames` used before G8, kept here as the reference. */
function oldSelection(db: PsycheDb, before: string, unsent: string): string[] {
  return (
    db.sqlite
      .prepare(
        `SELECT id FROM library_items
         WHERE EXISTS (SELECT 1 FROM json_each(library_items.tags) WHERE value = ?)
           AND (created_at < ? OR (thread_id IS NULL AND created_at < ?))
         ORDER BY id`,
      )
      .all(SCREEN_TAG, before, unsent) as { id: string }[]
  ).map((r) => r.id);
}

function freshDb(): { db: PsycheDb; home: string } {
  const db = openDb(":memory:");
  dbs.push(db);
  const home = mkdtempSync(join(tmpdir(), "psyche-retention-sweep-"));
  dirs.push(home);
  return { db, home };
}

describe("expireScreenFrames (G8)", () => {
  const cases: [string, string][] = [
    [iso(BASE + 20 * 86_400_000), iso(BASE + 10 * 86_400_000)], // sent cutoff later
    [iso(BASE + 10 * 86_400_000), iso(BASE + 20 * 86_400_000)], // unsent cutoff later
    [iso(BASE + 15 * 86_400_000), iso(BASE + 15 * 86_400_000)], // equal
    ["", ""], // nothing old enough
    [iso(BASE + 40 * 86_400_000), ""], // everything before the sent cutoff
    ["", iso(BASE + 40 * 86_400_000)], // unsent only
  ];

  for (const [seed, [before, unsent]] of [1, 2, 3, 4].flatMap((s) =>
    cases.map((c, i) => [s * 10 + i, c] as const),
  )) {
    it(`deletes the same rows as the old query (seed ${seed}, before ${before || "-"}, unsent ${unsent || "-"})`, () => {
      const { db, home } = freshDb();
      seedLibrary(db, seed, 120);
      const expected = oldSelection(db, before, unsent);
      const deleted = expireScreenFrames(db, home, before, unsent);
      expect(deleted).toBe(expected.length);
      const left = (
        db.sqlite.prepare("SELECT id FROM library_items ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id);
      const all = Array.from({ length: 120 }, (_, i) => `item-${i}`);
      expect(all.filter((id) => !left.includes(id)).sort()).toEqual(expected);
    });
  }

  it("never touches rows without the screen tag, whatever their age or thread", () => {
    const { db, home } = freshDb();
    db.sqlite
      .prepare(
        `INSERT INTO library_items (id, kind, name, mime, path, size, sha256, origin, thread_id, tags, created_at)
         VALUES ('keep', 'image', 'n', 'image/png', 'library/other/keep.png', 1, 'h', 'agent', NULL, '["other"]', ?)`,
      )
      .run(iso(BASE));
    expireScreenFrames(db, home, iso(BASE + 86_400_000), iso(BASE + 86_400_000));
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM library_items").get()).toEqual({ n: 1 });
  });
});
