import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeHelper } from "@psyche/gateway/compose";
import type { IssuedApproval } from "@psyche/protocol";
import { isNamedPipePath, namedPipePath } from "@psyche/protocol/platform";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ComposeServices } from "../../../apps/gateway/src/compose/services.ts";
import { type PartsSkeleton, startWithParts } from "../google/harness.ts";
import { MAIN, ScriptedModel, UTILITY } from "../walking-skeleton/scripted-model.ts";
import { FakeHelper, newHelloKey } from "./fake-helper.ts";

/**
 * The Windows helper (apps/win-helper) as the Gateway sees it: `role: "node"`, `platform:
 * "windows"`, `deviceFamily: "win-helper"`. It finds the node endpoint in
 * `$PSYCHE_HOME/run/node-socket` (on Windows the named pipe `\\.\pipe\psyche-node-<hash>`) and
 * presents the per-launch handshake secret, exactly like the Mac helper on its Unix socket: only
 * then is it the Host's own helper. Without the secret it is refused on the node transport, and a
 * win-helper reaching the Gateway any other way is a `remote` node. Its Windows Hello presence key
 * is RSA-2048 (SPKI DER), signing PKCS#1 v1.5 / SHA-256.
 */

const registered = new Map<string, string>();
let sk: PartsSkeleton;
let services: ComposeServices;
const helpers: FakeHelper[] = [];

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
  for (const h of helpers.splice(0)) await h.close();
  registered.clear();
});

/** What the helper reads before every connect. */
const endpoint = () =>
  readFileSync(join(sk.composed.gateway.config.home, "run", "node-socket"), "utf8").trim();

const nodeOf = (h: FakeHelper) =>
  sk.composed.gateway.context.nodes.list().find((n) => n.id === h.nodeId);

describe("the Windows helper on the node transport", () => {
  it.skipIf(process.platform !== "win32")(
    "the endpoint in run/node-socket is the home's named pipe",
    () => {
      const { config } = sk.composed.gateway;
      expect(isNamedPipePath(endpoint())).toBe(true);
      expect(endpoint()).toBe(namedPipePath("node", config.home));
      expect(endpoint()).toBe(config.nodeSocketPath);
      // The sandbox PC's relay delivers guests on their own pipe, never the node pipe.
      expect(config.guestSocketPath).toBe(namedPipePath("guest", config.home));
      expect(config.guestSocketPath).not.toBe(config.nodeSocketPath);
    },
  );

  it("with the handshake secret it pairs by itself and is the Host's own helper", async () => {
    const { gateway } = sk.composed;
    const h = await FakeHelper.connect(endpoint(), {
      origin: gateway.origin,
      secret: { home: gateway.config.home },
      family: "win-helper",
    });
    helpers.push(h);
    await h.subscribed();
    expect(nodeOf(h)?.kind).toBe("win-helper");
    expect(gateway.context.nodes.isHostHelper(h.nodeId)).toBe(true);
    expect(gateway.context.nodes.hostHelper()?.info.id).toBe(h.nodeId);
    const device = sk.composed.db.sqlite
      .prepare("SELECT platform, role, scopes, device_family FROM devices WHERE id = ?")
      .get(h.deviceId);
    expect(device).toEqual({
      platform: "windows",
      role: "node",
      scopes: '["node"]',
      device_family: "win-helper",
    });
  });

  it("without the secret, or with a stale one, it is refused and never paired", async () => {
    const { gateway } = sk.composed;
    for (const secret of [undefined, "stale-secret"]) {
      await expect(
        FakeHelper.connect(endpoint(), { origin: gateway.origin, secret, family: "win-helper" }),
      ).rejects.toThrow(/stale or missing handshake secret/);
    }
    expect(gateway.context.nodes.hostHelper()).toBeUndefined();
  });

  it("a win-helper that reaches the Gateway any other way is a remote node, secret or not", async () => {
    const { gateway } = sk.composed;
    // Paired once as the Host helper over the pipe...
    const identity = FakeHelper.newIdentity();
    const first = await FakeHelper.connect(endpoint(), {
      origin: gateway.origin,
      secret: { home: gateway.config.home },
      family: "win-helper",
      identity,
    });
    await first.close();
    // ...then the same device over the WebSocket, even presenting the right secret.
    const h = await FakeHelper.connect(`ws://127.0.0.1:${gateway.port}/ws`, {
      origin: gateway.origin,
      secret: { home: gateway.config.home },
      family: "win-helper",
      identity,
      ws: true,
    });
    helpers.push(h);
    expect(nodeOf(h)?.kind).toBe("remote");
    expect(gateway.context.nodes.isHostHelper(h.nodeId)).toBe(false);
    expect(gateway.context.nodes.hostHelper()).toBeUndefined();
    // A new win-helper on the loopback WebSocket with the secret pairs as a node (the same rule as
    // the Mac helper), but only ever as a remote one; without the secret it never pairs.
    const fresh = await FakeHelper.connect(`ws://127.0.0.1:${gateway.port}/ws`, {
      origin: gateway.origin,
      secret: { home: gateway.config.home },
      family: "win-helper",
      ws: true,
    });
    helpers.push(fresh);
    expect(nodeOf(fresh)?.kind).toBe("remote");
    expect(gateway.context.nodes.isHostHelper(fresh.nodeId)).toBe(false);
    await expect(
      FakeHelper.connect(`ws://127.0.0.1:${gateway.port}/ws`, {
        origin: gateway.origin,
        secret: undefined,
        family: "win-helper",
        ws: true,
      }),
    ).rejects.toThrow(/handshake secret on its own PC/);
  });
});

describe("Windows Hello approvals from the toast", () => {
  async function request(): Promise<IssuedApproval> {
    const n = Math.random().toString(36).slice(2);
    return services.broker.requestApproval({
      kind: "purchase",
      summary: `purchase ${n}`,
      details: { item: "desk", total: "$120" },
      bindingHash: `sha256:${createHash("sha256").update(n).digest("hex")}`,
      grantKey: `win|${n}`,
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "financial",
      surfaces: ["desktop", "web"],
      taint: false,
    });
  }

  async function helloHelper() {
    const { gateway } = sk.composed;
    const h = await FakeHelper.connect(endpoint(), {
      origin: gateway.origin,
      secret: { home: gateway.config.home },
      family: "win-helper",
      presence: newHelloKey(),
    });
    helpers.push(h);
    registered.set(h.deviceId, h.presence.publicKey);
    await h.subscribed();
    return h;
  }

  /** The card arms after a short delay; an earlier answer is refused (docs/06 approval card). */
  const armed = () => new Promise((r) => setTimeout(r, 450));
  const rejections = async (approvalId: string) =>
    (await sk.composed.audit.list({ kind: "approval.answer_rejected" }))
      .filter((e) => e.subject?.approvalId === approvalId)
      .map((e) => (e.data as { reason?: string } | undefined)?.reason);

  const waitFor = async (cond: () => Promise<boolean>) => {
    const end = Date.now() + 5000;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("an Approve signed by the registered RSA key approves the card", async () => {
    const h = await helloHelper();
    const issued = await request();
    const card = await h.card(issued.approval.id);
    expect(card.requireBiometry).toBe(true);
    await armed();
    await h.tap(issued.approval.id, { actionId: "approve" });
    await waitFor(
      async () => (await services.broker.get(issued.approval.id))?.status !== "pending",
    );
    expect((await services.broker.get(issued.approval.id))?.status).toBe("approved");
  });

  it("a signature by another RSA key is refused and the card stays pending", async () => {
    const h = await helloHelper();
    const issued = await request();
    await armed();
    await h.tap(issued.approval.id, { actionId: "approve", key: newHelloKey() });
    await waitFor(async () => (await rejections(issued.approval.id)).length > 0);
    expect(await rejections(issued.approval.id)).toEqual(["presence_invalid"]);
    expect((await services.broker.get(issued.approval.id))?.status).toBe("pending");
  });
});
