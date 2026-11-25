import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, rollbackMemoryTrustLeak, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611250900_memory_trust-leak.sql";
const T = "2026-10-20T00:00:00.000Z";

describe("202611250900 memory trust leak", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function seeded(): { sqlite: Database.Database; migrate: () => void } {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const old = join(dir, "before");
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW)
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, { dir: old });
    sqlite
      .prepare(
        "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('e1','person','Sam','sam',?,?)",
      )
      .run(T, T);
    const fact = (
      id: string,
      attribute: string,
      value: string,
      provenance: string,
      review = "accepted",
      extractor: string | null = null,
    ) =>
      sqlite
        .prepare(
          `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from,
             recorded_at, created_at, updated_at, review, extractor) VALUES (?,?,?,?,?,0.5,?,?,?,?,?,?)`,
        )
        .run(id, "e1", attribute, value, provenance, T, T, T, T, review, extractor);
    // Leaked: untrusted, accepted, uncited, no extractor.
    fact("leak1", "city", "Berlin", "untrusted");
    fact("leak2", "employer", "Initech", "untrusted");
    // Not leaked.
    fact("owner1", "role", "Founder", "owner");
    fact("system1", "team", "Core", "system");
    fact("agent1", "timezone", "CET", "agent");
    fact("em1", "school", "MIT", "untrusted", "accepted", "em-extractor-1");
    fact("pend1", "diet", "vegan", "untrusted", "pending");
    fact("edit1", "pronouns", "he", "agent", "edited");
    // Cited: has a citation row, so it stays.
    fact("cited1", "hometown", "Ulm", "untrusted");
    sqlite
      .prepare(
        `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end",
           source_hash, provenance, observed_at, created_at) VALUES ('c1','fact','cited1','mail','<m>','q',0,1,'h','untrusted',?,?)`,
      )
      .run(T, T);
    // A leaked row that replaced an agent value: the agent value comes back.
    fact("agentOld", "likes", "tea", "agent");
    fact("leak3", "likes", "coffee", "untrusted");
    sqlite
      .prepare("UPDATE graph_facts SET superseded_by = 'leak3', valid_to = ? WHERE id = 'agentOld'")
      .run(T);
    return {
      sqlite,
      migrate: () => {
        runMigrations(sqlite, { dir: DEFAULT_MIGRATIONS_DIR });
      },
    };
  }

  const reviews = (sqlite: Database.Database) =>
    Object.fromEntries(
      (
        sqlite.prepare("SELECT id, review FROM graph_facts").all() as {
          id: string;
          review: string;
        }[]
      ).map((r) => [r.id, r.review]),
    );
  const count = (sqlite: Database.Database, where: string) =>
    (sqlite.prepare(`SELECT count(*) AS n FROM graph_facts WHERE ${where}`).get() as { n: number })
      .n;
  const leakWhere =
    "provenance = 'untrusted' AND review = 'accepted' AND extractor IS NULL AND superseded_by IS NULL AND id NOT IN (SELECT target_id FROM graph_citations)";

  it("moves only the leaked rows to pending, keeps a backup, and rolls back", () => {
    const { sqlite, migrate } = seeded();
    expect(count(sqlite, leakWhere)).toBe(3);
    const before = reviews(sqlite);

    migrate();

    expect(count(sqlite, leakWhere)).toBe(0);
    const after = reviews(sqlite);
    expect(after.leak1).toBe("pending");
    expect(after.leak2).toBe("pending");
    expect(after.leak3).toBe("pending");
    // Everything else is untouched.
    for (const id of ["owner1", "system1", "agent1", "em1", "pend1", "edit1", "cited1", "agentOld"])
      expect(after[id]).toBe(before[id]);
    expect(count(sqlite, "review = 'pending'")).toBe(4);
    expect(
      (
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM memory_migration_backup_2026_11 WHERE id NOT LIKE 'applied:%'",
          )
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(3);
    // The pending rows age out under retention (last_seen_at set to now), and the agent value is current again.
    expect(count(sqlite, "id IN ('leak1','leak2','leak3') AND last_seen_at IS NOT NULL")).toBe(3);
    expect(
      sqlite.prepare("SELECT superseded_by FROM graph_facts WHERE id = 'agentOld'").get(),
    ).toEqual({
      superseded_by: null,
    });

    // Down.
    expect(rollbackMemoryTrustLeak(sqlite)).toBe(3);
    expect(reviews(sqlite)).toEqual(before);
    expect(count(sqlite, leakWhere)).toBe(3);
    expect(
      sqlite.prepare("SELECT superseded_by FROM graph_facts WHERE id = 'agentOld'").get(),
    ).toEqual({
      superseded_by: "leak3",
    });
    expect(count(sqlite, "id IN ('leak1','leak2','leak3') AND last_seen_at IS NOT NULL")).toBe(0);
    // Rolling back twice changes nothing.
    expect(rollbackMemoryTrustLeak(sqlite)).toBe(0);
  });

  it("is idempotent when its statements run again", () => {
    const { sqlite, migrate } = seeded();
    migrate();
    const once = reviews(sqlite);
    sqlite.exec(readFileSync(join(DEFAULT_MIGRATIONS_DIR, NEW), "utf8"));
    expect(reviews(sqlite)).toEqual(once);
    expect(
      (
        sqlite
          .prepare(
            "SELECT count(*) AS n FROM memory_migration_backup_2026_11 WHERE id NOT LIKE 'applied:%'",
          )
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(3);
  });

  it("rollback keeps a decision the owner made after the migration", () => {
    const { sqlite, migrate } = seeded();
    migrate();
    sqlite.prepare("UPDATE graph_facts SET review = 'discarded' WHERE id = 'leak1'").run();
    sqlite.prepare("UPDATE graph_facts SET review = 'accepted' WHERE id = 'leak2'").run();
    expect(rollbackMemoryTrustLeak(sqlite)).toBe(1);
    expect(reviews(sqlite).leak1).toBe("discarded");
    expect(reviews(sqlite).leak2).toBe("accepted");
  });

  /** A fact row added by hand; `superseded_by` is set after, so order does not matter. */
  const addFact = (
    sqlite: Database.Database,
    id: string,
    attribute: string,
    value: string,
    provenance: string,
    supersededBy: string | null = null,
  ) => {
    sqlite
      .prepare(
        `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from,
           recorded_at, created_at, updated_at, review) VALUES (?, 'e1', ?, ?, ?, 0.5, ?, ?, ?, ?, 'accepted')`,
      )
      .run(id, attribute, value, provenance, T, T, T, T);
    if (supersededBy !== null)
      sqlite
        .prepare("UPDATE graph_facts SET superseded_by = ?, valid_to = ? WHERE id = ?")
        .run(supersededBy, T, id);
  };
  const current = (sqlite: Database.Database, attribute: string) =>
    (
      sqlite
        .prepare(
          "SELECT value FROM graph_facts WHERE entity_id = 'e1' AND attribute = ? AND superseded_by IS NULL AND retracted_at IS NULL AND review IN ('accepted','auto_accepted','edited') ORDER BY value",
        )
        .all(attribute) as { value: string }[]
    ).map((r) => r.value);

  it("walks a chain of leaks back to the newest trusted value", () => {
    const { sqlite, migrate } = seeded();
    // Acme (agent) <- u1 (untrusted) <- u2 (untrusted, current); only u2 moves.
    addFact(sqlite, "u2", "term", "Spring", "untrusted");
    addFact(sqlite, "u1", "term", "Summer", "untrusted", "u2");
    addFact(sqlite, "acme", "term", "Fall", "agent", "u1");
    // A retracted trusted value further back is not chosen.
    sqlite.prepare("UPDATE graph_facts SET retracted_at = ? WHERE id = 'acme'").run(T);
    addFact(sqlite, "older", "term", "Winter", "agent", "acme");
    expect(current(sqlite, "term")).toEqual(["Spring"]);
    migrate();
    expect(current(sqlite, "term")).toEqual(["Winter"]);
    expect(reviews(sqlite).u2).toBe("pending");
    expect(rollbackMemoryTrustLeak(sqlite)).toBe(4);
    expect(current(sqlite, "term")).toEqual(["Spring"]);
  });

  it("rollback after a newer owner write leaves one current value, the owner's", () => {
    const { sqlite, migrate } = seeded();
    addFact(sqlite, "u1", "term", "Spring", "untrusted");
    addFact(sqlite, "acme", "term", "Fall", "agent", "u1");
    migrate();
    expect(current(sqlite, "term")).toEqual(["Fall"]);
    // The owner sets a new value after the migration; it replaces the restored one.
    addFact(sqlite, "globex", "term", "Globex", "owner");
    sqlite.prepare("UPDATE graph_facts SET superseded_by = 'globex' WHERE id = 'acme'").run();
    expect(rollbackMemoryTrustLeak(sqlite)).toBe(3);
    expect(current(sqlite, "term")).toEqual(["Globex"]);
    expect(reviews(sqlite).u1).toBe("pending");
  });

  it("rollback keeps a leaked value pending when the owner has since set another", () => {
    const { sqlite, migrate } = seeded();
    migrate();
    addFact(sqlite, "paris", "city", "Paris", "owner");
    rollbackMemoryTrustLeak(sqlite);
    expect(reviews(sqlite).leak1).toBe("pending");
    expect(current(sqlite, "city")).toEqual(["Paris"]);
  });

  it("rollback without the backup table is a no-op", () => {
    const db = new Database(":memory:");
    expect(rollbackMemoryTrustLeak(db)).toBe(0);
  });
});
