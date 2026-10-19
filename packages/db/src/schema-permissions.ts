/**
 * drizzle mirror of `migrations/202610200900_permissions_init.sql` (owner: S05). Storage
 * representation, as in `schema.ts`; `packages/permissions` and `packages/audit` query these
 * tables with raw statements.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  details: text("details").notNull(),
  bindingHash: text("binding_hash").notNull(),
  grantKey: text("grant_key").notNull(),
  sideEffect: text("side_effect"),
  targetKind: text("target_kind"),
  target: text("target"),
  deviceOnly: integer("device_only").notNull(),
  requiresAuthentication: integer("requires_authentication").notNull(),
  taint: integer("taint").notNull(),
  requestedByRunId: text("requested_by_run_id"),
  taskId: text("task_id"),
  threadId: text("thread_id"),
  toolCallId: text("tool_call_id"),
  agent: text("agent"),
  surfaces: text("surfaces").notNull(),
  scopesOffered: text("scopes_offered").notNull(),
  answerTokens: text("answer_tokens").notNull(),
  status: text("status").notNull(),
  scopeGranted: text("scope_granted"),
  decidedBy: text("decided_by"),
  invalidatedReason: text("invalidated_reason"),
  requestInput: text("request_input").notNull(),
  consumedAt: text("consumed_at"),
  runRevoked: integer("run_revoked").notNull(),
  bootId: text("boot_id").notNull(),
  requestedAt: text("requested_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  grantId: text("grant_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const grants = sqliteTable("grants", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  scope: text("scope").notNull(),
  grantKey: text("grant_key").notNull(),
  subject: text("subject").notNull(),
  binding: text("binding"),
  sideEffect: text("side_effect").notNull(),
  taskId: text("task_id"),
  sessionId: text("session_id"),
  threadId: text("thread_id"),
  origin: text("origin"),
  expiresAt: text("expires_at"),
  useCount: integer("use_count").notNull(),
  maxUses: integer("max_uses"),
  lastUsedAt: text("last_used_at"),
  lastUsedBindingHash: text("last_used_binding_hash"),
  createdFromApprovalId: text("created_from_approval_id"),
  createdByDeviceId: text("created_by_device_id"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
  revokedReason: text("revoked_reason"),
  updatedAt: text("updated_at").notNull(),
});

export const policyRules = sqliteTable("policy_rules", {
  id: text("id").primaryKey(),
  priority: integer("priority").notNull(),
  match: text("match").notNull(),
  effect: text("effect").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const receipts = sqliteTable("receipts", {
  id: text("id").primaryKey(),
  shortId: text("short_id"),
  kind: text("kind").notNull(),
  taskId: text("task_id"),
  toolCallId: text("tool_call_id"),
  approvalId: text("approval_id"),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull(),
  externalRefs: text("external_refs").notNull(),
  payload: text("payload"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const permissionsSchema = { approvals, grants, policyRules, receipts };
