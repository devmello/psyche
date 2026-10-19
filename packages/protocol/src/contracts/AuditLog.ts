import type { JsonObject } from "../common.ts";
import type { AuditEntry } from "../schemas/permissions.ts";

/**
 * Audit log contract (architecture §4.12; data model §5; security §15.1; owner S05).
 * Append-only and hash-chained: `hash = "sha256:" + hex(sha256(canonicalJSON(entry without
 * hash)))`, where canonical JSON has sorted keys and no insignificant whitespace (security
 * §3.5); `prev` is the previous entry's hash, `AUDIT_GENESIS_HASH` for the first entry.
 * Tool results are logged as sizes and hashes only; no secret or message body enters the log.
 */

export const AUDIT_GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export interface AuditEntryInput {
  kind: string;
  actor: AuditEntry["actor"];
  subject?: JsonObject;
  data: JsonObject;
}

export type AuditVerification =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number; reason: "hash_mismatch" | "prev_mismatch" | "seq_gap" };

export interface AuditLog {
  append(input: AuditEntryInput): Promise<AuditEntry>;
  list(filter?: { kind?: string; sinceSeq?: number; limit?: number }): Promise<AuditEntry[]>;
  verify(): Promise<AuditVerification>;
}
