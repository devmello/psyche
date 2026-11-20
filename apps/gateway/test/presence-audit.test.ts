import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeHelper } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * The presence audit (owner's decision, 2026-11-09: presence is for payments only). Every gated
 * non-payment method, on a Gateway whose presence was enrolled and then lost (the strictest
 * state for a non-payment change): the owner's admin device gets a plain card (no
 * `presence_required`, `requiresAuthentication` false); a non-admin device is refused; the card
 * is never offered on a chat surface; and a payment card still requires authentication.
 */

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const ADMIN = "audit-admin";
const SCOPES = ["operator.read", "operator.write", "operator.approvals"];

async function boot() {
  const keys = new Map<string, string>();
  home = mkdtempSync(join(tmpdir(), "psyche-audit-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeHelper(s, { presenceKeys: (id) => keys.get(id) })],
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, ADMIN)).close();
  updateDevice(composed.gateway.context.db, ADMIN, { scopes: [...SCOPES, "operator.admin"] });
  const admin = await desktopClient(composed.gateway, key, ADMIN);
  clients.push(admin);
  const otherKey = newDeviceKey();
  (await desktopClient(composed.gateway, otherKey, "audit-member")).close();
  updateDevice(composed.gateway.context.db, "audit-member", { scopes: SCOPES });
  const member = await desktopClient(composed.gateway, otherKey, "audit-member");
  clients.push(member);
  // Enroll presence, then lose the last verifier: the sticky "unavailable" state.
  keys.set(ADMIN, "registered-key");
  await admin.call("devices.list", {});
  keys.delete(ADMIN);
  return { c: composed, admin, member };
}

const CALLS: [string, string, Record<string, unknown>][] = [
  ["a security setting", "settings.set", { key: "permissions.policy", value: { allow: [] } }],
  ["turning LAN on", "settings.set", { key: "gateway.lan", value: { enabled: true } }],
  ["a pairing link", "devices.setupToken.create", { scopes: ["operator.read"] }],
  ["a LAN pairing link", "devices.setupToken.create", { scopes: ["operator.read"], via: "lan" }],
  ["erasing memory", "memory.reset", {}],
  ["a new LAN certificate", "gateway.lan.rotateCert", {}],
];

describe("non-payment changes are one tap for the owner's admin device", () => {
  it.each(CALLS)(
    "%s: admin gets a plain card, a non-admin is refused",
    async (_n, method, params) => {
      const { admin, member } = await boot();
      const res = await admin.request(method, params, ik());
      expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
      const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
        .approvalId;
      const got = await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId });
      expect(got.approval.requiresAuthentication).toBe(false);
      // Never offered in chat: a channel has no token for it.
      expect(
        got.approval.surfaces.every((s) => ["desktop", "web", "notification"].includes(s)),
      ).toBe(true);
      const denied = (await member.request(method, params, ik())) as {
        ok: boolean;
        error: { code: string };
      };
      expect(denied.ok).toBe(false);
      expect(["approval_required", "presence_required"]).not.toContain(denied.error.code);
    },
  );
});

describe("payments and verifier enrolment keep presence", () => {
  it("a financial card requires authentication; a security-change tap does not", async () => {
    const { c } = await boot();
    const base = {
      summary: "x",
      details: {},
      requestedBy: { runId: null, taskId: null, threadId: null },
      surfaces: ["desktop"],
      taint: false,
    };
    const pay = await c.gateway.context.broker.requestApproval({
      ...base,
      kind: "purchase",
      bindingHash: `sha256:${"a".repeat(64)}`,
      grantKey: "pay",
      sideEffect: "financial",
    });
    expect(pay.approval.requiresAuthentication).toBe(true);
    const tap = await c.gateway.context.broker.requestApproval({
      ...base,
      kind: "policy_change",
      bindingHash: `sha256:${"b".repeat(64)}`,
      grantKey: "tap",
      sideEffect: "destructive",
    });
    expect(tap.approval.requiresAuthentication).toBe(false);
  });
});
