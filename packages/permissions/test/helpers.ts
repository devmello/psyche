import {
  createAuditLog,
  type HashChainAuditLog,
  Receipts,
  SqliteReceiptStore,
} from "@psyche/audit";
import { openDb } from "@psyche/db";
import type { DeviceScope } from "@psyche/protocol";
import { FakeClock, FakeNotifier, sha256 } from "@psyche/testing";
import {
  type ApproverDirectory,
  createPermissionBroker,
  type PermissionBrokerOptions,
  type PolicyCall,
  type PolicyContext,
  type PsychePermissionBroker,
  SqlitePermissionStore,
} from "../src/index.ts";

export const DEVICE = { deviceId: "dev_mac" };
export const OWNER = { channel: "telegram", senderId: "owner-1" };

/** Paired devices and owner identities for tests. */
export function approvers(
  devices: Record<string, { scopes: DeviceScope[]; revoked?: boolean; role?: string }> = {
    dev_mac: { scopes: ["operator.read", "operator.approvals"] },
    dev_conf: { scopes: ["operator.read", "operator.approvals"] },
    dev_web: { scopes: ["operator.read", "operator.approvals"] },
    dev_reader: { scopes: ["operator.read"] },
    dev_node: { scopes: ["node", "operator.approvals"], role: "node" },
  },
  owners: string[] = ["telegram:owner-1"],
): ApproverDirectory {
  return {
    device: async (id) => devices[id],
    isOwnerSender: async (channel, sender) => owners.includes(`${channel}:${sender}`),
  };
}

export interface Harness {
  broker: PsychePermissionBroker;
  clock: FakeClock;
  audit: HashChainAuditLog;
  notifier: FakeNotifier;
}

export function makeBroker(
  options: Partial<PermissionBrokerOptions> = {},
  clock = new FakeClock(),
): Harness {
  const audit = createAuditLog({ clock });
  const notifier = new FakeNotifier({ clock });
  const broker = createPermissionBroker({
    approvers: approvers(),
    clock,
    audit,
    notifier,
    ...options,
  });
  return { broker, clock, audit, notifier };
}

/** A broker on a real SQLite database (migrations applied), for restart tests. */
export function sqliteBroker(
  db: ReturnType<typeof openDb>,
  clock: FakeClock,
  options: Partial<PermissionBrokerOptions> = {},
) {
  const audit = createAuditLog({ clock });
  return createPermissionBroker({
    approvers: approvers(),
    clock,
    audit,
    store: new SqlitePermissionStore(db.sqlite),
    receipts: new Receipts({ clock, audit, store: new SqliteReceiptStore(db.sqlite) }),
    ...options,
  });
}

export function memoryDb() {
  return openDb(":memory:");
}

export const CTX: PolicyContext = {
  threadId: "thr_main",
  runId: "run_1",
  taskId: "task_1",
  permissionMode: "balanced",
  taint: false,
};

export function call(
  tool: string,
  sideEffect: PolicyCall["sideEffect"],
  target?: PolicyCall["target"],
  extra: Partial<PolicyCall> = {},
): PolicyCall {
  const params = {
    tool,
    target: target?.value ?? null,
    ...((extra.params as object | undefined) ?? {}),
  };
  return {
    tool,
    sideEffect,
    ...(target === undefined ? {} : { target, targetKind: target.kind }),
    params,
    paramsHash: sha256(JSON.stringify(params)),
    ...extra,
  };
}

export const origin = (value: string) => ({ kind: "origin" as const, value });
export const path = (value: string) => ({ kind: "path" as const, value });
export const recipient = (value: string) => ({ kind: "recipient" as const, value });

/** decide → requestApproval → (arm) → answer, returning the decided approval. */
export async function approve(
  h: Harness,
  c: PolicyCall,
  ctx: PolicyContext,
  scope: "once" | "task" | "site" | "session" | "always" = "once",
  surfaces = ["desktop"],
) {
  const d = await h.broker.decide(c, ctx);
  if (
    d.decision !== "ask" ||
    d.approvalKind === undefined ||
    d.bindingHash === undefined ||
    d.grantKey === undefined
  ) {
    throw new Error(`expected ask, got ${d.decision} (${d.rule})`);
  }
  const issued = await h.broker.requestApproval({
    kind: d.approvalKind,
    summary: `test ${c.tool}`,
    details: {},
    bindingHash: d.bindingHash,
    grantKey: d.grantKey,
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces,
    taint: ctx.taint,
  });
  h.clock.advance(500);
  const approval = await h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens[surfaces[0] ?? "desktop"] ?? "",
    decision: "approve",
    scope,
    decidedBy: DEVICE,
  });
  return { d, issued, approval };
}
