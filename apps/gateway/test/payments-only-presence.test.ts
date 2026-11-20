import { type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDevices } from "@psyche/db";
import type { ApprovalKind, ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper, helperPresenceMessage } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Presence (the Mac owner sheet, a passkey, the Linux password) is for payments only (owner's
 * decision, 2026-11-09). Every other approval is a tap on its card: no presence assertion, no
 * `presence.confirm` to the helper, no challenge in the notification. A payment still needs it,
 * and so does enrolling a presence verifier (otherwise a stolen admin device could add its own
 * authenticator and approve payments with it).
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const sig = (key: KeyObject, challenge: string) =>
  sign(null, helperPresenceMessage(challenge), key).toString("base64url");

/**
 * `enroll`: the owner has deliberately enrolled a presence verifier (as a passkey would), so the
 * gate is "ready". A paired Mac helper alone never does that (see bootstrap-admin test).
 */
async function setup(opts: { enroll?: boolean } = {}) {
  const enrolled = new Set<string>();
  let macKey: string | undefined;
  let macDevice = "";
  home = mkdtempSync(join(tmpdir(), "psyche-payments-only-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) =>
        composeHelper(
          s,
          opts.enroll === true
            ? {
                presenceKeys: (id) =>
                  id === macDevice ? macKey : enrolled.has(id) ? "registered-key" : undefined,
              }
            : {},
        ),
    ],
  });
  const admin = await adminClient(composed.gateway);
  clients.push(admin);
  for (const d of listDevices(composed.gateway.context.db)) enrolled.add(d.id);
  const key = newDeviceKey();
  macKey = key.publicKey;
  const shown: Record<string, unknown>[] = [];
  const confirms: { challenge: string }[] = [];
  let respond: ((data: unknown) => void) | undefined;
  const handlers: FakeNodeHandler[] = [
    {
      capability: { name: "presence.confirm", sideEffect: "write", streaming: false },
      run: (params) => {
        const p = params as { challenge: string };
        confirms.push(p);
        return { signature: sig(key.privateKey, p.challenge), keyId: "k" };
      },
    },
    {
      capability: { name: "notify.show", sideEffect: "write", streaming: false },
      run: (params) => {
        shown.push(params as Record<string, unknown>);
        return { shown: true };
      },
    },
    {
      capability: { name: "notify.withdraw", sideEffect: "write", streaming: false },
      run: () => ({ withdrawn: true }),
    },
    {
      capability: { name: "notify.subscribe", sideEffect: "read", streaming: true },
      run: (_p, emit) => {
        respond = emit;
        return new Promise(() => undefined);
      },
    },
  ];
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  macDevice = helperDevice;
  const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
    origin: composed.gateway.origin,
    secret: composed.gateway.handshakeSecret,
    handlers,
    deviceId: helperDevice,
    key,
  });
  nodes.push(node);
  await vi.waitFor(() =>
    expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
  );
  return {
    c: composed,
    admin,
    key,
    shown,
    confirms,
    respond: (d: unknown) => respond?.(d),
  };
}

let n = 0;
async function card(
  c: ComposedGateway,
  admin: TestClient,
  kind: ApprovalKind,
  sideEffect: "write" | "destructive" | "financial",
) {
  const hash = `${(++n).toString(16).padStart(2, "0")}${"e".repeat(62)}`;
  const issued = await c.gateway.context.broker.requestApproval({
    kind,
    summary: `a ${kind}`,
    details: {},
    bindingHash: hash,
    grantKey: hash,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect,
    surfaces: ["desktop", "web", "notification"],
    scopesOffered: ["once"],
    taint: false,
  });
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId: issued.approval.id },
  );
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  return { approval: got.approval, token: got.answerToken ?? "" };
}

const answer = (admin: TestClient, a: { approval: ApprovalRequest; token: string }) =>
  admin.request(
    "approvals.answer",
    { approvalId: a.approval.id, answerToken: a.token, decision: "approve", scope: "once" },
    ik(),
  );

describe("a tap approves everything that is not a payment", () => {
  it("credential fills, host commands and security settings: approvals.answer with no presence, no sheet", async () => {
    const { admin, confirms, shown } = await setup({ enroll: true });
    for (const [kind, se] of [
      ["credential_fill", "write"],
      ["exec_host", "destructive"],
      ["apple_script", "destructive"],
    ] as const) {
      const a = await card(composed as ComposedGateway, admin, kind, se);
      expect(a.approval.requiresAuthentication, kind).toBe(false);
      expect(await answer(admin, a), kind).toMatchObject({ ok: true });
    }
    // A security setting, once a verifier was enrolled: the change needs a card, and the card is a
    // tap.
    const first = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { allow: [] } },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
      "approvals.get",
      { approvalId },
    );
    expect(got.approval.requiresAuthentication).toBe(false);
    await new Promise((r) => setTimeout(r, 450));
    expect(
      await answer(admin, { approval: got.approval, token: got.answerToken ?? "" }),
    ).toMatchObject({ ok: true });
    expect(
      await admin.request(
        "settings.set",
        { key: "permissions.policy", value: { allow: [] }, approvalId },
        ik(),
      ),
    ).toMatchObject({ ok: true });
    // The helper was never asked for a sheet, and no card carried a presence challenge.
    expect(confirms).toHaveLength(0);
    for (const s of shown) {
      expect(s.requireBiometry).toBeFalsy();
      expect(s).not.toHaveProperty("presenceChallenge");
    }
  });

  it("the notification Approve (no authenticated flag, no signature) approves a non-payment card", async () => {
    const { admin, shown, respond } = await setup();
    const a = await card(composed as ComposedGateway, admin, "credential_fill", "write");
    await vi.waitFor(() => expect(shown.map((s) => s.id)).toContain(a.approval.id));
    const notice = shown.find((s) => s.id === a.approval.id) as Record<string, unknown>;
    expect(notice.requireBiometry).toBeFalsy();
    expect(notice).not.toHaveProperty("presenceChallenge");
    // A former presence kind still needs an unlocked Mac (nothing approved from a lock screen).
    const approve = (notice.actions as { id: string; authenticationRequired: boolean }[]).find(
      (x) => x.id === "approve",
    );
    expect(approve?.authenticationRequired).toBe(true);
    respond({ type: "notify.response", notificationId: a.approval.id, actionId: "approve" });
    await vi.waitFor(async () =>
      expect(
        (
          await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
            approvalId: a.approval.id,
          })
        ).approval.status,
      ).toBe("approved"),
    );
  });

  it("approvals.approveWithTouchId on a non-payment card fails invalid_params: it needs no presence", async () => {
    const { admin, confirms } = await setup();
    const a = await card(composed as ComposedGateway, admin, "exec_host", "destructive");
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: a.approval.id, answerToken: a.token },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(confirms).toHaveLength(0);
  });
});

describe("a payment still needs presence", () => {
  it("approvals.answer without an assertion is refused; the owner sheet from the window approves it", async () => {
    const { admin, confirms } = await setup();
    const pay = await card(composed as ComposedGateway, admin, "purchase", "financial");
    expect(pay.approval.requiresAuthentication).toBe(true);
    expect(await answer(admin, pay)).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "presence_required" } },
    });
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: pay.approval.id, answerToken: pay.token },
      ik(),
    );
    expect(res.approval.status).toBe("approved");
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the notification Approve needs the helper's signature for a payment", async () => {
    const { admin, key, shown, respond } = await setup();
    const pay = await card(composed as ComposedGateway, admin, "purchase", "financial");
    await vi.waitFor(() => expect(shown.map((s) => s.id)).toContain(pay.approval.id));
    const notice = shown.find((s) => s.id === pay.approval.id) as Record<string, unknown>;
    expect(notice.requireBiometry).toBe(true);
    // The payment's one prompt is the helper's owner sheet, not macOS's unlock requirement.
    const approveAction = (
      notice.actions as { id: string; authenticationRequired: boolean }[]
    ).find((x) => x.id === "approve");
    expect(approveAction?.authenticationRequired).toBe(false);
    const challenge = notice.presenceChallenge as string;
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    const status = async () =>
      (
        await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
          approvalId: pay.approval.id,
        })
      ).approval.status;
    // No signature: not an answer.
    respond({ type: "notify.response", notificationId: pay.approval.id, actionId: "approve" });
    await new Promise((r) => setTimeout(r, 250));
    expect(await status()).toBe("pending");
    respond({
      type: "notify.response",
      notificationId: pay.approval.id,
      actionId: "approve",
      authenticated: true,
      presence: { signature: sig(key.privateKey, challenge) },
    });
    await vi.waitFor(async () => expect(await status()).toBe("approved"));
  });
});

describe("enrolling a presence verifier still needs presence", () => {
  it("a device's first passkey raises a card that requires presence, and a bare tap is refused", async () => {
    const { c } = await setup({ enroll: true });
    const phone = await desktopClient(c.gateway, newDeviceKey(), "phone-enroll");
    clients.push(phone);
    const first = await phone.request(
      "passkeys.register.finish",
      { ceremonyId: "cer_x", response: {} },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await phone.call<{ approval: ApprovalRequest; answerToken?: string }>(
      "approvals.get",
      { approvalId },
    );
    expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: true });
    await new Promise((r) => setTimeout(r, 450));
    expect(
      await phone.request(
        "approvals.answer",
        {
          approvalId,
          answerToken: got.answerToken ?? "",
          decision: "approve",
          scope: "once",
        },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { details: { reason: "presence_required" } } });
  });
});
