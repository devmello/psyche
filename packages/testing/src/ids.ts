import { monotonicFactory } from "ulid";

export interface IdGenerator {
  /** Next id; `prefix` overrides the generator's default prefix. */
  next(prefix?: string): string;
  reset(): void;
}

export interface IdGeneratorOptions {
  /** Default prefix for counter ids (`<prefix>_000001`). */
  prefix?: string;
  /** Emit real ULIDs instead of counter ids, deterministic from `seed` and `now`. */
  ulid?: boolean;
  seed?: number;
  now?: () => number;
}

/** mulberry32: a tiny seeded PRNG so ULIDs are reproducible across runs. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic ids for fakes. Counter ids (`apr_000001`) by default; with `ulid: true` real
 * ULIDs (valid against the protocol `Ulid` schema) from a seeded PRNG and the given clock.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const defaultPrefix = options.prefix ?? "id";
  const seed = options.seed ?? 1;
  const now = options.now ?? (() => Date.UTC(2026, 9, 18, 20, 0, 0));
  let counter = 0;
  let factory = monotonicFactory(seededRandom(seed));
  return {
    next(prefix) {
      counter += 1;
      if (options.ulid === true) return factory(now());
      return `${prefix ?? defaultPrefix}_${String(counter).padStart(6, "0")}`;
    },
    reset() {
      counter = 0;
      factory = monotonicFactory(seededRandom(seed));
    },
  };
}
