import { needsPresence } from "../handlers/settings.ts";

/**
 * Which rows the security-state seal covers (docs/design/security-state-integrity-2026.md §2,
 * §7.1). Each table lists its sealed columns in a fixed order: the canonical JSON of a row is
 * `json_object()` over exactly these, so a migration that adds a column changes nothing, and a
 * test fails when a sealed table gains a column listed neither here nor in `ignored`.
 *
 * Changing a list changes every row's canonical form: bump `SEAL_FORMAT` and keep the old lists
 * so the next start verifies with them before re-sealing.
 */
export const SEAL_FORMAT = 1;

/** What a row that appeared outside Psyche becomes when the seal is restored. */
export type AddedRowAction =
  | "revoke_device"
  | "revoke_grant"
  | "revoke_setup_token"
  | "invalidate_approval"
  | "delete";

export interface SealedTable {
  readonly table: string;
  /** The primary-key column (one, text). */
  readonly pk: string;
  /** Sealed columns, the primary key included, in canonical order. */
  readonly columns: readonly string[];
  /** Columns stored as BLOB: sealed as hex. */
  readonly blobs?: readonly string[];
  /** Columns that change often and authorize nothing: not sealed (nullable or defaulted). */
  readonly ignored?: readonly string[];
  /** SQL predicate over `<p>.<column>`: only rows it holds for are sealed. */
  readonly where?: (p: string) => string;
  readonly added: AddedRowAction;
  /** The column the owner is shown when a row of this table changed. */
  readonly label: string;
}

/**
 * Gateway-internal settings that authorize something (presence, LAN exposure). The rest of the
 * sealed settings are the security settings that need fresh presence (`needsPresence`).
 */
const INTERNAL_SEALED = new Set(["_presence.enrolled", "_presence.helperKeys", "_lan.networks"]);

/** `mcp.servers` carries each server's trust tier, sandbox and launch command. */
const OTHER_SEALED = new Set(["mcp.servers"]);

/** True for setting keys whose value is security state. */
export function isSealedSettingKey(key: string): boolean {
  return INTERNAL_SEALED.has(key) || OTHER_SEALED.has(key) || needsPresence(key);
}

/** The SQL function the settings predicate calls (registered on the Gateway's connection). */
export const SEALED_SETTING_FN = "psyche_sealed_setting";

/**
 * In dependency order: a parent is restored before the rows that reference it (a passkey needs
 * its device). The security_* tables come last.
 */
export const SEALED_TABLES: readonly SealedTable[] = [
  {
    table: "devices",
    pk: "id",
    columns: [
      "id",
      "name",
      "platform",
      "role",
      "public_key",
      "token_hash",
      "scopes",
      "paired_at",
      "revoked_at",
      "created_at",
      "updated_at",
      "device_family",
    ],
    blobs: ["public_key", "token_hash"],
    ignored: ["last_seen_at"],
    added: "revoke_device",
    label: "name",
  },
  {
    table: "passkeys",
    pk: "id",
    columns: [
      "id",
      "device_id",
      "credential_id",
      "public_key",
      "counter",
      "transports",
      "name",
      "backed_up",
      "created_at",
    ],
    blobs: ["public_key"],
    ignored: ["last_used_at"],
    added: "delete",
    label: "name",
  },
  {
    table: "setup_tokens",
    pk: "id",
    columns: [
      "id",
      "token_hash",
      "scopes",
      "created_by_device_id",
      "created_at",
      "expires_at",
      "used_at",
      "used_by_device_id",
      "revoked_at",
      "cert_pin",
    ],
    added: "revoke_setup_token",
    label: "id",
  },
  {
    table: "settings",
    pk: "key",
    columns: ["key", "value", "created_at", "updated_at"],
    where: (p) => `${SEALED_SETTING_FN}(${p}key)`,
    added: "delete",
    label: "key",
  },
  {
    table: "policy_rules",
    pk: "id",
    columns: ["id", "priority", "match", "effect", "note", "created_at", "updated_at"],
    added: "delete",
    label: "effect",
  },
  {
    table: "approvals",
    pk: "id",
    columns: [
      "id",
      "kind",
      "summary",
      "details",
      "binding_hash",
      "grant_key",
      "side_effect",
      "target_kind",
      "target",
      "device_only",
      "requires_authentication",
      "taint",
      "requested_by_run_id",
      "task_id",
      "thread_id",
      "tool_call_id",
      "agent",
      "surfaces",
      "scopes_offered",
      "answer_tokens",
      "status",
      "scope_granted",
      "decided_by",
      "invalidated_reason",
      "request_input",
      "consumed_at",
      "run_revoked",
      "boot_id",
      "requested_at",
      "expires_at",
      "decided_at",
      "grant_id",
      "created_at",
      "updated_at",
    ],
    added: "invalidate_approval",
    label: "kind",
  },
  {
    table: "grants",
    pk: "id",
    columns: [
      "id",
      "kind",
      "scope",
      "grant_key",
      "subject",
      "binding",
      "side_effect",
      "task_id",
      "session_id",
      "thread_id",
      "origin",
      "expires_at",
      "use_count",
      "max_uses",
      "last_used_binding_hash",
      "created_from_approval_id",
      "created_by_device_id",
      "created_at",
      "revoked_at",
      "revoked_reason",
      "updated_at",
      "requester_id",
    ],
    ignored: ["last_used_at"],
    added: "revoke_grant",
    label: "kind",
  },
  {
    table: "channels",
    pk: "id",
    columns: [
      "id",
      "type",
      "account",
      "dm_policy",
      "allow_from",
      "group_allow_from",
      "require_mention",
      "owner_ids",
      "dm_scope",
      "node_id",
      "config",
      "created_at",
      "updated_at",
    ],
    ignored: ["status"],
    added: "delete",
    label: "type",
  },
  {
    table: "identities",
    pk: "id",
    columns: [
      "id",
      "display",
      "links",
      "delegated_persona",
      "tool_allow",
      "created_at",
      "updated_at",
    ],
    added: "delete",
    label: "display",
  },
  {
    table: "memory_trusted_senders",
    pk: "entity_id",
    columns: ["entity_id", "state", "decided_at"],
    added: "delete",
    label: "entity_id",
  },
  {
    table: "security_recoveries",
    pk: "id",
    columns: [
      "id",
      "op",
      "params",
      "status",
      "seen_at",
      "not_before",
      "decided_at",
      "decided_by_device_id",
      "outcome",
      "created_at",
      "updated_at",
    ],
    added: "delete",
    label: "op",
  },
  {
    table: "security_alerts",
    pk: "id",
    columns: [
      "id",
      "kind",
      "severity",
      "details",
      "created_at",
      "notified_at",
      "acknowledged_at",
      "acknowledged_by_device_id",
    ],
    added: "delete",
    label: "kind",
  },
];

/** `json_object(...)` over a row's sealed columns; `p` is `NEW.`, `OLD.` or `t.`. */
export function rowJson(spec: SealedTable, p: string): string {
  const blobs = new Set(spec.blobs ?? []);
  const parts = spec.columns.map((c) =>
    // hex(NULL) is '': keep NULL a JSON null, so a restored row gets NULL back, not x''.
    blobs.has(c)
      ? `'${c}', CASE WHEN ${p}${c} IS NULL THEN NULL ELSE hex(${p}${c}) END`
      : `'${c}', ${p}${c}`,
  );
  return `json_object(${parts.join(", ")})`;
}

/** The primary key as text. */
export function pkExpr(spec: SealedTable, p: string): string {
  return `CAST(${p}${spec.pk} AS TEXT)`;
}

export function whereExpr(spec: SealedTable, p: string): string {
  return spec.where === undefined ? "1" : spec.where(p);
}
