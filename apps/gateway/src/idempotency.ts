import { createHash } from "node:crypto";
import {
  getIdempotencyRecord,
  type IdempotencyKeyRef,
  type PsycheDb,
  putIdempotencyRecord,
} from "@psyche/db";
import { PsycheError } from "@psyche/protocol";

/** Stable hash of request params for idempotency comparison (key order independent). */
export function paramsHash(params: unknown): string {
  return createHash("sha256")
    .update(stableJson(params ?? null))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Persisted idempotency (feature A2): results of side-effecting requests live in
 * `gateway_idempotency`, keyed by device + method + key, and survive restarts. Concurrent
 * duplicates share one in-flight promise, so a retried key never runs twice.
 */
export class Idempotency {
  readonly #db: PsycheDb;
  readonly #inflight = new Map<string, { hash: string; promise: Promise<unknown> }>();

  constructor(db: PsycheDb) {
    this.#db = db;
  }

  /** The stored result for `ref`, `undefined` when unseen; throws on a params mismatch. */
  lookup(ref: IdempotencyKeyRef, hash: string): { result: unknown } | undefined {
    const prior = getIdempotencyRecord(this.#db, ref);
    if (prior === undefined) return undefined;
    if (prior.paramsHash !== hash) {
      throw new PsycheError(
        "idempotency_conflict",
        "idempotencyKey was used with different params",
      );
    }
    return { result: prior.result };
  }

  /** Call inside the mutation's transaction. */
  store(ref: IdempotencyKeyRef, hash: string, result: unknown): void {
    putIdempotencyRecord(this.#db, ref, hash, result);
  }

  /**
   * Runs `fn` once per key: a stored result is replayed, a concurrent duplicate awaits the
   * first call. `fn` stores the record itself (transactional handlers) or returns
   * `{ store: true }` semantics through `storeAfter`.
   */
  async run(
    ref: IdempotencyKeyRef,
    hash: string,
    fn: () => Promise<unknown>,
    storeAfter: boolean,
  ): Promise<unknown> {
    const key = `${ref.deviceId}\u0000${ref.method}\u0000${ref.key}`;
    const flying = this.#inflight.get(key);
    if (flying) {
      if (flying.hash !== hash) {
        throw new PsycheError(
          "idempotency_conflict",
          "idempotencyKey was used with different params",
        );
      }
      return flying.promise;
    }
    const prior = this.lookup(ref, hash);
    if (prior) return prior.result;
    const promise = (async () => {
      const result = await fn();
      if (storeAfter) this.store(ref, hash, result);
      return result;
    })();
    this.#inflight.set(key, { hash, promise });
    try {
      return await promise;
    } finally {
      this.#inflight.delete(key);
    }
  }
}
