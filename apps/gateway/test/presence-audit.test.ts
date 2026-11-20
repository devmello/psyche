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
import { desktopClient, handshake, ik, newDeviceKey, TestClient, wsUrlOf } from "./helpers.ts";

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
const SCOPES = ["operator.read", "operator.write", "operator.approvals"] as const;

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
        got.approval.surfaces.every(
          (s) => ["desktop", "web", "notification"].includes(s) || s.startsWith("device:"),
        ),
      ).toBe(true);
      const denied = (await member.request(method, params, ik())) as {
        ok: boolean;
        error: { code: string };
      };
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("forbidden");
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

/** A paired iPhone: admin and approvals when `admin`, approvals only otherwise. */
async function phone(c: ComposedGateway, id: string, admin: boolean) {
  const key = newDeviceKey();
  (await desktopClient(c.gateway, key, id, "ios")).close();
  updateDevice(c.gateway.context.db, id, {
    scopes: admin ? [...SCOPES, "operator.admin"] : [...SCOPES],
  });
  const client = await TestClient.open(wsUrlOf(c.gateway));
  clients.push(client);
  await handshake(client, c.gateway.origin, { key, deviceId: id, platform: "ios" });
  return client;
}

type Got = { approval: ApprovalRequest; answerToken?: string };
const get = (who: TestClient, approvalId: string) => who.call<Got>("approvals.get", { approvalId });
const approvalIdOf = (res: unknown) =>
  (res as { error: { details: { approvalId: string } } }).error.details.approvalId;
const answer = (who: TestClient, approvalId: string, answerToken: string) =>
  who.request("approvals.answer", { approvalId, answerToken, decision: "approve" }, ik());
const armed = () => new Promise((r) => setTimeout(r, 450));
const requestedBy = { runId: null, taskId: null, threadId: null };

describe("a paired phone taps a device-only card with its own token", () => {
  it("settings.set: the phone approves with its token and the retry goes through, once", async () => {
    const { c, admin } = await boot();
    const p1 = await phone(c, "phone-1", true);
    const p2 = await phone(c, "phone-2", false);
    const call = { key: "permissions.policy", value: { allow: [] } };
    const res = await p1.request("settings.set", call, ik());
    expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = approvalIdOf(res);
    const mine = await get(p1, approvalId);
    const other = await get(p2, approvalId);
    const desk = await get(admin, approvalId);
    // Each device has its own token; no shared per-platform surface; no chat surface.
    expect(mine.answerToken).toBeDefined();
    expect(other.answerToken).toBeDefined();
    expect(desk.answerToken).toBeDefined();
    expect(new Set([mine.answerToken, other.answerToken, desk.answerToken]).size).toBe(3);
    expect(mine.approval.surfaces).toEqual(
      expect.arrayContaining(["desktop", "web", "device:phone-1", "device:phone-2"]),
    );
    expect(mine.approval.surfaces.some((s) => s.startsWith("telegram"))).toBe(false);
    expect(mine.approval).toMatchObject({ deviceOnly: true, requiresAuthentication: false });
    await armed();
    // Another phone's token is refused when presented by this phone.
    expect(await answer(p1, approvalId, other.answerToken ?? "")).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await answer(p1, approvalId, mine.answerToken ?? "")).toMatchObject({ ok: true });
    expect(await p1.request("settings.set", { ...call, approvalId }, ik())).toMatchObject({
      ok: true,
    });
    // Consumed once.
    expect(await p1.request("settings.set", { ...call, approvalId }, ik())).toMatchObject({
      ok: false,
    });
  });

  it("exec_host (destructive): a phone approves; the chat surface is stripped", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    const issued = await c.gateway.context.broker.requestApproval({
      kind: "exec_host",
      summary: "rm",
      details: {},
      requestedBy,
      surfaces: ["desktop", "notification", "telegram:42"],
      taint: false,
      bindingHash: `sha256:${"c".repeat(64)}`,
      grantKey: "x",
      sideEffect: "destructive",
    });
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.surfaces).toContain("device:phone-1");
    expect(mine.approval.surfaces).not.toContain("telegram:42");
    await armed();
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: true });
  });

  it("a payment is not offered to the phone, and answering it without presence is refused", async () => {
    const { c, admin } = await boot();
    const p1 = await phone(c, "phone-1", true);
    const issued = await c.gateway.context.broker.requestApproval({
      kind: "purchase",
      summary: "pay",
      details: {},
      requestedBy,
      surfaces: ["desktop", "notification"],
      taint: false,
      bindingHash: `sha256:${"d".repeat(64)}`,
      grantKey: "pay",
      sideEffect: "financial",
    });
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.requiresAuthentication).toBe(true);
    expect(mine.approval.surfaces.some((s) => s.startsWith("device:"))).toBe(false);
    expect(mine.answerToken).toBeUndefined();
    // The desktop's own token, with no presence assertion: the Gateway refuses.
    const desk = await get(admin, id);
    await armed();
    expect(await answer(admin, id, desk.answerToken ?? "")).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "presence_required" } },
    });
  });

  it("the desktop's card surfaces and token are unchanged when no phone is paired", async () => {
    const { admin } = await boot();
    const res = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { allow: [] } },
      ik(),
    );
    const got = await get(admin, approvalIdOf(res));
    expect(got.approval.surfaces).toEqual(["desktop", "web", "notification"]);
    expect(got.answerToken).toBeDefined();
  });
});

describe("a tap on the desktop approves the card without presence", () => {
  it("answer with the desktop token, retry with the approvalId once", async () => {
    const { admin } = await boot();
    const call = { key: "permissions.policy", value: { allow: [] } };
    const approvalId = approvalIdOf(await admin.request("settings.set", call, ik()));
    const got = await get(admin, approvalId);
    await armed();
    expect(await answer(admin, approvalId, got.answerToken ?? "")).toMatchObject({ ok: true });
    expect(await admin.request("settings.set", { ...call, approvalId }, ik())).toMatchObject({
      ok: true,
    });
    expect(await admin.request("settings.set", { ...call, approvalId }, ik())).toMatchObject({
      ok: false,
    });
  });
});

describe("which cards a phone gets a token for", () => {
  const card = (
    c: ComposedGateway,
    over: {
      kind: "script_run" | "send_message";
      surfaces: string[];
      sideEffect: "write" | "destructive";
    },
    n: string,
  ) =>
    c.gateway.context.broker.requestApproval({
      kind: over.kind,
      summary: "x",
      details: {},
      requestedBy,
      surfaces: over.surfaces,
      taint: false,
      bindingHash: `sha256:${n.repeat(64)}`,
      grantKey: n,
      sideEffect: over.sideEffect,
    });

  it("a card its caller kept on the desktop (a script) gets no phone surface or token", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    const issued = await card(
      c,
      { kind: "script_run", surfaces: ["desktop"], sideEffect: "destructive" },
      "e",
    );
    const mine = await get(p1, issued.approval.id);
    expect(mine.approval.surfaces).toEqual(["desktop"]);
    expect(mine.answerToken).toBeUndefined();
  });

  it("a routine write card offered to the notification surface is answerable once from the phone", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    const issued = await card(
      c,
      { kind: "send_message", surfaces: ["desktop", "notification"], sideEffect: "write" },
      "f",
    );
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.deviceOnly).toBe(false);
    expect(mine.approval.surfaces).toContain("device:phone-1");
    expect(mine.answerToken).toBeDefined();
    await armed();
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: true });
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: false });
  });

  it("a phone paired after the card was raised gets no token for it", async () => {
    const { c } = await boot();
    const issued = await card(
      c,
      { kind: "send_message", surfaces: ["desktop", "notification"], sideEffect: "write" },
      "9",
    );
    const late = await phone(c, "phone-late", false);
    const mine = await get(late, issued.approval.id);
    expect(mine.answerToken).toBeUndefined();
  });
});
