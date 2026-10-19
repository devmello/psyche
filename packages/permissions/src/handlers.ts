import type { AuditQuery, DetailedVerification, HashChainAuditLog } from "@psyche/audit";
import {
  type ApprovalRequest,
  type AuditEntry,
  type DeviceScope,
  type Grant,
  type MethodParams,
  Methods,
  PsycheError,
  type Surface,
} from "@psyche/protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PsychePermissionBroker } from "./broker.ts";
import type { PresenceAssertion } from "./types.ts";

/**
 * Handlers for the Gateway to mount: `approvals.*`, `grants.*` (protocol method families) and
 * `audit.*` (local schemas until the additive protocol PR lands; see docs/status/s05.md). The
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

export const AuditMethods = {
  "audit.list": {
    params: Type.Object({
      kind: Type.Optional(Type.String()),
      kindPrefix: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
      sinceSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
    }),
    scope: "operator.read" as const,
  },
  "audit.verify": { params: Type.Object({}), scope: "operator.read" as const },
  "audit.export": {
    params: Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("jsonl"), Type.Literal("json")])),
      since: Type.Optional(Type.String()),
      until: Type.Optional(Type.String()),
    }),
    scope: "operator.admin" as const,
  },
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
  "grants.list"(p: unknown, c: Caller): Promise<{ grants: Grant[] }>;
  "grants.revoke"(p: unknown, c: Caller): Promise<{ grant: Grant }>;
  "audit.list"(p: unknown, c: Caller): Promise<{ entries: AuditEntry[] }>;
  "audit.verify"(p: unknown, c: Caller): Promise<DetailedVerification>;
  "audit.export"(p: unknown, c: Caller): Promise<{ format: "jsonl" | "json"; data: string }>;
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
  };
}
