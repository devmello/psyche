import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway, webauthnChallengeFor } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

/**
 * Presence from a remote client (remote Gateway design §6.2, R2; owner decision G3): a risky card
 * needs a fresh passkey assertion from the answering device, bound to that device and that card;
 * an ordinary card needs none.
 */

const ORIGIN = "https://studio-mac.example.test";
const RP_ID = "studio-mac.example.test";
let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  known.clear();
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

interface Remote {
  client: TestClient;
  deviceId: string;
}

const known = new Set<string>();

async function remote(c: ComposedGateway): Promise<Remote> {
  const client = await adminClient(c.gateway);
  clients.push(client);
  const devices = await client.call<{ devices: { id: string }[] }>("devices.list", {});
  // adminClient names its device `admin-…`; the one not seen before is this client's.
  const mine = devices.devices.find((d) => d.id.startsWith("admin-") && !known.has(d.id));
  known.add((mine as { id: string }).id);
  return { client, deviceId: (mine as { id: string }).id };
}

async function registerPasskey(r: Remote, auth: SoftAuthenticator): Promise<void> {
  const begun = await r.client.call<{ ceremonyId: string; options: { challenge: string } }>(
    "passkeys.register.begin",
    {},
  );
  const res = await r.client.request(
    "passkeys.register.finish",
    { ceremonyId: begun.ceremonyId, response: auth.create(begun.options), name: "This Mac" },
    ik(),
  );
  expect(res).toMatchObject({ ok: true });
}

async function card(
  c: ComposedGateway,
  r: Remote,
  kind: "purchase" | "file_write",
  tag: string,
): Promise<{ approval: ApprovalRequest; token: string }> {
  const risky = kind === "purchase";
  const hash = tag.repeat(64).slice(0, 64);
  const issued = await c.gateway.context.broker.requestApproval({
    kind,
    summary: risky ? "Buy a flight" : "Write a note",
    details: {},
    bindingHash: hash,
    grantKey: hash,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: risky ? "financial" : "write",
    surfaces: ["desktop", "web"],
    scopesOffered: ["once"],
    taint: false,
  });
  const got = await r.client.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId: issued.approval.id },
  );
  await new Promise((res) => setTimeout(res, 450)); // cards arm after 400 ms
  return { approval: got.approval, token: got.answerToken ?? "" };
}

function assertion(auth: SoftAuthenticator, deviceId: string, c: { approval: ApprovalRequest; token: string }) {
  const challenge = presenceChallenge(c.approval.id, c.approval.bindingHash, c.token);
  const a = auth.get(webauthnChallengeFor(challenge));
  return {
    kind: "webauthn" as const,
    deviceId,
    signature: a.response.signature,
    payload: {
      credentialId: a.id,
      authenticatorData: a.response.authenticatorData,
      clientDataJSON: a.response.clientDataJSON,
    },
  };
}

const answer = (
  r: Remote,
  c: { approval: ApprovalRequest; token: string },
  presence?: ReturnType<typeof assertion>,
) =>
  r.client.request("approvals.answer", {
    approvalId: c.approval.id,
    answerToken: c.token,
    decision: "approve",
    scope: "once",
    ...(presence ? { presence } : {}),
  });

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-remote-presence-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: {
      home,
      port: 0,
      dbPath: join(home, "psyche.db"),
      webRoot: null,
      publicOrigin: ORIGIN,
    },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const withKey = await remote(composed);
  const authA = new SoftAuthenticator(RP_ID, ORIGIN);
  await registerPasskey(withKey, authA);
  const without = await remote(composed);
  return { c: composed, withKey, authA, without };
}

describe("presence from a remote client", () => {
  it("is not needed for an ordinary approval (G3)", async () => {
    const { c, without } = await setup();
    const ordinary = await card(c, without, "file_write", "a");
    expect(ordinary.approval.requiresAuthentication).toBe(false);
    expect(await answer(without, ordinary)).toMatchObject({ ok: true });
  });

  it("is refused for a risky approval from a device with no passkey, whatever it sends", async () => {
    const { c, withKey, authA, without } = await setup();
    const risky = await card(c, without, "purchase", "b");
    expect(risky.approval.requiresAuthentication).toBe(true);

    // Nothing at all.
    expect(await answer(without, risky)).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "presence_required" } },
    });
    // Another device's passkey, claimed as that device: the assertion names a device that is
    // not the one answering.
    expect(await answer(without, risky, assertion(authA, withKey.deviceId, risky))).toMatchObject({
      ok: false,
      error: { details: { reason: "presence_required" } },
    });
    // Another device's passkey, claimed as this one: the credential belongs to someone else.
    expect(await answer(without, risky, assertion(authA, without.deviceId, risky))).toMatchObject({
      ok: false,
      error: { details: { reason: "presence_invalid" } },
    });
    const still = await without.client.call<{ approval: ApprovalRequest }>("approvals.get", {
      approvalId: risky.approval.id,
    });
    expect(still.approval.status).toBe("pending");
  });

  it("is bound to the device and the approval, and cannot be replayed", async () => {
    const { c, withKey, authA } = await setup();
    const first = await card(c, withKey, "purchase", "c");
    const second = await card(c, withKey, "purchase", "d");
    const forFirst = assertion(authA, withKey.deviceId, first);

    // An assertion made for one card does not answer another.
    expect(await answer(withKey, second, forFirst)).toMatchObject({
      ok: false,
      error: { details: { reason: "presence_invalid" } },
    });
    // The right one answers its own card, once.
    expect(await answer(withKey, first, forFirst)).toMatchObject({ ok: true });
    expect(await answer(withKey, first, forFirst)).toMatchObject({ ok: false });
    // Nor does it carry over to a card issued later, with its own fresh token.
    const third = await card(c, withKey, "purchase", "e");
    expect(await answer(withKey, third, forFirst)).toMatchObject({
      ok: false,
      error: { details: { reason: "presence_invalid" } },
    });
    // A fresh assertion for the third card works.
    expect(await answer(withKey, third, assertion(authA, withKey.deviceId, third))).toMatchObject({
      ok: true,
    });
  });
});
