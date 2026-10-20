import {
  AUDIT_GENESIS_HASH,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLog,
  type AuditVerification,
  type Clock,
  type JsonObject,
  PsycheError,
} from "@psyche/protocol";
import { canonicalJSON, sha256 } from "./canonical.ts";
import { AUDIT_KIND_PATTERN } from "./events.ts";
import { redactForAudit } from "./redact.ts";
import { type AuditAnchor, type AuditStore, FileAuditStore, MemoryAuditStore } from "./store.ts";

/** Hash of an entry (security §15.1): canonical JSON of everything except `hash`, incl. `prev`. */
export function auditEntryHash(entry: Omit<AuditEntry, "hash"> | AuditEntry): string {
  const { hash: _ignored, ...rest } = entry as AuditEntry;
  return sha256(canonicalJSON(rest));
}

export const ANCHOR_EVERY = 1000;

export function anchorMessage(seq: number, hash: string): string {
  return `psyche.audit.anchor.v1|${seq}|${hash}`;
}

/** Signs anchors: the mac helper's Secure Enclave key, or the server's device key. */
export interface AnchorSigner {
  readonly keyId: string;
  sign(message: string): string | Promise<string>;
  /**
   * Called after each anchor is stored: the signer's own record of the last anchored entry,
   * kept outside the audit directory, so cutting the log and its anchors together is detected.
   */
  anchored?(anchor: AuditAnchor): void;
}

export interface AnchorVerifier {
  verify(keyId: string, message: string, signature: string): boolean | Promise<boolean>;
  /**
   * The first entry seq whose anchors must carry a verified signature: when signing was
   * enrolled. Earlier anchors (an older key, or none) are checked against the chain only.
   * Absent: every anchor boundary from seq 0.
   */
  signingSinceSeq?(): number | undefined;
  /** The last anchor the signer recorded outside the audit directory. */
  head?(): { seq: number; hash: string } | undefined;
}

export interface AuditQuery {
  kind?: string;
  kinds?: readonly string[];
  /** `approval.` matches every approval kind. */
  kindPrefix?: string;
  actorType?: AuditEntry["actor"]["type"];
  deviceId?: string;
  runId?: string;
  /** Exact matches on `subject` fields, e.g. `{ taskId }`, `{ approvalId }`. */
  subject?: Record<string, string>;
  /** ISO-8601, inclusive. */
  since?: string;
  /** ISO-8601, exclusive. */
  until?: string;
  sinceSeq?: number;
  untilSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
}

export type DetailedVerification =
  | {
      ok: true;
      count: number;
      anchors: number;
      lastHash: string;
      /** Anchors whose signature verified (only with a verifier). */
      signedAnchors?: number;
      anchorKeyIds?: string[];
      signingSinceSeq?: number;
    }
  | {
      ok: false;
      brokenAtSeq: number;
      reason:
        | "hash_mismatch"
        | "prev_mismatch"
        | "seq_gap"
        | "unparsable"
        | "truncated"
        | "anchor_mismatch"
        | "anchor_missing"
        | "anchor_signature";
      file?: string;
      line?: number;
    };

export type AuditListener = (entry: AuditEntry) => void;

export interface AuditLogOptions {
  /** Defaults to an in-memory store, or a `FileAuditStore` when `dir` is given. */
  store?: AuditStore;
  /** `$PSYCHE_HOME/audit`. */
  dir?: string;
  clock?: Clock;
  /** Extra string redactor, typically `CredentialBroker.redact`. */
  redact?: (text: string) => string;
  /** Refuse kinds that are not dotted lowercase names (the contract allows any; default false). */
  validateKinds?: boolean;
  signer?: AnchorSigner;
  verifier?: AnchorVerifier;
  anchorEvery?: number;
  /**
   * Also anchor an entry when the last anchor is older than this (ms), so a quiet log's recent
   * tail is covered too. Off by default; boundaries every `anchorEvery` entries always anchor.
   */
  anchorIntervalMs?: number;
}

const systemClock: Clock = { now: () => Date.now() };

/**
 * The audit log (architecture §4.12, data model §5, security §15.1): append-only JSONL, hash
 * chained, redacted before hashing so the chain never commits to a secret or a body.
 */
export class HashChainAuditLog implements AuditLog {
  readonly store: AuditStore;
  readonly #clock: Clock;
  readonly #redact: ((text: string) => string) | undefined;
  readonly #validateKinds: boolean;
  readonly #signer: AnchorSigner | undefined;
  readonly #verifier: AnchorVerifier | undefined;
  readonly #anchorEvery: number;
  readonly #anchorIntervalMs: number | undefined;
  #lastAnchorMs: number | undefined;
  readonly #listeners = new Set<AuditListener>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AuditLogOptions = {}) {
    this.store =
      options.store ??
      (options.dir === undefined ? new MemoryAuditStore() : new FileAuditStore(options.dir));
    this.#clock = options.clock ?? systemClock;
    this.#redact = options.redact;
    this.#validateKinds = options.validateKinds ?? false;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#anchorEvery = options.anchorEvery ?? ANCHOR_EVERY;
    this.#anchorIntervalMs = options.anchorIntervalMs;
  }

  #lastAnchorAt(): number {
    if (this.#lastAnchorMs === undefined) {
      let last = Number.NEGATIVE_INFINITY;
      for (const a of this.store.anchors()) last = Math.max(last, Date.parse(a.ts));
      this.#lastAnchorMs = last;
    }
    return this.#lastAnchorMs;
  }

  #dueForAnchor(entry: AuditEntry): boolean {
    if ((entry.seq + 1) % this.#anchorEvery === 0) return true;
    if (this.#anchorIntervalMs === undefined) return false;
    return Date.parse(entry.ts) - this.#lastAnchorAt() >= this.#anchorIntervalMs;
  }

  /** Appends are serialized so `seq` and `prev` never race, even with an async signer. */
  append(input: AuditEntryInput): Promise<AuditEntry> {
    const run = this.#queue.then(() => this.#append(input));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #append(input: AuditEntryInput): Promise<AuditEntry> {
    if (this.#validateKinds && !AUDIT_KIND_PATTERN.test(input.kind)) {
      throw new PsycheError("invalid_params", `audit kind "${input.kind}" is not a dotted name`);
    }
    const tail = this.store.tail();
    const now = this.#clock.now();
    // Never let ts run backwards: month files are read in name order.
    const tsMs = tail === undefined ? now : Math.max(now, Date.parse(tail.ts));
    const opts = this.#redact === undefined ? {} : { redact: this.#redact };
    const base: Omit<AuditEntry, "hash"> = {
      seq: tail === undefined ? 0 : tail.seq + 1,
      ts: new Date(tsMs).toISOString(),
      kind: input.kind,
      actor: redactForAudit(structuredClone(input.actor), opts),
      data: redactForAudit(structuredClone(input.data), opts) as JsonObject,
      prev: tail?.hash ?? AUDIT_GENESIS_HASH,
    };
    if (input.subject !== undefined) {
      base.subject = redactForAudit(structuredClone(input.subject), opts) as JsonObject;
    }
    const entry: AuditEntry = { ...base, hash: auditEntryHash(base) };
    this.store.append(entry);
    if (this.#signer !== undefined && this.#dueForAnchor(entry)) {
      const signature = await this.#signer.sign(anchorMessage(entry.seq, entry.hash));
      const anchor: AuditAnchor = {
        seq: entry.seq,
        hash: entry.hash,
        ts: entry.ts,
        keyId: this.#signer.keyId,
        signature,
      };
      this.store.appendAnchor(anchor);
      this.#lastAnchorMs = Date.parse(entry.ts);
      this.#signer.anchored?.(anchor);
    }
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(entry));
      } catch {
        // A failing subscriber never blocks the log.
      }
    }
    return structuredClone(entry);
  }

  subscribe(listener: AuditListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async list(
    filter: { kind?: string; sinceSeq?: number; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    return this.query(filter);
  }

  async query(q: AuditQuery = {}): Promise<AuditEntry[]> {
    await this.#queue;
    const kinds = q.kinds === undefined ? undefined : new Set(q.kinds);
    const since = q.since === undefined ? undefined : Date.parse(q.since);
    const until = q.until === undefined ? undefined : Date.parse(q.until);
    const out: AuditEntry[] = [];
    for (const line of this.store.entries()) {
      if (!line.ok) continue;
      const e = line.entry;
      if (q.kind !== undefined && e.kind !== q.kind) continue;
      if (kinds !== undefined && !kinds.has(e.kind)) continue;
      if (q.kindPrefix !== undefined && !e.kind.startsWith(q.kindPrefix)) continue;
      if (q.actorType !== undefined && e.actor.type !== q.actorType) continue;
      if (q.deviceId !== undefined && e.actor.deviceId !== q.deviceId) continue;
      if (q.runId !== undefined && e.actor.runId !== q.runId) continue;
      if (q.sinceSeq !== undefined && e.seq < q.sinceSeq) continue;
      if (q.untilSeq !== undefined && e.seq >= q.untilSeq) continue;
      const ts = Date.parse(e.ts);
      if (since !== undefined && ts < since) continue;
      if (until !== undefined && ts >= until) continue;
      if (q.subject !== undefined) {
        const subject = e.subject ?? {};
        const miss = Object.entries(q.subject).some(([k, v]) => subject[k] !== v);
        if (miss) continue;
      }
      out.push(e);
    }
    if (q.order === "desc") out.reverse();
    return out.slice(0, q.limit ?? Number.POSITIVE_INFINITY);
  }

  /** JSON Lines (one entry per line, as stored) or a JSON array; filters as in `query`. */
  async export(q: AuditQuery & { format?: "jsonl" | "json" } = {}): Promise<string> {
    const { format = "jsonl", ...filter } = q;
    const entries = await this.query(filter);
    if (format === "json") return `${JSON.stringify(entries, null, 2)}\n`;
    return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
  }

  async verify(): Promise<AuditVerification> {
    const r = await this.verifyDetailed();
    if (r.ok) return { ok: true, count: r.count };
    const reason =
      r.reason === "prev_mismatch" || r.reason === "seq_gap"
        ? r.reason
        : r.reason === "truncated"
          ? "seq_gap"
          : "hash_mismatch";
    return { ok: false, brokenAtSeq: r.brokenAtSeq, reason };
  }

  /** `psyche audit verify`: chain integrity, then anchors (truncation and signatures). */
  async verifyDetailed(): Promise<DetailedVerification> {
    await this.#queue;
    let prev = AUDIT_GENESIS_HASH;
    let expected = 0;
    const hashes = new Map<number, string>();
    for (const line of this.store.entries()) {
      const where = {
        ...(line.file === undefined ? {} : { file: line.file }),
        ...(line.line === undefined ? {} : { line: line.line }),
      };
      if (!line.ok) return { ok: false, brokenAtSeq: expected, reason: "unparsable", ...where };
      const e = line.entry;
      if (e.seq !== expected) {
        return { ok: false, brokenAtSeq: expected, reason: "seq_gap", ...where };
      }
      if (e.prev !== prev)
        return { ok: false, brokenAtSeq: e.seq, reason: "prev_mismatch", ...where };
      let recomputed: string;
      try {
        recomputed = auditEntryHash(e);
      } catch {
        return { ok: false, brokenAtSeq: e.seq, reason: "hash_mismatch", ...where };
      }
      if (recomputed !== e.hash) {
        return { ok: false, brokenAtSeq: e.seq, reason: "hash_mismatch", ...where };
      }
      hashes.set(e.seq, e.hash);
      prev = e.hash;
      expected += 1;
    }
    let anchors = 0;
    let signedAnchors = 0;
    const keyIds = new Set<string>();
    const anchorList = [...this.store.anchors()];
    const since = this.#verifier?.signingSinceSeq?.() ?? 0;
    if (this.#verifier !== undefined || this.#signer !== undefined) {
      // Every boundary must carry an anchor, or deleting anchors.jsonl hides a truncation.
      const have = new Set(anchorList.map((a) => a.seq));
      const first = Math.ceil((since + 1) / this.#anchorEvery) * this.#anchorEvery - 1;
      for (let seq = first; seq < expected; seq += this.#anchorEvery) {
        if (!have.has(seq)) return { ok: false, brokenAtSeq: seq, reason: "anchor_missing" };
      }
    }
    // The signer's own record of its last anchor, kept outside the audit directory: cutting the
    // tail together with the anchors past the cut no longer looks like a shorter log.
    const head = this.#verifier?.head?.();
    if (head !== undefined) {
      const h = hashes.get(head.seq);
      if (h === undefined) return { ok: false, brokenAtSeq: expected, reason: "truncated" };
      if (h !== head.hash) return { ok: false, brokenAtSeq: head.seq, reason: "anchor_mismatch" };
    }
    for (const a of anchorList) {
      const h = hashes.get(a.seq);
      if (h === undefined) return { ok: false, brokenAtSeq: expected, reason: "truncated" };
      if (h !== a.hash) return { ok: false, brokenAtSeq: a.seq, reason: "anchor_mismatch" };
      if (this.#verifier !== undefined && a.seq >= since) {
        const valid = await this.#verifier.verify(
          a.keyId,
          anchorMessage(a.seq, a.hash),
          a.signature,
        );
        if (!valid) return { ok: false, brokenAtSeq: a.seq, reason: "anchor_signature" };
        signedAnchors += 1;
        keyIds.add(a.keyId);
      }
      anchors += 1;
    }
    if (this.#verifier === undefined) return { ok: true, count: expected, anchors, lastHash: prev };
    return {
      ok: true,
      count: expected,
      anchors,
      lastHash: prev,
      signedAnchors,
      anchorKeyIds: [...keyIds].sort(),
      signingSinceSeq: since,
    };
  }
}

export function createAuditLog(options: AuditLogOptions = {}): HashChainAuditLog {
  return new HashChainAuditLog(options);
}
