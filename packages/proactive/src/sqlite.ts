/** The slice of better-sqlite3's `Database` this package uses (`@psyche/db`'s `PsycheDb.sqlite`). */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
