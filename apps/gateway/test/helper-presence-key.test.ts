import { createHash, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeDevice } from "@psyche/db";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper, helperPresenceMessage } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { HelperPresenceKeys } from "../src/compose/presence-keys.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * A Mac helper needs no registered presence key: it signs with its own Ed25519 device key, the one
 * the Gateway pinned when it paired. Owner-sheet answers from that helper verify against it; a
 * signature by any other key, or over any other challenge, is refused; revoking the helper revokes
 * its key. The challenge the helper is given is the bare 64-hex digest.
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

/** The helper's Ed25519 device key signing the presence message, as the Swift helper does. */
function signChallenge(privateKey: KeyObject, challenge: string): string {
  return sign(null, helperPresenceMessage(challenge), privateKey).toString("base64url");
}

/** A helper with the notification capabilities (no `presence.public_key` is ever needed). */
function helperHandlers() {
  const shown: Record<string, unknown>[] = [];
  let respond: ((data: unknown) => void) | undefined;
  const handlers: FakeNodeHandler[] = [
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
      run: (_params, emit) => {
        respond = emit;
        return new Promise(() => undefined);
      },
    },
  ];
  return { handlers, shown, respond: (data: unknown) => respond?.(data) };
}

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-helper-key-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeHelper(s)],
  });
  const admin = await adminClient(composed.gateway);
  clients.push(admin);
  const key = newDeviceKey();
  const h = helperHandlers();
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
    origin: composed.gateway.origin,
    secret: composed.gateway.handshakeSecret,
    handlers: h.handlers,
    deviceId: helperDevice,
    key,
  });
  nodes.push(node);
  await vi.waitFor(() =>
    expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
  );
  return { c: composed, admin, key, h, helperDevice };
}

let cardN = 0;

/** A card that needs presence: a payment (presence is for payments only). Returns its id. */
async function securityCard(_admin: TestClient): Promise<string> {
  if (composed === null) throw new Error("no gateway");
  const hash = `${(++cardN).toString(16).padStart(2, "0")}${"c".repeat(62)}`;
  const issued = await composed.broker.requestApproval({
    kind: "purchase",
    summary: "Pay $5 to Example Shop",
    details: {},
    bindingHash: hash,
    grantKey: hash,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "financial",
    surfaces: ["desktop", "notification"],
    taint: false,
  });
  expect(issued.approval.requiresAuthentication).toBe(true);
  return issued.approval.id;
}

describe("a Mac helper's device key is its presence key", () => {
  it("needs no registration: the Gateway lists the device key, and a signed owner-sheet answer approves, a wrong one does not", async () => {
    const { c, admin, key, h, helperDevice } = await setup();
    // Nothing was registered, yet the device's own key is listed.
    const listed = await admin.call<{ presenceKeys: Record<string, unknown>[] }>(
      "devices.presenceKey.list",
      {},
    );
    expect(listed.presenceKeys).toEqual([
      {
        deviceId: helperDevice,
        keyId: createHash("sha256").update(Buffer.from(key.publicKey, "base64url")).digest("hex"),
        registeredAt: expect.any(String),
        kind: "device_identity",
        algorithm: "ed25519",
      },
    ]);
    // There is nothing to register.
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: "0".repeat(64) },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { reason: "no_key_needed" } },
    });
    expect(await c.audit.query({ kind: "presence_key.registered" })).toHaveLength(0);

    // A payment needs presence; the card reaches the helper with a challenge.
    const approvalId = await securityCard(admin);
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(approvalId));
    const challenge = h.shown.find((s) => s.id === approvalId)?.presenceChallenge as string;
    // The bare 64-hex digest: the helper (and WebAuthn) refuse anything else.
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    await new Promise((r) => setTimeout(r, 450)); // past the arm delay

    const status = async () =>
      (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId })).approval
        .status;
    const answer = (signature: string) =>
      h.respond({
        type: "notify.response",
        notificationId: approvalId,
        actionId: "approve",
        authenticated: true,
        presence: { signature },
      });
    // Another key, a signature over another challenge, and junk: refused, still pending.
    answer(signChallenge(newDeviceKey().privateKey, challenge));
    answer(signChallenge(key.privateKey, "0".repeat(64)));
    answer("AAAA");
    await new Promise((r) => setTimeout(r, 250));
    expect(await status()).toBe("pending");
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).map((e) => e.data.reason),
    ).toContain("presence_invalid");

    answer(signChallenge(key.privateKey, challenge));
    await vi.waitFor(async () => expect(await status()).toBe("approved"));
  });

  it("a cancelled owner sheet is not an answer: the card stays pending and nothing is counted", async () => {
    const { c, admin, key, h } = await setup();
    const approvalId = await securityCard(admin);
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(approvalId));
    const challenge = h.shown.find((s) => s.id === approvalId)?.presenceChallenge as string;
    await new Promise((r) => setTimeout(r, 450));
    const status = async () =>
      (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId })).approval
        .status;
    // Cancel, many more times than the answer cap: authenticated false, and no signature.
    for (let i = 0; i < 30; i++) {
      h.respond({
        type: "notify.response",
        notificationId: approvalId,
        actionId: "approve",
        authenticated: false,
      });
    }
    // An authenticated flag with no signature is no better.
    h.respond({
      type: "notify.response",
      notificationId: approvalId,
      actionId: "approve",
      authenticated: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await status()).toBe("pending");
    expect(await c.audit.query({ kind: "approval.answer_rejected" })).toHaveLength(0);

    // Not rate limited by the cancels: the real answer still goes through.
    h.respond({
      type: "notify.response",
      notificationId: approvalId,
      actionId: "approve",
      authenticated: true,
      presence: { signature: signChallenge(key.privateKey, challenge) },
    });
    await vi.waitFor(async () => expect(await status()).toBe("approved"));
  });

  it("Deny needs no presence", async () => {
    const { admin, h } = await setup();
    const approvalId = await securityCard(admin);
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(approvalId));
    await new Promise((r) => setTimeout(r, 450));
    h.respond({ type: "notify.response", notificationId: approvalId, actionId: "deny" });
    await vi.waitFor(async () =>
      expect(
        (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId })).approval
          .status,
      ).toBe("denied"),
    );
  });

  it("the Approve button asks for no system unlock (the owner sheet is the helper's, once), and only a presence card carries a challenge", async () => {
    const { c, h } = await setup();
    // A purchase is a presence card whose text fits a notification.
    const buy = await c.broker.requestApproval({
      kind: "purchase",
      summary: "Buy a desk",
      details: { item: "desk" },
      bindingHash: `sha256:${"a".repeat(64)}`,
      grantKey: "mac|desk",
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "financial",
      surfaces: ["desktop", "notification"],
      taint: false,
    });
    expect(buy.approval.requiresAuthentication).toBe(true);
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(buy.approval.id));
    const card = h.shown.find((s) => s.id === buy.approval.id) as {
      requireBiometry: boolean;
      presenceChallenge?: string;
      actions: { id: string; authenticationRequired: boolean }[];
    };
    expect(card.requireBiometry).toBe(true);
    expect(card.presenceChallenge).toMatch(/^[0-9a-f]{64}$/);
    expect(card.actions.map((a) => a.id)).toEqual(["approve", "deny"]);
    expect(card.actions.every((a) => a.authenticationRequired === false)).toBe(true);

    // A card that needs no presence: no biometry flag, no challenge.
    const plain = await c.broker.requestApproval({
      kind: "send_email",
      summary: "Send a short note",
      details: {},
      bindingHash: `sha256:${"d".repeat(64)}`,
      grantKey: "mail|note",
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "write",
      surfaces: ["desktop", "notification"],
      taint: false,
    });
    expect(plain.approval.requiresAuthentication).toBe(false);
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(plain.approval.id));
    const quiet = h.shown.find((s) => s.id === plain.approval.id) as Record<string, unknown>;
    expect(quiet.requireBiometry).toBe(false);
    expect(quiet).not.toHaveProperty("presenceChallenge");
  });

  it("a tap on the helper's card tells the desktop which route to open", async () => {
    const { c, admin, h } = await setup();
    const frames: string[] = [];
    c.gateway.context.bus.subscribe(["operator.read", "operator.admin"], (f) => frames.push(f));
    const approvalId = await securityCard(admin);
    await vi.waitFor(() => expect(h.shown.map((x) => x.id)).toContain(approvalId));
    h.respond({ type: "notify.response", notificationId: approvalId, actionId: "default" });
    await vi.waitFor(() => expect(frames.join("\n")).toContain("notification.opened"));
    const opened = frames.map((f) => JSON.parse(f)).find((f) => f.event === "notification.opened");
    // A payment from no chat opens the approvals sheet.
    expect(opened.payload).toEqual({ notificationId: approvalId, route: "/agent/approvals" });
    // The tap decides nothing.
    expect(
      (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId })).approval
        .status,
    ).toBe("pending");
  });

  it("revoking the helper revokes its key", async () => {
    const { c, admin, key, helperDevice } = await setup();
    const keys = new HelperPresenceKeys(c.gateway.context.db);
    expect(keys.get(helperDevice)).toBe(key.publicKey);
    // Presence is enrolled as soon as a gated security change asks (a plain tap card now).
    const tap = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { allow: [] } },
      ik(),
    );
    expect(tap).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const tapId = (tap as { error: { details: { approvalId: string } } }).error.details.approvalId;
    expect(
      (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId: tapId }))
        .approval.requiresAuthentication,
    ).toBe(false);

    revokeDevice(c.gateway.context.db, helperDevice);
    expect(keys.get(helperDevice)).toBeUndefined();
    expect(await admin.call("devices.presenceKey.list", {})).toEqual({ presenceKeys: [] });
    // With the only verifier gone, a plain security change is still one tap, not `presence_required`.
    expect(
      await admin.request(
        "settings.set",
        { key: "permissions.policy", value: { allow: [] } },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("an unknown or disconnected device cannot register", async () => {
    const { admin } = await setup();
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { deviceId: "no-such-helper", expectKeyId: "0".repeat(64) },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
