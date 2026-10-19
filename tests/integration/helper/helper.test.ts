import { createHash } from "node:crypto";
import { composeHelper, HELPER_SURFACE } from "@psyche/gateway/compose";
import { presenceChallenge } from "@psyche/permissions";
import type { ApprovalKind, IssuedApproval, SideEffect } from "@psyche/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ComposeServices } from "../../../apps/gateway/src/compose/services.ts";
import { type PartsSkeleton, startWithParts } from "../google/harness.ts";
import { MAIN, ScriptedModel, UTILITY } from "../walking-skeleton/scripted-model.ts";
import { FakeHelper, newPresenceKey, type PresenceKey } from "./fake-helper.ts";

/**
 * INT-2 follow-up (security §3.7, design-04), CI-safe: approvals that require authentication answered
 * with Touch ID through the Mac helper. A composed Gateway mounts the helper part; a fake helper
 * pairs over the real node socket, receives the card as `notify.show` and answers with
 * `notify.response` events on the `notify.subscribe` the Gateway holds open. The owner has
 * registered the helper's presence key (the registration path itself is S01/S14 work).
 */

const registered = new Map<string, string>();
let sk: PartsSkeleton;
let services: ComposeServices;
let helper: FakeHelper | undefined;
let n = 0;

beforeAll(async () => {
  sk = await startWithParts({
    model: { provider: new ScriptedModel(), model: MAIN, utilityModel: UTILITY },
    parts: [
      (s) => {
        services = s;
        return composeHelper(s, { presenceKeys: (deviceId) => registered.get(deviceId) });
      },
    ],
  });
});

afterAll(async () => {
  await sk?.stop();
});

afterEach(async () => {
  await helper?.close();
  helper = undefined;
  registered.clear();
});

async function connectHelper(opts: { register?: boolean; presence?: PresenceKey } = {}) {
  const { gateway } = sk.composed;
  const h = await FakeHelper.connect(gateway.config.nodeSocketPath, {
    origin: gateway.origin,
    secret: gateway.handshakeSecret,
    ...(opts.presence === undefined ? {} : { presence: opts.presence }),
  });
  if (opts.register !== false) registered.set(h.deviceId, h.presence.publicKey);
  await h.subscribed();
  return h;
}

/** What the agent loop does for an `ask`: an approval for the in-app surfaces (relays add theirs). */
function request(
  kind: ApprovalKind = "purchase",
  sideEffect: SideEffect = "financial",
  details: Record<string, string> = { item: "desk", total: "$120" },
): Promise<IssuedApproval> {
  n += 1;
  return services.broker.requestApproval({
    kind,
    summary: `${kind} ${n}`,
    details,
    bindingHash: `sha256:${createHash("sha256").update(`${kind}|${n}`).digest("hex")}`,
    grantKey: `int3|${kind}|${n}`,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect,
    surfaces: ["desktop", "web"],
    taint: false,
  });
}

const status = async (id: string) => (await sk.composed.broker.get(id))?.status;
/** The card arms after a short delay; an earlier answer is refused (docs/06 approval card). */
const armed = () => new Promise((r) => setTimeout(r, 450));
/** Answers travel helper → Gateway → broker asynchronously. */
const settled = () => new Promise((r) => setTimeout(r, 150));

async function lastRejection(approvalId: string): Promise<string | undefined> {
  const entries = await sk.composed.audit.list({ kind: "approval.answer_rejected" });
  const hit = entries.filter((e) => e.subject?.approvalId === approvalId).at(-1);
  return (hit?.data as { reason?: string } | undefined)?.reason;
}

describe("Touch ID approvals through the Mac helper", () => {
  it("without a helper, presence approvals stay refused and deny works (fail closed)", async () => {
    const issued = await request();
    expect(issued.approval.requiresAuthentication).toBe(true);
    expect(issued.approval.surfaces).not.toContain(HELPER_SURFACE);
    const answerToken = issued.answerTokens.desktop;
    await armed();
    await expect(
      sk.client.call("approvals.answer", {
        approvalId: issued.approval.id,
        answerToken,
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await status(issued.approval.id)).toBe("pending");
    await sk.client.call("approvals.answer", {
      approvalId: issued.approval.id,
      answerToken,
      decision: "deny",
    });
    expect(await status(issued.approval.id)).toBe("denied");
  });

  it("relays the card with Approve / Deny, Touch ID and the presence challenge; the token stays home", async () => {
    helper = await connectHelper();
    const issued = await request();
    const a = issued.approval;
    expect(a.surfaces).toContain(HELPER_SURFACE);
    const card = await helper.card(a.id);
    const token = issued.answerTokens[HELPER_SURFACE] as string;
    expect(card).toMatchObject({
      id: a.id,
      category: "approval",
      approvalId: a.id,
      requireBiometry: true,
      interruptionLevel: "timeSensitive",
      presenceChallenge: presenceChallenge(a.id, a.bindingHash, token),
      actions: [
        { id: "approve", authenticationRequired: true, destructive: false },
        { id: "deny", destructive: true },
      ],
    });
    expect(card.title).toBe("Pay · financial");
    expect(JSON.stringify(card)).not.toContain(token);
  });

  it("refuses an approve without a presence assertion (the M1 helper's boolean only)", async () => {
    helper = await connectHelper();
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "approve", unsigned: true });
    await settled();
    expect(await status(approval.id)).toBe("pending");
    expect(await lastRejection(approval.id)).toBe("presence_required");
  });

  it("refuses an approve when Touch ID failed, even if the helper signed", async () => {
    helper = await connectHelper();
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "approve", touchId: false });
    await settled();
    expect(await status(approval.id)).toBe("pending");
    expect(await lastRejection(approval.id)).toBe("presence_required");
  });

  it("approves with a valid assertion from the helper and withdraws the banner", async () => {
    helper = await connectHelper();
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "approve" });
    await settled();
    const decided = await sk.composed.broker.get(approval.id);
    expect(decided).toMatchObject({
      status: "approved",
      scopeGranted: "once",
      decidedBy: { deviceId: helper.deviceId, surface: HELPER_SURFACE },
    });
    expect(helper.withdrawn).toContain(approval.id);
  });

  it("refuses an assertion made for another approval", async () => {
    helper = await connectHelper();
    const first = await request();
    const second = await request();
    const other = (await helper.card(first.approval.id)).presenceChallenge as string;
    await armed();
    await helper.tap(second.approval.id, { actionId: "approve", challenge: other });
    await settled();
    expect(await status(second.approval.id)).toBe("pending");
    expect(await lastRejection(second.approval.id)).toBe("presence_invalid");
  });

  it("refuses an assertion signed by another device's key", async () => {
    helper = await connectHelper();
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "approve", key: newPresenceKey() });
    await settled();
    expect(await status(approval.id)).toBe("pending");
    expect(await lastRejection(approval.id)).toBe("presence_invalid");
  });

  it("refuses a valid signature from a helper whose key the owner never registered", async () => {
    helper = await connectHelper({ register: false });
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "approve" });
    await settled();
    expect(await status(approval.id)).toBe("pending");
    expect(await lastRejection(approval.id)).toBe("presence_invalid");
  });

  it("ignores answers from a helper the card was not sent to", async () => {
    const first = await connectHelper();
    helper = await connectHelper();
    const { approval } = await request();
    // The card goes to the most recent helper; the other one cannot answer it.
    await helper.card(approval.id);
    expect(first.shown.some((s) => s.approvalId === approval.id)).toBe(false);
    first.shown.push(await helper.card(approval.id));
    await armed();
    await first.tap(approval.id, { actionId: "deny" });
    await settled();
    expect(await status(approval.id)).toBe("pending");
    await first.close();
  });

  it("deny always works from the notification, without Touch ID", async () => {
    helper = await connectHelper({ register: false });
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "deny" });
    await settled();
    expect(await sk.composed.broker.get(approval.id)).toMatchObject({
      status: "denied",
      decidedBy: { deviceId: helper.deviceId, surface: HELPER_SURFACE },
    });
  });

  it("a tap on the banner or a dismissal decides nothing", async () => {
    helper = await connectHelper();
    const { approval } = await request();
    await armed();
    await helper.tap(approval.id, { actionId: "default" });
    await helper.tap(approval.id, { actionId: "dismiss" });
    await settled();
    expect(await status(approval.id)).toBe("pending");
  });

  it("an approval without authentication is answered from the notification as on the desktop", async () => {
    helper = await connectHelper({ register: false });
    const { approval } = await request("connector_action", "write", { action: "save draft" });
    expect(approval.requiresAuthentication).toBe(false);
    const card = await helper.card(approval.id);
    expect(card.requireBiometry).toBe(false);
    expect(card.presenceChallenge).toBeUndefined();
    await armed();
    await helper.tap(approval.id, { actionId: "approve" });
    await settled();
    expect(await status(approval.id)).toBe("approved");
  });

  it("a card too long for a notification offers Deny only (design-12: never approve a cut card)", async () => {
    helper = await connectHelper();
    const { approval } = await request("purchase", "financial", {
      item: "x".repeat(300),
      total: "$120",
    });
    const card = await helper.card(approval.id);
    expect((card.actions as { id: string }[]).map((x) => x.id)).toEqual(["deny"]);
    expect(card.body).toMatch(/Open Psyche/);
  });

  it("a desktop approve of a presence kind is still refused while a helper is connected", async () => {
    helper = await connectHelper();
    const issued = await request();
    await armed();
    await expect(
      sk.client.call("approvals.answer", {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop,
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await status(issued.approval.id)).toBe("pending");
  });
});
