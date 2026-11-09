import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting } from "@psyche/db";
import { approvalCode, presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalNotificationCard,
  composeHelper,
  helperErrorFields,
  helperPresenceMessage,
} from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { PRESENCE_REMOVED_SETTING } from "../src/compose/presence-keys.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import {
  adminClient,
  type DeviceKey,
  ik,
  newDeviceKey,
  type TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Allow in the desktop window on a card that needs presence (security §3.7): the Gateway asks the
 * helper to show the system's owner sheet and sign the presence challenge for the window's own
 * answer token, and the broker checks it against the helper's key exactly as for a notification
 * answer. A Mac helper signs with its own Ed25519 device key (nothing to register); a Windows
 * helper with its registered Windows Hello key. When the helper is down or too old, the error names
 * that reason so the card can offer the fix; a cancelled sheet is a quiet "not approved".
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(() => reset());

/** A Windows Hello stand-in: RSA-2048, SPKI DER public key. */
function helloKey() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: der.toString("base64url"),
    keyId: createHash("sha256").update(der).digest("hex"),
    privateKey,
  };
}

type Signer = { sign(challenge: string): string; keyId: string };

/** The Mac helper's Ed25519 device key signing the presence message. */
function macSigner(key: DeviceKey): Signer {
  return {
    sign: (challenge) =>
      sign(null, helperPresenceMessage(challenge), key.privateKey).toString("base64url"),
    keyId: createHash("sha256").update(Buffer.from(key.publicKey, "base64url")).digest("hex"),
  };
}

function helloSigner(key: ReturnType<typeof helloKey>): Signer {
  return {
    sign: (challenge) =>
      sign("sha256", helperPresenceMessage(challenge), {
        key: key.privateKey,
        padding: constants.RSA_PKCS1_PADDING,
      }).toString("base64url"),
    keyId: key.keyId,
  };
}

type Confirm = (p: { challenge: string; summary: string; code: string }) => unknown;

/** What the fake helper reports for `presence.public_key` (a Windows one registers it). */
type Reported = { publicKey: string; keyId: string; kind?: string; algorithm?: string };

/** A different Windows Hello key the fake helper reports from now on (a reset made a new one). */
let helperKeyOverride: ReturnType<typeof helloKey> | undefined;

function helperHandlers(reported: Reported, confirm?: Confirm): FakeNodeHandler[] {
  return [
    {
      capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
      run: () => {
        const k = helperKeyOverride;
        return k === undefined ? reported : { ...reported, publicKey: k.publicKey, keyId: k.keyId };
      },
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
            run: (params: unknown) =>
              confirm(params as { challenge: string; summary: string; code: string }),
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

/** The Mac helper's report: its own device key, as `presence.public_key` now says. */
function macReport(key: DeviceKey): Reported {
  return {
    publicKey: key.publicKey,
    keyId: macSigner(key).keyId,
    kind: "device_identity",
    algorithm: "ed25519",
  };
}

async function setup(
  opts: {
    helper?: boolean;
    confirm?: Confirm;
    /** Windows only: register the helper's Windows Hello key (default true). A Mac has none. */
    register?: boolean;
    family?: "mac-helper" | "win-helper";
    /** The Mac helper's device key, when the test signs with it. */
    key?: DeviceKey;
    /** Windows: the `kind` the helper reports for its key (`""` leaves it out). */
    reportKind?: string;
  } = {},
) {
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
  const windows = opts.family === "win-helper";
  const deviceKey = opts.key ?? newDeviceKey();
  const hello = helloKey();
  const reported: Reported = windows
    ? {
        publicKey: hello.publicKey,
        keyId: hello.keyId,
        ...(opts.reportKind === "" ? {} : { kind: opts.reportKind ?? "windows_hello" }),
        algorithm: "rsa-2048-pkcs1-sha256",
      }
    : macReport(deviceKey);
  const key = windows ? helloSigner(hello) : macSigner(deviceKey);
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  if (opts.helper !== false) {
    const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
      origin: composed.gateway.origin,
      secret: composed.gateway.handshakeSecret,
      handlers: helperHandlers(reported, opts.confirm),
      deviceId: helperDevice,
      key: deviceKey,
      ...(opts.family === undefined ? {} : { deviceFamily: opts.family }),
    });
    nodes.push(node);
    await vi.waitFor(() =>
      expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    if (windows && opts.register !== false) {
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: hello.keyId },
        ik(),
      );
    }
  }
  return { c: composed, admin, key, deviceKey, hello, helperDevice };
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
  helperKeyOverride = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
}

describe("approvals.approveWithTouchId (window Allow on a Touch ID card)", () => {
  it("the helper shows the owner sheet and signs the window's own challenge, and the broker approves", async () => {
    const asked: { challenge: string; summary: string; code: string }[] = [];
    const dk = newDeviceKey();
    const signer = macSigner(dk);
    const { c, admin, helperDevice } = await setup({
      key: dk,
      confirm: (p) => {
        asked.push(p);
        return { signature: signer.sign(p.challenge), keyId: signer.keyId };
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(approval.requiresAuthentication).toBe(true);
    // No key was ever registered for this Mac helper.
    expect(await c.audit.query({ kind: "presence_key.registered" })).toHaveLength(0);
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(res.approval.status).toBe("approved");
    // The bare 64-hex digest (what the Swift helper and WebAuthn accept), for this window's
    // token; the sheet names the card's summary and code.
    expect(asked).toEqual([
      {
        challenge: presenceChallenge(approval.id, approval.bindingHash, token),
        summary: approval.summary,
        code: approvalCode(approval.bindingHash),
      },
    ]);
    expect(asked[0]?.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(res.approval.decidedBy).toMatchObject({ deviceId: helperDevice, surface: "desktop" });
    expect((await c.audit.query({ kind: "approval.touch_id_from_window" }))[0]?.data).toMatchObject(
      { approvalId: approval.id, helperDeviceId: helperDevice, keyId: signer.keyId },
    );
  });
  it("a signature by any other key, or over any other challenge, is refused by the broker", async () => {
    const other = macSigner(newDeviceKey());
    const dk = newDeviceKey();
    const mine = macSigner(dk);
    for (const wrong of [
      (challenge: string) => other.sign(challenge),
      () => mine.sign("0".repeat(64)),
    ]) {
      const { admin } = await setup({
        key: dk,
        confirm: (p) => ({ signature: wrong(p.challenge), keyId: mine.keyId }),
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
      expect(
        (
          await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
            approvalId: approval.id,
          })
        ).approval.status,
      ).toBe("pending");
      await reset();
    }
  }, 20_000);
  it("names why it cannot run: no helper, an old helper, no registered Windows Hello key", async () => {
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
    // A PC's Windows Hello key must be registered first; a Mac needs no key at all.
    expect(
      await reasonOf({
        confirm: () => ({ signature: "x" }),
        family: "win-helper",
        register: false,
      }),
    ).toMatchObject({
      code: "unavailable",
      details: { reason: "no_presence_key" },
    });
  }, 30_000);
  it("names the helper's own presence check: Touch ID on a Mac, Windows Hello on a PC", async () => {
    const messageOf = async (opts: Parameters<typeof setup>[0]) => {
      const { c, admin } = await setup(opts);
      const card = await authCard(c, admin);
      await new Promise((r) => setTimeout(r, 450)); // past the arm delay
      const r = await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: card.approval.id, answerToken: card.token },
        ik(),
      );
      await reset();
      return (r as { error?: { message?: string } }).error?.message;
    };
    const confirm = () => ({ signature: "x" });
    expect(await messageOf({ confirm, register: false, family: "win-helper" })).toBe(
      "Windows Hello is not set up for approvals: register the helper's Windows Hello key first",
    );
    const cancelled = () => {
      throw Object.assign(new Error(""), { code: "cancelled" });
    };
    expect(await messageOf({ confirm: cancelled, family: "win-helper" })).toBe(
      "Windows Hello was cancelled",
    );
    expect(await messageOf({ confirm: cancelled })).toBe("Touch ID was cancelled");
    // Three Gateways in one case: give a loaded machine the time.
  }, 30_000);
  it("a long card's notification sends the owner to their Mac or PC", () => {
    const long = {
      kind: "policy_change",
      summary: "x".repeat(4000),
      sideEffect: "destructive",
      taint: false,
      details: { note: "y".repeat(4000) },
    } as unknown as ApprovalRequest;
    expect(approvalNotificationCard(long, hostWords("mac-helper"))).toMatchObject({
      body: "Open Psyche on your Mac to review.",
      approvable: false,
    });
    expect(approvalNotificationCard(long, hostWords("win-helper"))).toMatchObject({
      body: "Open Psyche on your PC to review.",
      approvable: false,
    });
  });

  it("a helper that cannot ask the owner says so", async () => {
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
  it("a cancelled sheet is a quiet not-approved: the card stays pending and nothing is counted", async () => {
    const dk = newDeviceKey();
    const signer = macSigner(dk);
    let cancel = true;
    const { c, admin } = await setup({
      key: dk,
      confirm: (p) => {
        if (cancel) {
          throw Object.assign(new Error("The user cancelled authentication"), {
            code: "cancelled",
            details: { reason: "user_cancelled" },
          });
        }
        return { signature: signer.sign(p.challenge), keyId: signer.keyId };
      },
    });
    const { approval, token } = await securityCard(admin);
    const ask = () =>
      admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      );
    // Far more cancels than the answer cap allows: never rate limited, never audited as rejected.
    for (let i = 0; i < 25; i++) {
      expect(await ask()).toMatchObject({
        ok: false,
        error: { code: "cancelled", details: { reason: "presence_cancelled" } },
      });
    }
    expect(await c.audit.query({ kind: "approval.answer_rejected" })).toHaveLength(0);
    expect(
      (
        await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
          approvalId: approval.id,
        })
      ).approval.status,
    ).toBe("pending");
    // The owner tries again and this time passes the sheet: it still approves.
    cancel = false;
    expect(await ask()).toMatchObject({ ok: true, payload: { approval: { status: "approved" } } });
  }, 30_000);

  it("a helper already showing a sheet is busy, not a failure", async () => {
    const { c, admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("busy"), {
          code: "unavailable",
          details: { reason: "presence_busy" },
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
      error: { code: "unavailable", details: { reason: "presence_busy" } },
    });
    expect(await c.audit.query({ kind: "approval.answer_rejected" })).toHaveLength(0);
  });
  it("nodes.invoke can never reach presence.*", async () => {
    const { admin, c } = await setup({ confirm: () => ({ signature: "x" }) });
    const node = c.gateway.context.nodes.list()[0];
    for (const capability of ["presence.confirm", "presence.public_key"]) {
      expect(
        await admin.request(
          "nodes.invoke",
          {
            nodeId: node?.id,
            capability,
            params: { challenge: "0".repeat(64), summary: "x", code: "0000-0000" },
          },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });

  it("lists a Mac helper's device key with nothing registered, and a Windows Hello key as registered", async () => {
    const { admin, helperDevice, key } = await setup();
    expect(await admin.call("devices.presenceKey.list", {})).toMatchObject({
      presenceKeys: [
        { deviceId: helperDevice, keyId: key.keyId, kind: "device_identity", algorithm: "ed25519" },
      ],
    });
    await reset();
    const win = await setup({ family: "win-helper" });
    expect(await win.admin.call("devices.presenceKey.list", {})).toMatchObject({
      presenceKeys: [
        {
          deviceId: win.helperDevice,
          keyId: win.key.keyId,
          kind: "windows_hello",
          algorithm: "rsa-2048-pkcs1-sha256",
        },
      ],
    });
  });
  it("checks the window's token before any Touch ID sheet", async () => {
    let asked = 0;
    const { c, admin } = await setup({
      confirm: () => {
        asked++;
        return { signature: "x" };
      },
    });
    const { approval } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: "not-this-windows-token" },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(asked).toBe(0);
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).map((e) => e.data.reason),
    ).toContain("unknown_token");
  });

  it("raises one sheet at a time, whatever the card", async () => {
    let release: (v: unknown) => void = () => undefined;
    const { admin } = await setup({
      confirm: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const first = await securityCard(admin);
    const pending = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: first.approval.id, answerToken: first.token },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 100));
    const second = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { deny: [] } },
      ik(),
    );
    const secondId = (second as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ answerToken?: string }>("approvals.get", {
      approvalId: secondId,
    });
    await new Promise((r) => setTimeout(r, 450));
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: secondId, answerToken: got.answerToken ?? "" },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    release({ signature: "x" });
    await pending;
  });

  it("two calls at the same moment raise one sheet (the guard is taken before the precheck)", async () => {
    let asked = 0;
    let release: (v: unknown) => void = () => undefined;
    const { admin } = await setup({
      confirm: () => {
        asked++;
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const first = await securityCard(admin);
    const second = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { deny: [] } },
      ik(),
    );
    const secondId = (second as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ answerToken?: string }>("approvals.get", {
      approvalId: secondId,
    });
    await new Promise((r) => setTimeout(r, 450));
    // Both sent before either is answered: no await between them.
    const a = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: first.approval.id, answerToken: first.token },
      ik(),
    );
    const b = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: secondId, answerToken: got.answerToken ?? "" },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(asked).toBe(1);
    release({ signature: "x" });
    const results = await Promise.all([a, b]);
    expect(
      results.filter((r) => (r as { error?: { code?: string } }).error?.code === "conflict"),
    ).toHaveLength(1);
    expect(asked).toBe(1);
  });

  it("a failed sheet counts as a rejected answer", async () => {
    const { c, admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("Touch ID did not match"), {
          code: "forbidden",
          details: { reason: "authentication_failed" },
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
      error: { code: "forbidden", details: { reason: "touch_id_failed" } },
    });
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).map((e) => e.data.reason),
    ).toContain("presence_failed");
  });
  it("approves once only and refuses UNSANDBOXED (neither is in the signed challenge)", async () => {
    let asked = 0;
    const dk = newDeviceKey();
    const signer = macSigner(dk);
    const { admin } = await setup({
      key: dk,
      confirm: (p) => {
        asked++;
        return { signature: signer.sign(p.challenge), keyId: signer.keyId };
      },
    });
    const { approval, token } = await securityCard(admin);
    for (const extra of [{ scope: "always" }, { unsandboxed: "UNSANDBOXED" }]) {
      expect(
        await admin.request(
          "approvals.approveWithTouchId",
          { approvalId: approval.id, answerToken: token, ...extra },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
    expect(asked).toBe(0);
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token, scope: "once" },
      ik(),
    );
    expect(res.approval.scopeGranted).toBe("once");
  });
  it("asks only the helper the desktop launched (helperDeviceId)", async () => {
    let asked = 0;
    const { admin } = await setup({
      confirm: () => {
        asked++;
        return { signature: "x" };
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token, helperDeviceId: "dev_someone_else" },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "helper_offline" } },
    });
    expect(asked).toBe(0);
  });

  it("a Mac helper has no key to register", async () => {
    const { admin, helperDevice, key } = await setup();
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict", details: { reason: "no_key_needed" } },
    });
  });

  it("a Windows helper registers only a Windows Hello key: any other kind is refused", async () => {
    // The retired Mac key locations, an unknown kind and a missing one.
    for (const reportKind of ["keychain", "enclave_keychain_acl", "enclave_file", "other", ""]) {
      const w = await setup({ family: "win-helper", register: false, reportKind });
      expect(
        await w.admin.request(
          "devices.presenceKey.register",
          { deviceId: w.helperDevice, expectKeyId: w.hello.keyId },
          ik(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "forbidden", details: { reason: "key_kind_mismatch" } },
      });
      expect(await w.admin.call("devices.presenceKey.list", {})).toEqual({ presenceKeys: [] });
      await reset();
    }
  }, 30_000);

  it("a registration that replaces a different key says REPLACE on the card and names the old key", async () => {
    const { admin, helperDevice, key } = await setup({
      family: "win-helper",
      confirm: () => ({ signature: "x", keyId: "x" }),
    });
    const other = helloKey();
    helperKeyOverride = other; // the helper now shows a different key
    const first = await admin.request(
      "devices.presenceKey.register",
      { deviceId: helperDevice, expectKeyId: other.keyId },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId });
    expect(got.approval.summary).toContain("REPLACE");
    expect(got.approval.details).toMatchObject({ replacesKeyId: key.keyId, keyId: other.keyId });
    // The same key again is a plain registration, not a replacement.
    helperKeyOverride = undefined;
    const same = await admin.request(
      "devices.presenceKey.register",
      { deviceId: helperDevice, expectKeyId: key.keyId },
      ik(),
    );
    const sameId = (same as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const plain = await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
      approvalId: sameId,
    });
    expect(plain.approval.summary).not.toContain("REPLACE");
    expect(plain.approval.details).not.toHaveProperty("replacesKeyId");
  });

  it("Remove is audited with who asked and remembered, so a later Register still says it replaces", async () => {
    const { c, admin, helperDevice, key } = await setup({ family: "win-helper" });
    expect(
      await admin.call("devices.presenceKey.remove", { deviceId: helperDevice }, ik()),
    ).toEqual({
      removed: true,
    });
    const removed = (await c.audit.query({ kind: "presence_key.removed" }))[0];
    expect(removed?.data).toMatchObject({ deviceId: helperDevice, keyId: key.keyId });
    expect(removed?.actor).toMatchObject({ type: "device" });
    const record = JSON.stringify(
      getSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING)?.value,
    );
    expect(record).toContain(key.keyId);
  });

  it("with no presence card possible, replacing a forgotten key needs the owner to name it", async () => {
    const { c, admin, helperDevice, key } = await setup({ family: "win-helper", register: false });
    const forgotten = "a".repeat(64);
    setSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING, {
      [helperDevice]: { previousKeyId: forgotten, previousKind: "windows_hello", removedAt: "x" },
    });
    const params = { deviceId: helperDevice, expectKeyId: key.keyId };
    expect(await admin.request("devices.presenceKey.register", params, ik())).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: { reason: "replace_confirmation_required", replacesKeyId: forgotten },
      },
    });
    // The wrong id does not confirm it.
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { ...params, confirmReplacesKeyId: "b".repeat(64) },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { ...params, confirmReplacesKeyId: forgotten },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { keyId: key.keyId } });
    const replaced = (await c.audit.query({ kind: "presence_key.replaced" }))[0];
    expect(replaced?.data).toMatchObject({ previousKeyId: forgotten, previousVia: "removed" });
    expect(replaced?.actor).toMatchObject({ type: "device" });
  });

  it("registering the very key a Remove forgot is not a replacement", async () => {
    const { c, admin, helperDevice, key } = await setup({ family: "win-helper", register: false });
    setSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING, {
      [helperDevice]: { previousKeyId: key.keyId, removedAt: "x" },
    });
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { keyId: key.keyId } });
    expect(await c.audit.query({ kind: "presence_key.replaced" })).toHaveLength(0);
  });

  it("a Windows Hello key that stopped working says so, so the card can send the owner to Devices", async () => {
    const { admin } = await setup({
      family: "win-helper",
      confirm: () => {
        throw Object.assign(new Error("Windows Hello changed"), {
          code: "unavailable",
          details: { reason: "presence_key_invalidated" },
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
      error: { code: "unavailable", details: { reason: "presence_key_invalidated" } },
    });
  });

  describe("with a second Mac's helper", () => {
    /** A second Mac: an approved node device that says `mac-helper` over the WebSocket. */
    async function secondMac(c: ComposedGateway, confirm: Confirm) {
      const deviceId = "second-mac";
      const deviceKey = newDeviceKey();
      const key = { keyId: macSigner(deviceKey).keyId };
      pairNodeDevice(c.gateway, deviceId, deviceKey);
      const node = await FakeNode.connectWs(wsUrlOf(c.gateway), {
        origin: c.gateway.origin,
        handlers: helperHandlers(macReport(deviceKey), confirm),
        key: deviceKey,
        deviceId,
        deviceFamily: "mac-helper",
      });
      nodes.push(node);
      return { node, key, deviceId };
    }

    it("never asks it to confirm, with or without a pin, and its key is no verifier", async () => {
      const hostAsked: unknown[] = [];
      const { c, admin } = await setup({
        confirm: (p) => {
          hostAsked.push(p);
          return { signature: "x" };
        },
      });
      // It connects last, so "the newest helper" would be this one.
      const other = await secondMac(c, () => ({ signature: "y" }));
      const { approval, token } = await securityCard(admin);

      // Pinned to the second Mac: it is not the Host's helper, so there is nothing to ask.
      expect(
        await admin.request(
          "approvals.approveWithTouchId",
          { approvalId: approval.id, answerToken: token, helperDeviceId: other.deviceId },
          ik(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "unavailable", details: { reason: "helper_offline" } },
      });
      // Not pinned: the Host's helper is asked, never the newer second Mac.
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      );
      expect(hostAsked).toHaveLength(1);
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("presence.confirm");

      // Its device key is never a verifier for approvals (it is not the Host's helper), and
      // there is nothing to register for it either.
      expect(
        await admin.request(
          "devices.presenceKey.register",
          { deviceId: other.deviceId, expectKeyId: other.key.keyId },
          ik(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "conflict", details: { reason: "no_key_needed" } },
      });
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("presence.public_key");
    });

    it("never receives the approval notifications", async () => {
      const { c, admin } = await setup({ confirm: () => ({ signature: "x" }) });
      const other = await secondMac(c, () => ({ signature: "y" }));
      const issued = await c.gateway.context.broker.requestApproval({
        kind: "policy_change",
        summary: "Change a security setting",
        details: {},
        bindingHash: "c".repeat(64),
        grantKey: "c".repeat(64),
        requestedBy: { runId: null, taskId: null, threadId: null },
        sideEffect: "destructive",
        surfaces: ["desktop", "notification"],
        scopesOffered: ["once"],
        taint: false,
      });
      expect(issued.approval.id).toBeTruthy();
      const host = nodes[0] as FakeNode;
      await vi.waitFor(() =>
        expect(host.invocations.map((i) => i.capability)).toContain("notify.show"),
      );
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("notify.show");
      expect(admin).toBeDefined();
    });
  });

  it("with two Host helpers and no pin it asks neither; a pin names one", async () => {
    const asked: string[] = [];
    const { c, admin, helperDevice } = await setup({
      confirm: () => {
        asked.push("first");
        return { signature: "x" };
      },
    });
    const secondKey = newDeviceKey();
    const second = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: helperHandlers(macReport(secondKey), () => {
        asked.push("second");
        return { signature: "y" };
      }),
      deviceId: "helper-two",
      key: secondKey,
    });
    nodes.push(second);
    await vi.waitFor(() =>
      expect(second.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    const { approval, token } = await securityCard(admin);
    const unpinned = await admin.request(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(unpinned).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "helper_offline" } },
    });
    expect(JSON.stringify(unpinned)).toContain("More than one");
    expect(asked).toEqual([]);
    // The desktop's own helper, by device id, is unambiguous.
    await admin.request(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token, helperDeviceId: helperDevice },
      ik(),
    );
    expect(asked).toEqual(["first"]);

    // The owner pinned a Host helper (devices.hostHelperDeviceId): with no pin from the window
    // the registry's choice settles it, as for every other Host-bound call.
    setSetting(c.gateway.context.db, "devices.hostHelperDeviceId", "helper-two");
    // The pinned helper is the one asked now (its answer here is not a valid signature).
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { details: { reason: "presence_invalid" } } });
    expect(asked).toEqual(["first", "second"]);
  });

  it("keeps only short, word-like helper error codes and reasons", () => {
    expect(
      helperErrorFields({ code: "x".repeat(500), details: { reason: "a\nb; rm -rf" } }),
    ).toEqual({ code: "unknown" });
    expect(helperErrorFields({ code: "cancelled", details: { reason: "user_cancelled" } })).toEqual(
      {
        code: "cancelled",
        reason: "user_cancelled",
      },
    );
  });
});
