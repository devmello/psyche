/**
 * Audit event vocabulary (data model §5), plus the kinds the Permission Broker writes for the
 * decision trail (`tool_call.decided`, approval lifecycle, grant ledger, binding checks). Other
 * packages may append their own dotted kinds; `isKnownAuditKind` is for viewers and tests.
 */
export const DATA_MODEL_AUDIT_KINDS = [
  "device.paired",
  "device.revoked",
  "thread.created",
  "tool_call.decided",
  "tool_call.finished",
  "approval.created",
  "approval.decided",
  "approval.expired",
  "grant.created",
  "grant.used",
  "grant.revoked",
  "credential.filled",
  "credential.created",
  "credential.deleted",
  "purchase.requested",
  "purchase.completed",
  "message.sent",
  "email.sent",
  "calendar.changed",
  "file.written",
  "exec.finished",
  "memory.written",
  "memory.forgotten",
  "connector.connected",
  "connector.disconnected",
  "channel.sender.paired",
  "skill.installed",
  "config.changed",
  "vault.unlocked",
  "export.created",
  "reset.performed",
] as const;

/** Kinds added by S05 (listed in data model §5 by this change). */
export const PERMISSION_AUDIT_KINDS = [
  "approval.invalidated",
  "approval.answer_rejected",
  "binding.verified",
  "binding.mismatch",
  "classifier.labeled",
  "classifier.circuit_open",
  "receipt.recorded",
  "receipt.reconciled",
  "audit.anchored",
  "revocations.replayed",
] as const;

export const AUDIT_KINDS = [...DATA_MODEL_AUDIT_KINDS, ...PERMISSION_AUDIT_KINDS] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

const KNOWN = new Set<string>(AUDIT_KINDS);

export function isKnownAuditKind(kind: string): kind is AuditKind {
  return KNOWN.has(kind);
}

/** `<segment>(.<segment>)+`, lowercase with `_`. */
export const AUDIT_KIND_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
