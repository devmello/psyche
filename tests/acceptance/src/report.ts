import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in tests/acceptance/src). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where the acceptance runs leave their machine-readable results (git-ignored). */
export const OUT_DIR = join(ROOT, "out/acceptance");

/** Writes `out/acceptance/<name>.json`: no timestamps, stable key order from the caller. */
export function writeReport(name: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

/** Median of a sample, for timings that CI noise should not turn into flakes. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
