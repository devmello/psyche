import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countActivePasskeys, revokeDevice } from "@psyche/db";
import { presenceChallenge } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposedGateway,
  composeGateway,
  webauthnChallengeFor,
} from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

const ORIGIN = "https://psyche.example.test";
const RP_ID = "psyche.example.test";
let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(
  publicOrigin: string | null = ORIGIN,
): Promise<{ c: ComposedGateway; owner: TestClient }> {
  home = mkdtempSync(join(tmpdir(), "psyche-passkeys-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null, publicOrigin },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { c: composed, owner };
}

async function register(
  client: TestClient,
  auth: SoftAuthenticator,
  reauthWith?: SoftAuthenticator,
) {
  const begun = await client.call<{ ceremonyId: string; options: { challenge: string } }>(
    "passkeys.register.begin",
    {},
  );
  let reauth: { ceremonyId: string; response: unknown } | undefined;
  if (reauthWith) {
    const r = await client.call<{ ceremonyId: string; options: { challenge: string } }>(
      "passkeys.reauth.begin",
      {},
    );
    reauth = { ceremonyId: r.ceremonyId, response: reauthWith.get(r.options.challenge) };
  }
  return client.request(
    "passkeys.register.finish",
    {
      ceremonyId: begun.ceremonyId,
      response: auth.create(begun.options),
      name: "Laptop",
      ...(reauth ? { reauth } : {}),
    },
    ik(),
  );
}

describe("web passkeys (issue #79)", () => {
  it("is unavailable without an https publicOrigin", async () => {
    const { owner } = await setup(null);
    expect(await owner.request("passkeys.register.begin", {})).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("registers a first passkey, then needs re-authentication to add or remove one", async () => {
    const { owner } = await setup();
    const a = new SoftAuthenticator(RP_ID, ORIGIN);
    const first = await register(owner, a);
    expect(first).toMatchObject({
      ok: true,
      payload: { passkey: { name: "Laptop", backedUp: false } },
    });
    const list = await owner.call<{ passkeys: { id: string }[] }>("passkeys.list", {});
    expect(list.passkeys).toHaveLength(1);

    const b = new SoftAuthenticator(RP_ID, ORIGIN);
    expect(await register(owner, b)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    // A passkey for another site does not count as re-authentication.
    const stranger = new SoftAuthenticator("evil.example.test", "https://evil.example.test");
    expect(await register(owner, b, stranger)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await register(owner, b, a)).toMatchObject({ ok: true });

    const r = await owner.call<{ ceremonyId: string; options: { challenge: string } }>(
      "passkeys.reauth.begin",
      {},
    );
    const removed = await owner.request(
      "passkeys.remove",
      {
        passkeyId: list.passkeys[0]?.id,
        reauth: { ceremonyId: r.ceremonyId, response: b.get(r.options.challenge) },
      },
      ik(),
    );
    expect(removed).toMatchObject({ ok: true });
    expect((await owner.call<{ passkeys: unknown[] }>("passkeys.list", {})).passkeys).toHaveLength(
      1,
    );
  });

  it("rejects a registration made for another origin", async () => {
    const { owner } = await setup();
    const wrong = new SoftAuthenticator(RP_ID, "https://phish.example.test");
    expect(await register(owner, wrong)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("a passkey now makes security settings a tap, and answers a payment card with presence", async () => {
    const { c, owner } = await setup();
    // No verifier ready yet: the old rule (operator.admin) applies.
    expect(
      await owner.request("settings.set", { key: "permissions.mode", value: "manual" }, ik()),
    ).toMatchObject({ ok: true });

    const a = new SoftAuthenticator(RP_ID, ORIGIN);
    expect(await register(owner, a)).toMatchObject({ ok: true });
    // Now a passkey can verify: a security setting needs a card, but only a tap (presence is for
    // payments only).
    const first = await owner.request(
      "settings.set",
      { key: "permissions.mode", value: "balanced" },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const tapId = (first.error as { details: { approvalId: string } }).details.approvalId;
    expect(
      (
        await owner.call<{ approval: { requiresAuthentication: boolean } }>("approvals.get", {
          approvalId: tapId,
        })
      ).approval.requiresAuthentication,
    ).toBe(false);

    // A payment needs the passkey.
    const issued = await c.broker.requestApproval({
      kind: "purchase",
      summary: "Pay $5 to Example Shop",
      details: {},
      bindingHash: "d".repeat(64),
      grantKey: "d".repeat(64),
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "financial",
      surfaces: ["desktop", "web"],
      scopesOffered: ["once"],
      taint: false,
    });
    const approvalId = issued.approval.id;
    const got = await owner.call<{
      approval: { id: string; bindingHash: string; requiresAuthentication: boolean };
      answerToken?: string;
    }>("approvals.get", { approvalId });
    const approval = got.approval;
    const answerToken = got.answerToken ?? "";
    expect(approval.requiresAuthentication).toBe(true);
    expect(answerToken).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms

    const challenge = presenceChallenge(approval.id, approval.bindingHash, answerToken);
    // The 32 digest bytes, as a browser signs them (not an empty challenge from the prefix).
    expect(Buffer.from(webauthnChallengeFor(challenge), "base64url")).toHaveLength(32);
    const assertion = a.get(webauthnChallengeFor(challenge));
    const deviceId = (
      await owner.call<{ devices: { id: string; scopes: string[] }[] }>("devices.list", {})
    ).devices.find((d) => d.scopes.includes("operator.admin"))?.id as string;
    const presence = {
      kind: "webauthn",
      deviceId,
      signature: assertion.response.signature,
      payload: {
        credentialId: assertion.id,
        authenticatorData: assertion.response.authenticatorData,
        clientDataJSON: assertion.response.clientDataJSON,
      },
    };
    // An assertion over another challenge is refused.
    const wrong = a.get(webauthnChallengeFor("00".repeat(32)));
    const refused = await owner.request("approvals.answer", {
      approvalId,
      answerToken,
      decision: "approve",
      scope: "once",
      presence: {
        ...presence,
        signature: wrong.response.signature,
        payload: {
          ...presence.payload,
          clientDataJSON: wrong.response.clientDataJSON,
          authenticatorData: wrong.response.authenticatorData,
        },
      },
    });
    expect(refused.ok).toBe(false);

    const answered = await owner.request("approvals.answer", {
      approvalId,
      answerToken,
      decision: "approve",
      scope: "once",
      presence,
    });
    expect(answered).toMatchObject({ ok: true });
  });

  it("stops counting a revoked device's passkeys", async () => {
    const { c, owner } = await setup();
    expect(await register(owner, new SoftAuthenticator(RP_ID, ORIGIN))).toMatchObject({ ok: true });
    expect(countActivePasskeys(c.db)).toBe(1);
    const devices = await owner.call<{ devices: { id: string; scopes: string[] }[] }>(
      "devices.list",
      {},
    );
    const deviceId = devices.devices.find((d) => d.scopes.includes("operator.admin"))?.id as string;
    revokeDevice(c.db, deviceId);
    expect(countActivePasskeys(c.db)).toBe(0);
  });
});
