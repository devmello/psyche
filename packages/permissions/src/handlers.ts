import type { AuditQuery, DetailedVerification, HashChainAuditLog } from "@psyche/audit";
import {
  type AccessEntry,
  type ApprovalRequest,
  type AuditEntry,
  type DeviceScope,
  type Grant,
  type MethodParams,
  Methods,
  PsycheError,
  type Surface,
} from "@psyche/protocol";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PsychePermissionBroker } from "./broker.ts";
import { type FrictionReport, frictionMetrics } from "./friction.ts";
import type { PresenceAssertion } from "./types.ts";

/**
 * Handlers for the Gateway to mount: the protocol's `approvals.*`, `grants.*` and `audit.*` method
 * families, validated against the protocol's own schemas. The
 * caller identity comes from the authenticated connection, never from params, so a client cannot
 * claim another device's surface. Scope checks are repeated here as defence in depth.
 */

export interface Caller {
  deviceId: string;
  scopes: readonly DeviceScope[];
  /** The surface this connection answers for (`desktop`, `web`, …). */
  surface: Surface;
  role?: "client" | "node" | "both";
}

/** The protocol's `audit.*` definitions (params, result, scope); the Gateway checks the same. */
const AuditMethods = {
  "audit.list": Methods["audit.list"],
  "audit.verify": Methods["audit.verify"],
  "audit.export": Methods["audit.export"],
  "audit.friction": Methods["audit.friction"],
};

function check<T extends TSchema>(schema: T, params: unknown): Static<T> {
  if (!Value.Check(schema, params)) {
    const first = [...Value.Errors(schema, params)][0];
    throw new PsycheError(
      "invalid_params",
      first === undefined ? "invalid params" : `${first.path} ${first.message}`,
    );
  }
  return params;
}

function requireScope(caller: Caller, scope: DeviceScope): void {
  if (caller.role === "node" || !caller.scopes.includes(scope)) {
    throw new PsycheError("forbidden", `requires ${scope}`);
  }
}

export interface PermissionHandlers {
  "approvals.list"(
    p: unknown,
    c: Caller,
  ): Promise<{ approvals: ApprovalRequest[]; nextCursor: string | null }>;
  "approvals.get"(p: unknown, c: Caller): Promise<{ approval: ApprovalRequest }>;
  "approvals.answer"(
    p: unknown,
    c: Caller,
  ): Promise<{ approval: ApprovalRequest; grant: Grant | null }>;
  "access.list"(p: unknown, c: Caller): Promise<{ entries: AccessEntry[] }>;
  "access.revoke"(p: unknown, c: Caller): Promise<{ revoked: boolean }>;
  "grants.list"(p: unknown, c: Caller): Promise<{ grants: Grant[] }>;
  "grants.revoke"(p: unknown, c: Caller): Promise<{ grant: Grant }>;
  "audit.list"(p: unknown, c: Caller): Promise<{ entries: AuditEntry[] }>;
  "audit.verify"(p: unknown, c: Caller): Promise<DetailedVerification>;
  "audit.export"(p: unknown, c: Caller): Promise<{ format: "jsonl" | "json"; data: string }>;
  "audit.friction"(p: unknown, c: Caller): Promise<FrictionReport>;
}

export function createPermissionHandlers(
  broker: PsychePermissionBroker,
  audit: HashChainAuditLog | undefined,
): PermissionHandlers {
  const needAudit = () => {
    if (audit === undefined) throw new PsycheError("unavailable", "audit log not configured");
    return audit;
  };
  return {
    async "approvals.list"(p, c) {
      requireScope(c, Methods["approvals.list"].scope);
      const params = check(Methods["approvals.list"].params, p) as MethodParams<"approvals.list">;
      const statuses = params.status ?? ["pending"];
      const all = (await broker.list()).filter((a) => statuses.includes(a.status)).reverse();
      const start = params.cursor === undefined ? 0 : Number.parseInt(params.cursor, 10);
      if (!Number.isSafeInteger(start) || start < 0)
        throw new PsycheError("invalid_params", "bad cursor");
      const limit = params.limit ?? 50;
      const page = all.slice(start, start + limit);
      return {
        approvals: page,
        nextCursor: start + limit < all.length ? String(start + limit) : null,
      };
    },
    async "approvals.get"(p, c) {
      requireScope(c, Methods["approvals.get"].scope);
      const { approvalId } = check(Methods["approvals.get"].params, p);
      const approval = await broker.get(approvalId);
      if (approval === undefined)
        throw new PsycheError("not_found", `approval ${approvalId} not found`);
      return { approval };
    },
    async "approvals.answer"(p, c) {
      requireScope(c, Methods["approvals.answer"].scope);
      const raw = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
      const { presence, typedConfirmation, ...wire } = raw;
      const params = check(Methods["approvals.answer"].params, wire);
      // `password` presence is created by the Gateway after its own polkit check, never by a
      // client (linux design §9.6): a client that sends one is refused, audited and counted.
      if ((presence as { kind?: unknown } | undefined)?.kind === "password") {
        await broker.rejectPresence({
          approvalId: params.approvalId,
          decidedBy: { deviceId: c.deviceId, surface: c.surface },
          reason: "password_from_client",
          code: "forbidden",
          message: "a password assertion cannot come from a client",
          details: { reason: "presence_invalid" },
        });
      }
      const approval = await broker.answer({
        ...params,
        decidedBy: { deviceId: c.deviceId, surface: c.surface },
        ...(presence === undefined ? {} : { presence: presence as PresenceAssertion }),
        ...(typeof typedConfirmation === "string" ? { typedConfirmation } : {}),
      });
      const grant =
        approval.grantId == null
          ? null
          : ((await broker.listGrants({ includeRevoked: true })).find(
              (g) => g.id === approval.grantId,
            ) ?? null);
      return { approval, grant };
    },
    async "access.list"(p, c) {
      requireScope(c, Methods["access.list"].scope);
      check(Methods["access.list"].params, p);
      return { entries: await accessEntries(broker) };
    },
    async "access.revoke"(p, c) {
      requireScope(c, Methods["access.revoke"].scope);
      const { entryId } = check(Methods["access.revoke"].params, p);
      return { revoked: await revokeAccess(broker, entryId) };
    },
    async "grants.list"(p, c) {
      requireScope(c, Methods["grants.list"].scope);
      const params = check(Methods["grants.list"].params, p);
      return { grants: await broker.listGrants(params) };
    },
    async "grants.revoke"(p, c) {
      requireScope(c, Methods["grants.revoke"].scope);
      const { grantId } = check(Methods["grants.revoke"].params, p);
      return { grant: await broker.revokeGrant(grantId) };
    },
    async "audit.list"(p, c) {
      requireScope(c, AuditMethods["audit.list"].scope);
      const params = check(AuditMethods["audit.list"].params, p);
      const { taskId, approvalId, ...rest } = params;
      const subject: Record<string, string> = {};
      if (taskId !== undefined) subject.taskId = taskId;
      if (approvalId !== undefined) subject.approvalId = approvalId;
      const q: AuditQuery = { ...rest, ...(Object.keys(subject).length > 0 ? { subject } : {}) };
      return { entries: await needAudit().query(q) };
    },
    async "audit.verify"(p, c) {
      requireScope(c, AuditMethods["audit.verify"].scope);
      check(AuditMethods["audit.verify"].params, p);
      return needAudit().verifyDetailed();
    },
    async "audit.export"(p, c) {
      requireScope(c, AuditMethods["audit.export"].scope);
      const params = check(AuditMethods["audit.export"].params, p);
      const format = params.format ?? "jsonl";
      return { format, data: await needAudit().export({ ...params, format }) };
    },
    async "audit.friction"(p, c) {
      requireScope(c, AuditMethods["audit.friction"].scope);
      const params = check(AuditMethods["audit.friction"].params, p);
      const entries = await needAudit().query({
        ...(params.since === undefined ? {} : { since: params.since }),
        ...(params.until === undefined ? {} : { until: params.until }),
        kinds: [
          "tool_call.decided",
          "approval.created",
          "approval.decided",
          "approval.expired",
          "approval.invalidated",
          "approval.answer_rejected",
          "grant.created",
          "classifier.labeled",
        ],
      });
      return frictionMetrics(entries);
    },
  };
}

const FOLDER_ALWAYS = "folder:always:";
const FOLDER_CHAT = "folder:chat:";
const GRANT = "grant:";

/** The words a standing grant gets in the access list. */
function grantLabel(g: Grant): string {
  const subject = Object.values(g.subject).find((v): v is string => typeof v === "string");
  return subject === undefined
    ? g.kind.replaceAll("_", " ")
    : `${g.kind.replaceAll("_", " ")}: ${subject}`;
}

/**
 * Everything the owner has given the agent access to, in one list: shared folders (Settings and
 * this conversation's) and live standing grants. Folders come first, longest-lived first.
 */
export async function accessEntries(broker: PsychePermissionBroker): Promise<AccessEntry[]> {
  const out: AccessEntry[] = [];
  for (const f of broker.policy.folders ?? []) {
    out.push({
      id: `${FOLDER_ALWAYS}${f.path}`,
      type: "folder",
      scope: "always",
      label: f.path,
      path: f.path,
      mode: f.mode,
    });
  }
  for (const { threadId, entry } of broker.allSessionFolders()) {
    out.push({
      id: `${FOLDER_CHAT}${threadId}:${entry.path}`,
      type: "folder",
      scope: "conversation",
      label: entry.path,
      path: entry.path,
      mode: entry.mode,
      threadId,
    });
  }
  for (const g of await broker.listGrants()) {
    out.push({
      id: `${GRANT}${g.id}`,
      type: "grant",
      scope: g.scope === "always" ? "always" : "limited",
      label: grantLabel(g),
      grantId: g.id,
      kind: g.kind,
      since: g.createdAt,
      ...(g.lastUsedAt == null ? {} : { lastUsedAt: g.lastUsedAt }),
    });
  }
  return out;
}

/** Revokes one `accessEntries` row; false when it was already gone. */
export async function revokeAccess(
  broker: PsychePermissionBroker,
  entryId: string,
): Promise<boolean> {
  if (entryId.startsWith(FOLDER_ALWAYS))
    return broker.revokeFolder(entryId.slice(FOLDER_ALWAYS.length));
  if (entryId.startsWith(FOLDER_CHAT)) {
    const rest = entryId.slice(FOLDER_CHAT.length);
    const at = rest.indexOf(":");
    if (at <= 0) throw new PsycheError("invalid_params", "bad access entry");
    return broker.revokeSessionFolder(rest.slice(0, at), rest.slice(at + 1));
  }
  if (entryId.startsWith(GRANT)) {
    const grantId = entryId.slice(GRANT.length);
    const live = (await broker.listGrants()).some((g) => g.id === grantId);
    if (!live) return false;
    await broker.revokeGrant(grantId);
    return true;
  }
  throw new PsycheError("invalid_params", "bad access entry");
}
