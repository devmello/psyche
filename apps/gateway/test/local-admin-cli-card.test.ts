import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * B2 review r1: with a presence verifier, the Host CLI's `devices.setupToken.create` and
 * `settings.set gateway.lan` answer `approval_required` (a plain-tap card). The CLI path must
 * return the card, succeed on the retry with its `approvalId`, and need the Host secret throughout.
 */

const publicOrigin = "https://lab-box.tail1234.ts.net";
const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};
const ADMIN: string[] = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];

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

async function boot() {
  home = mkdtempSync(join(tmpdir(), "psyche-b2-card-"));
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
      publicOrigin,
      allowedOrigins: [publicOrigin],
    },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    presence: touchId,
  });
  const gateway = composed.gateway as TestGateway["gateway"];
  // The owner's phone: a desktop device that can tap approvals.
  const phone = await desktopClient(gateway, newDeviceKey(), "phone-1");
  clients.push(phone);
  return { gateway, phone };
}

/** The Host CLI: paired once as the CLI pairs, approved by the owner, then connects with `secret`. */
async function hostCli(gateway: TestGateway["gateway"], secret: string | undefined) {
  const key = newDeviceKey();
  const deviceId = `cli-${Math.random().toString(36).slice(2)}`;
  const first = await TestClient.open(wsUrlOf(gateway));
  await handshake(first, gateway.origin, { key, deviceId, deviceFamily: "cli" });
  first.close();
  updateDevice(gateway.context.db, deviceId, {
    scopes: ADMIN as never,
    pairedAt: new Date().toISOString(),
  });
  const c = await TestClient.open(wsUrlOf(gateway));
  clients.push(c);
  await handshake(c, gateway.origin, {
    key,
    deviceId,
    deviceFamily: "cli",
    ...(secret === undefined ? {} : { handshakeSecret: secret }),
  });
  return c;
}

async function tap(phone: TestClient, approvalId: string) {
  const got = await phone.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: false });
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  expect(
    await phone.request(
      "approvals.answer",
      { approvalId, answerToken: got.answerToken ?? "", decision: "approve" },
      ik(),
    ),
  ).toMatchObject({ ok: true });
}

const idOf = (res: Record<string, unknown>) =>
  (res as { error: { details: { approvalId: string } } }).error.details.approvalId;

describe("the Host CLI with a presence verifier", () => {
  it("gets approval_required, then makes the link on the retry after a tap", async () => {
    const { gateway, phone } = await boot();
    const cli = await hostCli(gateway, gateway.handshakeSecret);
    const params = { scopes: ["operator.read", "operator.write"] };
    const first = await cli.request("devices.setupToken.create", params);
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    await tap(phone, idOf(first));
    const made = await cli.request("devices.setupToken.create", {
      ...params,
      approvalId: idOf(first),
    });
    expect(made).toMatchObject({ ok: true });
    expect((made.payload as { link: string }).link).toMatch(/^psyche-pair:v1:/);
  });

  it("gets approval_required for gateway.lan and applies it on the retry", async () => {
    const { gateway, phone } = await boot();
    const cli = await hostCli(gateway, gateway.handshakeSecret);
    const params = { key: "gateway.lan", value: { enabled: false, interfaces: [] } };
    const first = await cli.request("settings.set", params, ik());
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    await tap(phone, idOf(first));
    expect(
      await cli.request("settings.set", { ...params, approvalId: idOf(first) }, ik()),
    ).toMatchObject({ ok: true });
  });

  it("a card tapped for one device cannot be spent by the CLI", async () => {
    const { gateway, phone } = await boot();
    const other = await hostCli(gateway, gateway.handshakeSecret);
    const cli = await hostCli(gateway, gateway.handshakeSecret);
    const params = { scopes: ["operator.read"] };
    const first = await other.request("devices.setupToken.create", params);
    await tap(phone, idOf(first));
    expect(
      await cli.request("devices.setupToken.create", { ...params, approvalId: idOf(first) }),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
  });
});

describe("the Host secret is required even on loopback", () => {
  it("refuses a CLI with no secret or a wrong one, even after the owner taps the card", async () => {
    const { gateway, phone } = await boot();
    const params = { scopes: ["operator.read"] };
    for (const secret of [undefined, "not-the-secret", `${gateway.handshakeSecret}x`]) {
      const cli = await hostCli(gateway, secret);
      // The presence gate runs before the handler, so a card may be raised; spending it still
      // gets nothing, and no link exists afterwards.
      const first = await cli.request("devices.setupToken.create", params);
      if (first.ok !== true && (first.error as { code: string }).code === "approval_required") {
        await tap(phone, idOf(first));
        expect(
          await cli.request("devices.setupToken.create", { ...params, approvalId: idOf(first) }),
        ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      } else {
        expect(first).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
    }
    expect(
      gateway.context.db.sqlite.prepare("SELECT count(*) AS n FROM setup_tokens").get(),
    ).toMatchObject({ n: 0 });
  });
});
