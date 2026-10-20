import type { ThreadState, ThreadStateStore } from "@psyche/agent-core";
import { getAgentThreadState, type PsycheDb, putAgentThreadState } from "@psyche/db";

/** Masks registered secret values in every string of a JSON value (`SecretRedactor.redact`). */
export interface StringMasker {
  redact(text: string): string;
}

function maskDeep(value: unknown, masker: StringMasker): unknown {
  if (typeof value === "string") return masker.redact(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, masker));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v, masker)]),
    );
  }
  return value;
}

/**
 * Durable `ThreadStateStore` over the Gateway database (issue #52): the loop's model-side history
 * (provider-native messages after compaction, summary, pinned checklist, carried taint) survives a
 * restart. The loop only ever holds `{{cred:…}}` placeholders; as defense in depth every string is
 * passed through the vault's redactor before it is written, so a resolved secret never lands on
 * disk even if one slipped into a tool result.
 */
export class SqliteThreadStateStore implements ThreadStateStore {
  readonly #db: PsycheDb;
  readonly #masker: StringMasker | null;

  constructor(db: PsycheDb, masker: StringMasker | null = null) {
    this.#db = db;
    this.#masker = masker;
  }

  async load(threadId: string): Promise<ThreadState | undefined> {
    return getAgentThreadState(this.#db, threadId) as ThreadState | undefined;
  }

  async save(threadId: string, state: ThreadState): Promise<void> {
    const safe = this.#masker === null ? state : (maskDeep(state, this.#masker) as ThreadState);
    putAgentThreadState(this.#db, threadId, safe as unknown as Record<string, unknown>);
  }
}
