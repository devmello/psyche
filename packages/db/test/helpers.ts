import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenDbOptions, openDb, type PsycheDb } from "../src/index.ts";

/** A temp dir under os.tmpdir(); call the returned cleanup in afterEach. */
export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-db-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic clock: 2026-10-18T22:00:00.000Z, advancing 1 ms per call. */
export function fakeClock(start = Date.parse("2026-10-18T22:00:00.000Z")): () => string {
  let t = start;
  return () => new Date(t++).toISOString();
}

export function memoryDb(opts: OpenDbOptions = {}): PsycheDb {
  return openDb(":memory:", { now: fakeClock(), ...opts });
}
