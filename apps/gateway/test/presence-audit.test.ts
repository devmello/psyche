import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode } from "./fake-node.ts";
import { desktopClient, handshake, ik, newDeviceKey, TestClient, wsUrlOf } from "./helpers.ts";

/**
 * The presence audit (owner's decision, 2026-11-09: presence is for payments only). Every gated
 * non-payment method, on a Gateway whose presence was enrolled and then lost (the strictest
 * state for a non-payment change): the owner's admin device gets a plain card (no
 * `presence_required`, `requiresAuthentication` false); a non-admin device is refused; the card
 * is never offered on a chat surface; and a payment card still requires authentication.
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const n of nodes.splice(0)) n.close();
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
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
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
          (s) => ["desktop", "offMac", "notification"].includes(s) || s.startsWith("device:"),
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
  it("settings.set (policy change): the card stays on the Mac, and the retry goes through once", async () => {
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
    // A policy change is never answered from a phone (PHONE_NEVER_KINDS): no phone token, no
    // phone surface, no chat surface. The Mac has its own token.
    expect(mine.answerToken).toBeUndefined();
    expect(other.answerToken).toBeUndefined();
    expect(desk.answerToken).toBeDefined();
    expect(mine.approval.surfaces.some((s) => s.startsWith("device:"))).toBe(false);
    expect(mine.approval.surfaces.some((s) => s.startsWith("oldchat"))).toBe(false);
    await armed();
    // The Mac's token presented by a phone is refused.
    expect(await answer(p1, approvalId, desk.answerToken ?? "")).toMatchObject({ ok: false });
    expect(await answer(admin, approvalId, desk.answerToken ?? "")).toMatchObject({ ok: true });
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
      surfaces: ["desktop", "notification", "oldchat:42"],
      taint: false,
      bindingHash: `sha256:${"c".repeat(64)}`,
      grantKey: "x",
      sideEffect: "destructive",
    });
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.surfaces).toContain("device:phone-1");
    expect(mine.approval.surfaces).not.toContain("oldchat:42");
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
    expect(got.approval.surfaces).toEqual(["desktop", "offMac", "notification"]);
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

/**
 * The Mac helper, connected the way it is on a default Mac: it relays every card to the
 * `notification` surface (compose/helper.ts), which must not count as the caller's own choice.
 */
async function connectMacHelper(c: ComposedGateway) {
  const key = newDeviceKey();
  const node = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceId: "audit-helper",
    key,
    handlers: [
      {
        capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
        run: () => ({
          publicKey: key.publicKey,
          keyId: "k",
          kind: "device_identity",
          algorithm: "ed25519",
        }),
      },
      {
        capability: { name: "notify.show", sideEffect: "write", streaming: false },
        run: () => ({ shown: true }),
      },
      {
        capability: { name: "notify.withdraw", sideEffect: "write", streaming: false },
        run: () => ({ withdrawn: true }),
      },
      {
        capability: { name: "notify.subscribe", sideEffect: "read", streaming: true },
        run: () => new Promise(() => undefined),
      },
    ],
  });
  nodes.push(node);
  await vi.waitFor(() =>
    expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
  );
}

describe("which cards a phone gets a token for", () => {
  type Over = {
    kind: "skill_install" | "calendar_write";
    surfaces: readonly string[];
    sideEffect: "write" | "destructive";
  };
  const card = (c: ComposedGateway, over: Over, n: string) =>
    c.gateway.context.broker.requestApproval({
      kind: over.kind,
      summary: "x",
      details: {},
      requestedBy,
      surfaces: [...over.surfaces],
      taint: false,
      bindingHash: `sha256:${n.repeat(64)}`,
      grantKey: n,
      sideEffect: over.sideEffect,
    });
  // A script or install card (scripts.ts, skills.ts, capabilities.ts): its caller keeps it on the Mac.
  const script: Over = { kind: "skill_install", surfaces: ["desktop"], sideEffect: "destructive" };
  const routine: Over = {
    kind: "calendar_write",
    surfaces: ["desktop", "notification"],
    sideEffect: "write",
  };
  const noDevice = (surfaces: readonly string[]) =>
    expect(surfaces.some((s) => s.startsWith("device:"))).toBe(false);

  it("a card its caller kept on the desktop (a script) gets no phone surface or token", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    const issued = await card(c, script, "e");
    const mine = await get(p1, issued.approval.id);
    expect(mine.approval.surfaces).toEqual(["desktop"]);
    expect(mine.answerToken).toBeUndefined();
  });

  it("with the Mac helper connected, a desktop-only script card stays off the phone and the phone's answer is refused", async () => {
    const { c, admin } = await boot();
    const p1 = await phone(c, "phone-1", false);
    await connectMacHelper(c);
    const issued = await card(c, script, "a");
    const id = issued.approval.id;
    const mine = await get(p1, id);
    // The helper relay added its own surface; the phone still gets none.
    expect(mine.approval.surfaces).toContain("notification");
    noDevice(mine.approval.surfaces);
    expect(mine.answerToken).toBeUndefined();
    await armed();
    // Neither a made-up token nor the desktop's own token answers it from the phone.
    const deskToken = (await get(admin, id)).answerToken;
    expect(deskToken).toBeDefined();
    for (const token of ["at_made_up", deskToken ?? ""]) {
      expect(await answer(p1, id, token)).toMatchObject({ ok: false });
    }
    expect((await get(admin, id)).approval.status).toBe("pending");
    // A restart re-issues it from the stored input: still decided on the caller's own surfaces.
    const again = (await c.gateway.context.broker.reissue()).find(
      (i) => i.approval.bindingHash === issued.approval.bindingHash,
    );
    expect(again).toBeDefined();
    noDevice(again?.approval.surfaces ?? []);
  });

  it("with the Mac helper connected, a routine card offered to the notification surface still gets a phone token", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    await connectMacHelper(c);
    const issued = await card(c, routine, "b");
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.surfaces).toContain("device:phone-1");
    expect(mine.answerToken).toBeDefined();
    await armed();
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: true });
    // Re-issued after a restart, a routine card still reaches the phone.
    const next = await card(c, routine, "8");
    const again = (await c.gateway.context.broker.reissue()).find(
      (i) => i.approval.bindingHash === next.approval.bindingHash,
    );
    expect(again?.approval.surfaces).toContain("device:phone-1");
  });

  it("with the Mac helper connected, a payment offered everywhere gets no phone surface", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", true);
    await connectMacHelper(c);
    const issued = await c.gateway.context.broker.requestApproval({
      kind: "purchase",
      summary: "pay",
      details: {},
      requestedBy,
      surfaces: ["desktop", "notification", "offMac"],
      taint: false,
      bindingHash: `sha256:${"7".repeat(64)}`,
      grantKey: "pay",
      sideEffect: "financial",
    });
    const mine = await get(p1, issued.approval.id);
    noDevice(mine.approval.surfaces);
    expect(mine.answerToken).toBeUndefined();
  });

  it("a routine write card offered to the notification surface is answerable once from the phone", async () => {
    const { c } = await boot();
    const p1 = await phone(c, "phone-1", false);
    const issued = await card(c, routine, "f");
    const id = issued.approval.id;
    const mine = await get(p1, id);
    expect(mine.approval.deviceOnly).toBe(false);
    expect(mine.approval.surfaces).toContain("device:phone-1");
    expect(mine.answerToken).toBeDefined();
    await armed();
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: true });
    expect(await answer(p1, id, mine.answerToken ?? "")).toMatchObject({ ok: false });
  });

  // `web` is what a card raised before the rename stored (browser access was dropped,
  // 2026-11-25): it is the same marker as `offMac`, also after a restart re-issues it.
  it.each(["offMac", "web"])(
    "a routine card marked %s gets a phone token, answerable once, also after reissue()",
    async (marker) => {
      const { c } = await boot();
      const p1 = await phone(c, "phone-1", false);
      await connectMacHelper(c);
      const over: Over = { ...routine, surfaces: ["desktop", marker] };
      const issued = await card(c, over, "c");
      const mine = await get(p1, issued.approval.id);
      expect(mine.approval.surfaces).toContain("device:phone-1");
      expect(mine.answerToken).toBeDefined();
      await armed();
      expect(await answer(p1, issued.approval.id, mine.answerToken ?? "")).toMatchObject({
        ok: true,
      });
      // Re-issued after a restart, the same card still reaches the phone.
      const next = await card(c, over, "d");
      const again = (await c.gateway.context.broker.reissue()).find(
        (i) => i.approval.bindingHash === next.approval.bindingHash,
      );
      expect(again?.approval.surfaces).toContain("device:phone-1");
      expect(Object.keys(again?.answerTokens ?? {})).toContain("device:phone-1");
    },
  );

  it("a phone paired after the card was raised gets no token for it", async () => {
    const { c } = await boot();
    const issued = await card(c, routine, "9");
    const late = await phone(c, "phone-late", false);
    const mine = await get(late, issued.approval.id);
    expect(mine.answerToken).toBeUndefined();
  });
});
