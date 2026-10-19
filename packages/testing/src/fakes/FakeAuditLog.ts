import {
  AUDIT_GENESIS_HASH,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLog,
  type AuditVerification,
  type Clock,
} from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../canonical.ts";
import { captureModelVisible } from "../capture.ts";
import { FakeClock, toIso } from "../clock.ts";

/** Hash of an entry per security §15.1: canonical JSON of everything except `hash`. */
export function auditEntryHash(entry: Omit<AuditEntry, "hash">): string {
  const { hash: _ignored, ...rest } = entry as AuditEntry;
  return sha256(canonicalJSON(rest));
}

/** In-memory hash-chained audit log with a real sha256 chain (node:crypto). */
export class FakeAuditLog implements AuditLog {
  readonly clock: Clock;
  #entries: AuditEntry[] = [];

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? new FakeClock();
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    const prev = this.#entries[this.#entries.length - 1]?.hash ?? AUDIT_GENESIS_HASH;
    const base: Omit<AuditEntry, "hash"> = {
      seq: this.#entries.length,
      ts: toIso(this.clock.now()),
      kind: input.kind,
      actor: structuredClone(input.actor),
      data: structuredClone(input.data),
      prev,
    };
    if (input.subject !== undefined) base.subject = structuredClone(input.subject);
    const entry: AuditEntry = { ...base, hash: auditEntryHash(base) };
    captureModelVisible("audit", entry, { where: "FakeAuditLog.append" });
    this.#entries.push(entry);
    return structuredClone(entry);
  }

  async list(
    filter: { kind?: string; sinceSeq?: number; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    return this.#entries
      .filter((e) => filter.kind === undefined || e.kind === filter.kind)
      .filter((e) => filter.sinceSeq === undefined || e.seq >= filter.sinceSeq)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((e) => structuredClone(e));
  }

  async verify(): Promise<AuditVerification> {
    let prev = AUDIT_GENESIS_HASH;
    for (const [i, e] of this.#entries.entries()) {
      if (e.seq !== i) return { ok: false, brokenAtSeq: e.seq, reason: "seq_gap" };
      if (e.prev !== prev) return { ok: false, brokenAtSeq: e.seq, reason: "prev_mismatch" };
      if (auditEntryHash(e) !== e.hash)
        return { ok: false, brokenAtSeq: e.seq, reason: "hash_mismatch" };
      prev = e.hash;
    }
    return { ok: true, count: this.#entries.length };
  }

  /** Test hook: mutate a stored entry in place to prove `verify` catches tampering. */
  tamper(seq: number, mutate: (entry: AuditEntry) => void): void {
    const e = this.#entries[seq];
    if (e !== undefined) mutate(e);
  }
}
