import type { SkillSource, SkillTrust } from "@psyche/protocol";
import type Database from "better-sqlite3";

/** One row of the `skills` table (data model §10). */
export interface SkillStateRecord {
  name: string;
  source: SkillSource;
  path: string;
  trust: SkillTrust;
  /** The owner's switch; effective enablement also needs gating and trust checks. */
  enabled: boolean;
  hash?: string;
  version?: string;
  /** ISO-8601. */
  installedAt?: string;
}

export interface SkillStateStore {
  get(source: SkillSource, name: string): SkillStateRecord | undefined;
  /** Inserts or updates by (source, name); keeps `enabled` unless given. */
  upsert(record: SkillStateRecord): void;
  delete(source: SkillSource, name: string): void;
  list(): SkillStateRecord[];
}

export class MemorySkillStateStore implements SkillStateStore {
  #rows = new Map<string, SkillStateRecord>();

  get(source: SkillSource, name: string): SkillStateRecord | undefined {
    const r = this.#rows.get(`${source}:${name}`);
    return r === undefined ? undefined : { ...r };
  }

  upsert(record: SkillStateRecord): void {
    this.#rows.set(`${record.source}:${record.name}`, { ...record });
  }

  delete(source: SkillSource, name: string): void {
    this.#rows.delete(`${source}:${name}`);
  }

  list(): SkillStateRecord[] {
    return [...this.#rows.values()].map((r) => ({ ...r }));
  }
}

interface Row {
  id: string;
  name: string;
  source: SkillSource;
  version: string | null;
  path: string;
  hash: string | null;
  trust: SkillTrust;
  enabled: number;
  installed_at: string | null;
}

function fromRow(r: Row): SkillStateRecord {
  const rec: SkillStateRecord = {
    name: r.name,
    source: r.source,
    path: r.path,
    trust: r.trust,
    enabled: r.enabled === 1,
  };
  if (r.hash !== null) rec.hash = r.hash;
  if (r.version !== null) rec.version = r.version;
  if (r.installed_at !== null) rec.installedAt = r.installed_at;
  return rec;
}

/** `skills` table store over the Gateway database (`@psyche/db` migrations create the table). */
export class SqliteSkillStateStore implements SkillStateStore {
  #db: Database.Database;
  #now: () => string;
  #newId: () => string;

  constructor(db: Database.Database, opts: { now?: () => string; newId?: () => string } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
  }

  get(source: SkillSource, name: string): SkillStateRecord | undefined {
    const r = this.#db
      .prepare("SELECT * FROM skills WHERE source = ? AND name = ?")
      .get(source, name) as Row | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  upsert(rec: SkillStateRecord): void {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO skills (id, name, source, version, path, hash, trust, enabled, installed_at, created_at, updated_at)
         VALUES (@id, @name, @source, @version, @path, @hash, @trust, @enabled, @installed_at, @now, @now)
         ON CONFLICT (source, name) DO UPDATE SET version = excluded.version, path = excluded.path,
           hash = excluded.hash, trust = excluded.trust, enabled = excluded.enabled,
           installed_at = excluded.installed_at, updated_at = excluded.updated_at`,
      )
      .run({
        id: this.#newId(),
        name: rec.name,
        source: rec.source,
        version: rec.version ?? null,
        path: rec.path,
        hash: rec.hash ?? null,
        trust: rec.trust,
        enabled: rec.enabled ? 1 : 0,
        installed_at: rec.installedAt ?? null,
        now,
      });
  }

  delete(source: SkillSource, name: string): void {
    this.#db.prepare("DELETE FROM skills WHERE source = ? AND name = ?").run(source, name);
  }

  list(): SkillStateRecord[] {
    return (this.#db.prepare("SELECT * FROM skills ORDER BY name, source").all() as Row[]).map(
      fromRow,
    );
  }
}
