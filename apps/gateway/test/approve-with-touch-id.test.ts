import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper, helperPresenceMessage } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Allow in the desktop window on a card that needs Touch ID (security §3.7): the Gateway asks the
 * helper to sign the presence challenge for the window's own answer token, and the broker checks
 * it against the registered key exactly as for a notification answer. When the helper is down,
 * too old or has no key, the error names that reason so the card can offer the fix.
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(() => reset());

function enclaveKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    publicKey: x963.toString("base64url"),
    keyId: createHash("sha256").update(x963).digest("hex"),
    privateKey,
  };
}

function signChallenge(privateKey: KeyObject, challenge: string): string {
  return sign("sha256", helperPresenceMessage(challenge), {
    key: privateKey,
    dsaEncoding: "der",
  }).toString("base64url");
}

type Confirm = (p: { challenge: string; header: string }) => unknown;

function helperHandlers(key: ReturnType<typeof enclaveKey>, confirm?: Confirm): FakeNodeHandler[] {
  return [
    {
      capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
      run: () => ({ publicKey: key.publicKey, keyId: key.keyId }),
    },
    ...(confirm === undefined
      ? []
      : [
          {
            capability: {
              name: "presence.confirm",
              sideEffect: "write" as const,
              streaming: false,
            },
            run: (params: unknown) => confirm(params as { challenge: string; header: string }),
          },
        ]),
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
  ];
}

async function setup(opts: { helper?: boolean; confirm?: Confirm; register?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), "psyche-touchid-"));
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
  const key = enclaveKey();
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  if (opts.helper !== false) {
    const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
      origin: composed.gateway.origin,
      secret: composed.gateway.handshakeSecret,
      handlers: helperHandlers(key, opts.confirm),
      deviceId: helperDevice,
    });
    nodes.push(node);
    await vi.waitFor(() =>
      expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    if (opts.register !== false) {
      await admin.call("devices.presenceKey.register", { deviceId: helperDevice }, ik());
    }
  }
  return { c: composed, admin, key, helperDevice };
}

/** A presence-gated change: a `policy_change` card that requires authentication. */
async function securityCard(admin: TestClient) {
  const first = await admin.request(
    "settings.set",
    { key: "permissions.policy", value: { allow: [] } },
    ik(),
  );
  const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  return { approval: got.approval, token: got.answerToken ?? "" };
}

/** A card that requires authentication whether or not presence is enrolled yet. */
async function authCard(c: ComposedGateway, admin: TestClient) {
  const issued = await c.gateway.context.broker.requestApproval({
    kind: "policy_change",
    summary: "Change a security setting",
    details: {},
    bindingHash: "b".repeat(64),
    grantKey: "b".repeat(64),
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "destructive",
    surfaces: ["desktop", "web"],
    scopesOffered: ["once"],
    taint: false,
  });
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId: issued.approval.id },
  );
  return { approval: got.approval, token: got.answerToken ?? "" };
}

async function reset(): Promise<void> {
  for (const cl of clients.splice(0)) cl.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
}

describe("approvals.approveWithTouchId (window Allow on a Touch ID card)", () => {
  it("the helper signs the window's own challenge after Touch ID and the broker approves", async () => {
    const asked: { challenge: string; header: string }[] = [];
    const holder: { key?: ReturnType<typeof enclaveKey> } = {};
    const { c, admin, helperDevice, key } = await setup({
      confirm: (p) => {
        asked.push(p);
        const k = holder.key as ReturnType<typeof enclaveKey>;
        return { signature: signChallenge(k.privateKey, p.challenge), keyId: k.keyId };
      },
    });
    holder.key = key;
    const { approval, token } = await securityCard(admin);
    expect(approval.requiresAuthentication).toBe(true);
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(res.approval.status).toBe("approved");
    // Same challenge format as web passkeys, for this window's token; the header is the card's.
    expect(asked).toEqual([
      {
        challenge: presenceChallenge(approval.id, approval.bindingHash, token),
        header: expect.any(String),
      },
    ]);
    expect(res.approval.decidedBy).toMatchObject({ deviceId: helperDevice, surface: "desktop" });
    expect((await c.audit.query({ kind: "approval.touch_id_from_window" }))[0]?.data).toMatchObject(
      { approvalId: approval.id, helperDeviceId: helperDevice, keyId: key.keyId },
    );
  });

  it("a signature by any other key is refused by the broker", async () => {
    const other = enclaveKey();
    const { admin } = await setup({
      confirm: (p) => ({
        signature: signChallenge(other.privateKey, p.challenge),
        keyId: other.keyId,
      }),
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "presence_invalid" } },
    });
  });

  it("names why it cannot run: no helper, an old helper, no registered key", async () => {
    const reasonOf = async (opts: Parameters<typeof setup>[0]) => {
      const { c, admin } = await setup(opts);
      const card = await authCard(c, admin);
      const r = await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: card.approval.id, answerToken: card.token },
        ik(),
      );
      await reset();
      return (r as { error?: unknown }).error;
    };
    expect(await reasonOf({ helper: false })).toMatchObject({
      code: "unavailable",
      details: { reason: "helper_offline" },
    });
    expect(await reasonOf({})).toMatchObject({
      code: "unavailable",
      details: { reason: "helper_outdated" },
    });
    expect(await reasonOf({ confirm: () => ({ signature: "x" }), register: false })).toMatchObject({
      code: "unavailable",
      details: { reason: "no_presence_key" },
    });
  });

  it("a helper without a keychain access group says so", async () => {
    const { admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("missing entitlement"), {
          code: "unavailable",
          details: { reason: "missing_entitlement" },
        });
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "presence_key_unavailable" } },
    });
  });

  it("a cancelled Touch ID leaves the card pending", async () => {
    const { admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("The user cancelled authentication"), {
          code: "cancelled",
        });
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(
      (
        await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
          approvalId: approval.id,
        })
      ).approval.status,
    ).toBe("pending");
  });

  it("nodes.invoke can never reach presence.*", async () => {
    const { admin, c } = await setup({ confirm: () => ({ signature: "x" }) });
    const node = c.gateway.context.nodes.list()[0];
    for (const capability of ["presence.confirm", "presence.public_key"]) {
      expect(
        await admin.request(
          "nodes.invoke",
          { nodeId: node?.id, capability, params: { challenge: "0".repeat(64), header: "x" } },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });
});
