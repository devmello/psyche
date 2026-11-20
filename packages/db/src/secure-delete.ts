/** The part of a better-sqlite3 connection the helper needs. */
export interface PragmaConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

/** `PRAGMA secure_delete` reads back 0, 1 or 2 but only takes the keywords OFF, ON and FAST. */
export function secureDeleteKeyword(value: number): "OFF" | "ON" | "FAST" {
  return value === 2 ? "FAST" : value === 1 ? "ON" : "OFF";
}

interface Hold {
  depth: number;
  readonly original: number;
}

/** Per connection: how many overlapping Forgets hold `secure_delete` on, and the setting before. */
const holds = new WeakMap<object, Hold>();

/**
 * Turns `secure_delete` on for a connection and returns the function that gives it back. Holds
 * are counted per connection: the first one sets ON and records the original setting, the last
 * one to be released restores it by keyword, whatever the order, so overlapping Forgets (the trace
 * scrub, the memory Forget, the graph forget) never leave the setting changed. If the pragma
 * cannot be read or set, the returned function does nothing.
 */
export function holdSecureDelete(conn: PragmaConnection): () => void {
  let hold = holds.get(conn);
  if (hold === undefined) {
    try {
      const original = Number(conn.pragma("secure_delete", { simple: true }));
      conn.pragma("secure_delete = ON");
      hold = { depth: 0, original: Number.isInteger(original) ? original : 0 };
      holds.set(conn, hold);
    } catch {
      return () => undefined;
    }
  }
  const mine = hold;
  mine.depth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.depth -= 1;
    if (mine.depth > 0) return;
    holds.delete(conn);
    try {
      conn.pragma(`secure_delete = ${secureDeleteKeyword(mine.original)}`);
    } catch {
      // The connection is closed: nothing to restore.
    }
  };
}

/** Runs `fn` with `secure_delete` on for the connection (see `holdSecureDelete`). */
export function withSecureDeleteOn<T>(conn: PragmaConnection, fn: () => T): T {
  const release = holdSecureDelete(conn);
  try {
    return fn();
  } finally {
    release();
  }
}
