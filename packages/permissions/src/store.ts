import type { SqliteLike } from "@psyche/audit";
import type {
  ApprovalRequest,
  ApprovalStatus,
  Grant,
  JsonObject,
  SideEffect,
  Surface,
} from "@psyche/protocol";
import type { PolicyApprovalInput } from "./types.ts";

/**
 * Persistence for approvals and grants (data model §4). Synchronous on purpose: check-and-update
 * sequences (first answer wins, consume a `once`) run inside `transaction` with no `await`, so no
 * other caller can interleave. Answer tokens are stored hashed, never in clear (data model §4).
 */

export interface StoredToken {
  surface: Surface;
  /** `sha256:` of the token. */
  hash: string;
  usedAt: string | null;
}

export interface StoredApproval {
  approval: ApprovalRequest;
  tokens: StoredToken[];
  /** The request input, including the decided call and context (design-09). */
  input: PolicyApprovalInput;
  consumedAt: string | null;
  /** Run authority revoked: approved-but-unused approvals no longer verify. */
  revoked: boolean;
  /** Boot id of the Gateway that issued it. */
  bootId: string;
}

export interface GrantMeta {
  sideEffect: SideEffect;
  /** `session` grants: the Gateway boot and thread they belong to (design-28). */
  sessionId: string | null;
  threadId: string | null;
  /** `site` grants: the one origin they cover. */
  origin: string | null;
  createdByDeviceId: string | null;
  maxUses: number | null;
  lastUsedBindingHash: string | null;
  revokedReason: string | null;
  /** `requesterKey()` of whoever the grant was made for; `null` = the owner (security §9). */
  requesterId?: string | null;
}

export interface StoredGrant {
  grant: Grant;
  meta: GrantMeta;
}

export interface PermissionStore {
  transaction<T>(fn: () => T): T;
  insertApproval(rec: StoredApproval): void;
  getApproval(id: string): StoredApproval | undefined;
  updateApproval(rec: StoredApproval): void;
  listApprovals(filter?: { status?: ApprovalStatus }): StoredApproval[];
  insertGrant(rec: StoredGrant): void;
  getGrant(id: string): StoredGrant | undefined;
  updateGrant(rec: StoredGrant): void;
  listGrants(): StoredGrant[];
}

export class MemoryPermissionStore implements PermissionStore {
  readonly #approvals = new Map<string, StoredApproval>();
  readonly #grants = new Map<string, StoredGrant>();

  transaction<T>(fn: () => T): T {
    return fn();
  }

  insertApproval(rec: StoredApproval): void {
    this.#approvals.set(rec.approval.id, structuredClone(rec));
  }

  getApproval(id: string): StoredApproval | undefined {
    const r = this.#approvals.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }

  updateApproval(rec: StoredApproval): void {
    this.#approvals.set(rec.approval.id, structuredClone(rec));
  }

  listApprovals(filter: { status?: ApprovalStatus } = {}): StoredApproval[] {
    return [...this.#approvals.values()]
      .filter((r) => filter.status === undefined || r.approval.status === filter.status)
      .map((r) => structuredClone(r));
  }

  insertGrant(rec: StoredGrant): void {
    this.#grants.set(rec.grant.id, structuredClone(rec));
  }

  getGrant(id: string): StoredGrant | undefined {
    const r = this.#grants.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }

  updateGrant(rec: StoredGrant): void {
    this.#grants.set(rec.grant.id, structuredClone(rec));
  }

  listGrants(): StoredGrant[] {
    return [...this.#grants.values()].map((r) => structuredClone(r));
  }
}

/** better-sqlite3 surface used here (`PsycheDb.sqlite` satisfies it). */
export interface SqliteDb extends SqliteLike {
  exec(sql: string): unknown;
}

interface ApprovalRow {
  id: string;
  kind: string;
  summary: string;
  details: string;
  binding_hash: string;
  grant_key: string;
  side_effect: string | null;
  target_kind: string | null;
  target: string | null;
  device_only: number;
  requires_authentication: number;
  taint: number;
  requested_by_run_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  tool_call_id: string | null;
  agent: string | null;
  surfaces: string;
  scopes_offered: string;
  answer_tokens: string;
  status: ApprovalStatus;
  scope_granted: string | null;
  decided_by: string | null;
  invalidated_reason: string | null;
  request_input: string;
  consumed_at: string | null;
  run_revoked: number;
  boot_id: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  grant_id: string | null;
}

interface GrantRow {
  id: string;
  kind: string;
  scope: string;
  grant_key: string;
  subject: string;
  binding: string | null;
  side_effect: string;
  task_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  origin: string | null;
  expires_at: string | null;
  use_count: number;
  max_uses: number | null;
  last_used_at: string | null;
  last_used_binding_hash: string | null;
  created_from_approval_id: string | null;
  created_by_device_id: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  requester_id: string | null;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string): T => JSON.parse(s) as T;

/** `approvals` and `grants` tables (migration `202610200900_permissions_init.sql`). */
export class SqlitePermissionStore implements PermissionStore {
  readonly #db: SqliteDb;
  #depth = 0;

  constructor(db: SqliteDb) {
    this.#db = db;
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#depth -= 1;
    }
  }

  #approvalParams(rec: StoredApproval): unknown[] {
    const a = rec.approval;
    const now = new Date().toISOString();
    return [
      a.id,
      a.kind,
      a.summary,
      json(a.details),
      a.bindingHash,
      a.grantKey,
      a.sideEffect ?? null,
      a.targetKind ?? null,
      a.target === undefined ? null : json(a.target),
      a.deviceOnly ? 1 : 0,
      a.requiresAuthentication ? 1 : 0,
      a.taint ? 1 : 0,
      a.requestedBy.runId,
      a.requestedBy.taskId,
      a.requestedBy.threadId,
      a.requestedBy.toolCallId ?? null,
      a.requestedBy.agent ?? null,
      json(a.surfaces),
      json(a.scopesOffered),
      json(rec.tokens),
      a.status,
      a.scopeGranted,
      a.decidedBy === null ? null : json(a.decidedBy),
      a.invalidatedReason ?? null,
      json(rec.input),
      rec.consumedAt,
      rec.revoked ? 1 : 0,
      rec.bootId,
      a.requestedAt,
      a.expiresAt,
      a.decidedAt,
      a.grantId,
      now,
      now,
    ];
  }

  insertApproval(rec: StoredApproval): void {
    this.#db
      .prepare(
        `INSERT INTO approvals (id, kind, summary, details, binding_hash, grant_key, side_effect, target_kind,
           target, device_only, requires_authentication, taint, requested_by_run_id, task_id, thread_id,
           tool_call_id, agent, surfaces, scopes_offered, answer_tokens, status, scope_granted, decided_by,
           invalidated_reason, request_input, consumed_at, run_revoked, boot_id, requested_at, expires_at,
           decided_at, grant_id, created_at, updated_at)
         VALUES (${Array(34).fill("?").join(", ")})`,
      )
      .run(...this.#approvalParams(rec));
  }

  updateApproval(rec: StoredApproval): void {
    const p = this.#approvalParams(rec);
    // Mutable columns only; the request itself never changes.
    this.#db
      .prepare(
        `UPDATE approvals SET answer_tokens = ?, status = ?, scope_granted = ?, decided_by = ?,
           invalidated_reason = ?, consumed_at = ?, run_revoked = ?, decided_at = ?, grant_id = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(p[19], p[20], p[21], p[22], p[23], p[25], p[26], p[30], p[31], p[33], rec.approval.id);
  }

  getApproval(id: string): StoredApproval | undefined {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  listApprovals(filter: { status?: ApprovalStatus } = {}): StoredApproval[] {
    const rows = (
      filter.status === undefined
        ? this.#db.prepare("SELECT * FROM approvals ORDER BY requested_at, rowid").all()
        : this.#db
            .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY requested_at, rowid")
            .all(filter.status)
    ) as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  #grantParams(rec: StoredGrant): unknown[] {
    const g = rec.grant;
    const m = rec.meta;
    return [
      g.id,
      g.kind,
      g.scope,
      g.grantKey,
      json(g.subject),
      g.binding === null ? null : json(g.binding),
      m.sideEffect,
      g.taskId,
      m.sessionId,
      m.threadId,
      m.origin,
      g.expiresAt,
      g.useCount,
      m.maxUses,
      g.lastUsedAt,
      m.lastUsedBindingHash,
      g.createdFromApprovalId,
      m.createdByDeviceId,
      g.createdAt,
      g.revokedAt,
      m.revokedReason,
      new Date().toISOString(),
      m.requesterId ?? null,
    ];
  }

  insertGrant(rec: StoredGrant): void {
    this.#db
      .prepare(
        `INSERT INTO grants (id, kind, scope, grant_key, subject, binding, side_effect, task_id, session_id,
           thread_id, origin, expires_at, use_count, max_uses, last_used_at, last_used_binding_hash,
           created_from_approval_id, created_by_device_id, created_at, revoked_at, revoked_reason, updated_at,
           requester_id)
         VALUES (${Array(23).fill("?").join(", ")})`,
      )
      .run(...this.#grantParams(rec));
  }

  updateGrant(rec: StoredGrant): void {
    const g = rec.grant;
    this.#db
      .prepare(
        `UPDATE grants SET expires_at = ?, use_count = ?, last_used_at = ?, last_used_binding_hash = ?,
           revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        g.expiresAt,
        g.useCount,
        g.lastUsedAt,
        rec.meta.lastUsedBindingHash,
        g.revokedAt,
        rec.meta.revokedReason,
        new Date().toISOString(),
        g.id,
      );
  }

  getGrant(id: string): StoredGrant | undefined {
    const row = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as
      | GrantRow
      | undefined;
    return row === undefined ? undefined : grantFromRow(row);
  }

  listGrants(): StoredGrant[] {
    return (
      this.#db.prepare("SELECT * FROM grants ORDER BY created_at, rowid").all() as GrantRow[]
    ).map(grantFromRow);
  }
}

function approvalFromRow(r: ApprovalRow): StoredApproval {
  const approval: ApprovalRequest = {
    id: r.id,
    kind: r.kind as ApprovalRequest["kind"],
    summary: r.summary,
    details: parse<JsonObject>(r.details),
    bindingHash: r.binding_hash,
    grantKey: r.grant_key,
    requestedBy: {
      runId: r.requested_by_run_id,
      taskId: r.task_id,
      threadId: r.thread_id,
      ...(r.tool_call_id === null ? {} : { toolCallId: r.tool_call_id }),
      ...(r.agent === null ? {} : { agent: r.agent }),
    },
    surfaces: parse<string[]>(r.surfaces),
    scopesOffered: parse<ApprovalRequest["scopesOffered"]>(r.scopes_offered),
    deviceOnly: r.device_only === 1,
    requiresAuthentication: r.requires_authentication === 1,
    taint: r.taint === 1,
    status: r.status,
    scopeGranted: r.scope_granted as ApprovalRequest["scopeGranted"],
    decidedBy: r.decided_by === null ? null : parse<ApprovalRequest["decidedBy"]>(r.decided_by),
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    grantId: r.grant_id,
  };
  if (r.side_effect !== null) approval.sideEffect = r.side_effect as SideEffect;
  if (r.target_kind !== null)
    approval.targetKind = r.target_kind as NonNullable<ApprovalRequest["targetKind"]>;
  if (r.target !== null) approval.target = parse<NonNullable<ApprovalRequest["target"]>>(r.target);
  if (r.invalidated_reason !== null) approval.invalidatedReason = r.invalidated_reason;
  const input = parse<PolicyApprovalInput>(r.request_input);
  // Not a column: the request input keeps it (teaching loop, "Because you said").
  if (input.fromLesson !== undefined) approval.fromLesson = { ...input.fromLesson };
  return {
    approval,
    tokens: parse<StoredToken[]>(r.answer_tokens),
    input,
    consumedAt: r.consumed_at,
    revoked: r.run_revoked === 1,
    bootId: r.boot_id,
  };
}

function grantFromRow(r: GrantRow): StoredGrant {
  return {
    grant: {
      id: r.id,
      kind: r.kind as Grant["kind"],
      scope: r.scope as Grant["scope"],
      grantKey: r.grant_key,
      subject: parse<JsonObject>(r.subject),
      binding: r.binding === null ? null : parse<JsonObject>(r.binding),
      expiresAt: r.expires_at,
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
      createdFromApprovalId: r.created_from_approval_id,
      taskId: r.task_id,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    },
    meta: {
      sideEffect: r.side_effect as SideEffect,
      sessionId: r.session_id,
      threadId: r.thread_id,
      origin: r.origin,
      createdByDeviceId: r.created_by_device_id,
      maxUses: r.max_uses,
      lastUsedBindingHash: r.last_used_binding_hash,
      revokedReason: r.revoked_reason,
      requesterId: r.requester_id,
    },
  };
}
