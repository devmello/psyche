import { sign } from "node:crypto";
import { getMachineByDevice, insertDevice, openDb, updateDevice } from "@psyche/db";
import {
  connectSigningPayload,
  type NodeCapability,
  PROTOCOL_VERSION,
  parseMachineLink,
  parsePairingLink,
} from "@psyche/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairedIdentity } from "../src/auth.ts";
import { setupTokenHandlers } from "../src/compose/setup-tokens.ts";
import type { MachineChange } from "../src/nodes/machines.ts";
import { nodeKindOf } from "../src/nodes/registry.ts";
import {
  adminClient,
  type DeviceKey,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

const publicOrigin = "https://studio-mac.tail1234.ts.net";
/** A request through Tailscale Serve: not loopback, so it is never auto-paired. */
const forwarded = { "x-forwarded-for": "100.64.0.9" };

let t: TestGateway;
const open: TestClient[] = [];
const audited: { kind: string; data?: unknown }[] = [];
const changes: MachineChange[] = [];

const cap = (name: string): NodeCapability => ({ name, sideEffect: "none" });
const FULL = [
  "health",
  "machine.status",
  "computer.click",
  "computer.screenshot",
  "apps.open",
  "vscreen.input",
  "vscreen.frame",
  "exec.host",
  "fs.read",
  "fs.write",
  "a11y.status",
].map(cap);
const EXTRA = [
  "notify.show",
  "keychain.get",
  "presence.sign",
  "screen.capture",
  "teach.start",
  "speech.say",
  "Computer.click",
  "computer.click.extra/../x",
  "vscreen.",
  "settings.set",
].map(cap);

async function start() {
  const db = openDb(":memory:");
  t = await startTestGateway({
    db,
    handlers: setupTokenHandlers({
      db,
      audit: {
        append: async (entry) => {
          audited.push(entry);
          return entry as never;
        },
      },
    }),
    onMachineChange: (c) => changes.push(c),
    config: { allowedOrigins: [publicOrigin], publicOrigin },
  });
  return t;
}

afterEach(async () => {
  audited.length = 0;
  changes.length = 0;
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
});

async function admin(): Promise<TestClient> {
  const c = await adminClient(t.gateway);
  open.push(c);
  return c;
}

interface Opts {
  key?: DeviceKey;
  deviceId?: string;
  role?: "client" | "node";
  family?: string;
  name?: string;
  /** Default: the Gateway's key (v2). `"none"` sends a v1 connect. */
  gatewayKey?: string | "none";
  setupToken?: string;
  capabilities?: NodeCapability[];
}

/** A node (or client) over the network that signs the connect the way the Rust helper will. */
async function connect(o: Opts = {}) {
  const key = o.key ?? newDeviceKey();
  const deviceId = o.deviceId ?? `box-${Math.random().toString(36).slice(2)}`;
  const family = o.family ?? "linux-helper";
  const role = o.role ?? "node";
  const gatewayKey =
    o.gatewayKey === "none" ? undefined : (o.gatewayKey ?? t.gateway.context.identity.publicKey);
  const client = await TestClient.open(wsUrlOf(t.gateway), forwarded);
  open.push(client);
  const challenge = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId,
    publicKey: key.publicKey,
    role,
    platform: "linux",
    deviceFamily: family,
    name: o.name ?? "lab-box",
    ...(role === "node" ? { capabilities: o.capabilities ?? FULL } : {}),
  });
  const c = challenge.payload as { nonce: string; protocolVersion: number };
  const payload = connectSigningPayload({
    nonce: c.nonce,
    platform: "linux",
    deviceFamily: family,
    protocolVersion: c.protocolVersion,
    serverOrigin: publicOrigin,
    ...(gatewayKey === undefined ? {} : { gatewayKey }),
  });
  const verify = await client.request("connect.verify", {
    nonce: c.nonce,
    signature: sign(null, payload, key.privateKey).toString("base64url"),
    ...(gatewayKey === undefined ? {} : { gatewayKey }),
    ...(o.setupToken === undefined ? {} : { setupToken: o.setupToken }),
  });
  const out = verify.payload as { phase?: string; code?: string; nodeId?: string; reason?: string };
  return { client, key, deviceId, verify, out, family };
}

async function makeMachineToken(via?: "lan") {
  const a = await admin();
  const made = await a.call<{
    link: string;
    version: number;
    setupToken: { id: string; scopes: string[]; purpose: string };
  }>("devices.setupToken.create", { purpose: "machine", ...(via ? { via } : {}) });
  return { a, made, token: parseMachineLink(made.link).setupToken };
}

async function pairMachine(name = "lab-box") {
  const { a, token } = await makeMachineToken();
  const m = await connect({ setupToken: token, name });
  expect(m.out.phase).toBe("paired");
  return { a, m, token };
}

const nodeOf = (deviceId: string) =>
  t.gateway.context.nodes.list().find((n) => n.deviceId === deviceId);

describe("minting a machine token", () => {
  it("makes a psyche-machine:v1 link for exactly [node], audited with its purpose", async () => {
    await start();
    const { made, token } = await makeMachineToken();
    const link = parseMachineLink(made.link);
    expect(link.gatewayKey).toBe(t.gateway.context.identity.publicKey);
    expect(link.gatewayUrl).toBe(publicOrigin);
    expect(token).toMatch(/^pst_/);
    expect(made.version).toBe(1);
    expect(made.setupToken).toMatchObject({ scopes: ["node"], purpose: "machine", status: "live" });
    expect(audited.find((e) => e.kind === "device.setup_token.created")?.data).toMatchObject({
      purpose: "machine",
      scopes: ["node"],
    });
    // A device link is not a machine link, and the other way round.
    const a = await admin();
    const dev = await a.call<{ link: string }>("devices.setupToken.create", {
      scopes: ["operator.read"],
    });
    expect(() => parseMachineLink(dev.link)).toThrow();
    expect(() => parsePairingLink(made.link)).toThrow();
  });

  it("takes no scopes of its own: a caller cannot widen a machine token", async () => {
    await start();
    const a = await admin();
    for (const scopes of [["operator.admin"], ["node"], ["operator.read", "node"]]) {
      expect(
        await a.request("devices.setupToken.create", { purpose: "machine", scopes }),
      ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
    expect(audited).toEqual([]);
  });
});

describe("kind comes from the owner's decision", () => {
  it("a machine token pairs a node with scope [node] and the machine kind", async () => {
    await start();
    const { a, m } = await pairMachine();
    const device = t.gateway.context.db.sqlite
      .prepare("SELECT scopes, role, device_family AS fam FROM devices WHERE id = ?")
      .get(m.deviceId) as { scopes: string; role: string; fam: string };
    expect(device).toEqual({ scopes: '["node"]', role: "node", fam: "linux-helper" });
    expect(nodeOf(m.deviceId)?.kind).toBe("machine");
    expect(t.gateway.context.nodes.machine(m.deviceId)?.info.kind).toBe("machine");
    const { machines } = await a.call<{ machines: { name: string; status: string }[] }>(
      "machines.list",
    );
    expect(machines).toMatchObject([{ name: "lab-box", status: "online" }]);
    await a.waitForEvent((f) => f.event === "machines.changed");
    expect(changes).toMatchObject([{ change: "added", name: "lab-box", via: "setup_token" }]);
  });

  it("announces a new machine exactly once, however often it reconnects", async () => {
    await start();
    const { m } = await pairMachine();
    m.client.close();
    await connect({ key: m.key, deviceId: m.deviceId });
    await connect({ key: m.key, deviceId: m.deviceId });
    expect(changes.filter((c) => c.change === "added")).toHaveLength(1);
  });

  it("a network linux-helper without approval is remote and unroutable", async () => {
    await start();
    // Paired as a plain node by someone (a hand-made row), never approved as a machine.
    const key = newDeviceKey();
    insertDevice(t.gateway.context.db, {
      id: "plain-linux",
      name: "plain",
      platform: "linux",
      role: "node",
      publicKey: key.publicKey,
      scopes: ["node"],
      pairedAt: new Date().toISOString(),
      deviceFamily: "linux-helper",
    });
    const m = await connect({ key, deviceId: "plain-linux" });
    expect(m.out.phase).toBe("paired");
    expect(nodeOf("plain-linux")?.kind).toBe("remote");
    expect(t.gateway.context.nodes.machine("plain-linux")).toBeUndefined();
    const a = await admin();
    expect((await a.call<{ machines: unknown[] }>("machines.list")).machines).toEqual([]);
  });

  it("an unapproved linux-helper that asks to pair is a pending machine card, not a machine", async () => {
    await start();
    const m = await connect();
    expect(m.out.phase).toBe("pending");
    const a = await admin();
    const list = await a.call<{ pairingRequests: { purpose?: string; deviceId: string }[] }>(
      "devices.pairing.list",
    );
    expect(list.pairingRequests).toMatchObject([{ purpose: "machine", deviceId: m.deviceId }]);
    expect(nodeOf(m.deviceId)).toBeUndefined();
    expect(getMachineByDevice(t.gateway.context.db, m.deviceId)).toBeUndefined();
  });

  it("approving the machine card makes the machine; scopes are forced to [node]", async () => {
    await start();
    const m = await connect({ name: "lab-box" });
    const a = await admin();
    const { pairingRequests } = await a.call<{ pairingRequests: { id: string }[] }>(
      "devices.pairing.list",
    );
    const id = pairingRequests[0]?.id;
    // A caller who passes operator scopes does not get them: the card is a machine card.
    await a.call("devices.approve", {
      pairingRequestId: id,
      scopes: ["operator.read", "operator.admin"],
    });
    const row = t.gateway.context.db.sqlite
      .prepare("SELECT scopes FROM devices WHERE id = ?")
      .get(m.deviceId) as { scopes: string };
    expect(row.scopes).toBe('["node"]');
    const again = await connect({ key: m.key, deviceId: m.deviceId });
    expect(again.out.phase).toBe("paired");
    expect(nodeOf(m.deviceId)?.kind).toBe("machine");
    expect(changes.filter((c) => c.change === "added")).toMatchObject([
      { name: "lab-box", via: "pairing_card" },
    ]);
  });

  it("approving a plain node's card never makes a machine", async () => {
    await start();
    const m = await connect({ family: "psyche-node", name: "some node" });
    expect(m.out.phase).toBe("pending");
    const a = await admin();
    const { pairingRequests } = await a.call<{
      pairingRequests: { id: string; purpose?: string }[];
    }>("devices.pairing.list");
    expect(pairingRequests[0]?.purpose).toBeUndefined();
    await a.call("devices.approve", { pairingRequestId: pairingRequests[0]?.id, scopes: ["node"] });
    await connect({ key: m.key, deviceId: m.deviceId, family: "psyche-node" });
    expect(nodeOf(m.deviceId)?.kind).toBe("remote");
    expect(getMachineByDevice(t.gateway.context.db, m.deviceId)).toBeUndefined();
  });

  it("nodeKindOf: only the stored decision makes a machine, never the family", () => {
    const id = (extra: Partial<PairedIdentity> = {}): PairedIdentity => ({
      deviceId: "d",
      scopes: ["node"],
      role: "node",
      ...extra,
    });
    const params = (deviceFamily: string) => ({ deviceFamily }) as never;
    for (const family of ["machine", "linux-helper", "psyche-node", "host-helper", "remote"]) {
      expect(nodeKindOf(id(), params(family))).not.toBe("machine");
    }
    expect(nodeKindOf(id({ machine: true }), params("linux-helper"))).toBe("machine");
    // Never the Host's own helper nor a separate desktop's.
    expect(nodeKindOf(id({ machine: true, hostHelper: true }), params("linux-helper"))).not.toBe(
      "machine",
    );
    expect(nodeKindOf(id({ machine: true, guestContainer: "c" }), params("linux-helper"))).toBe(
      "guest",
    );
  });
});

describe("v2 signing is required and the family is pinned", () => {
  it("refuses a v1 connect from a linux-helper node, with a token or without", async () => {
    await start();
    const { token } = await makeMachineToken();
    const v1 = await connect({ setupToken: token, gatewayKey: "none" });
    expect(v1.verify.ok).toBe(false);
    expect(v1.out?.phase).toBeUndefined();
    // The token was not spent by it.
    const ok = await connect({ setupToken: token });
    expect(ok.out.phase).toBe("paired");
    expect((await connect({ gatewayKey: "none" })).verify.ok).toBe(false);
  });

  it("refuses a paired machine's v1 or wrong-key reconnect", async () => {
    await start();
    const { m } = await pairMachine();
    expect(
      (await connect({ key: m.key, deviceId: m.deviceId, gatewayKey: "none" })).verify.ok,
    ).toBe(false);
    const wrong = await connect({
      key: m.key,
      deviceId: m.deviceId,
      gatewayKey: newDeviceKey().publicKey,
    });
    expect(wrong.verify.ok).toBe(false);
  });

  it("a machine's key cannot reconnect in another family or as a client", async () => {
    await start();
    const { m } = await pairMachine();
    for (const o of [
      { family: "psyche-node" },
      { family: "mac-helper" },
      { role: "client" as const },
    ]) {
      const r = await connect({ key: m.key, deviceId: m.deviceId, ...o });
      expect(r.out.phase).not.toBe("paired");
      expect(nodeOf(m.deviceId)?.kind).toBe("machine");
    }
  });
});

describe("token purpose and replay", () => {
  it("a device token cannot make a machine, and stays live", async () => {
    await start();
    const a = await admin();
    const dev = await a.call<{ link: string; setupToken: { id: string } }>(
      "devices.setupToken.create",
      { scopes: ["operator.read"] },
    );
    const token = parsePairingLink(dev.link).setupToken;
    const r = await connect({ setupToken: token });
    expect(r.out).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    expect(nodeOf(r.deviceId)).toBeUndefined();
    expect(getMachineByDevice(t.gateway.context.db, r.deviceId)).toBeUndefined();
    const live = await a.call<{ setupTokens: { id: string; status: string }[] }>(
      "devices.setupToken.list",
    );
    expect(live.setupTokens.find((x) => x.id === dev.setupToken.id)?.status).toBe("live");
  });

  it("a machine token cannot pair a client, a node of another family or a device in the wrong family", async () => {
    await start();
    const { a, made, token } = await makeMachineToken();
    for (const o of [
      { role: "client" as const, family: "desktop" },
      { role: "client" as const, family: "ios" },
      { role: "node" as const, family: "psyche-node" },
      { role: "node" as const, family: "mac-helper" },
    ]) {
      const r = await connect({ setupToken: token, ...o });
      expect(r.out).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    }
    const list = await a.call<{ setupTokens: { id: string; status: string }[] }>(
      "devices.setupToken.list",
    );
    expect(list.setupTokens.find((x) => x.id === made.setupToken.id)?.status).toBe("live");
    expect((await connect({ setupToken: token })).out.phase).toBe("paired");
  });

  it("a machine token works once: a replay by another box is refused", async () => {
    await start();
    const { m, token } = await pairMachine();
    const replay = await connect({ setupToken: token });
    expect(replay.out).toMatchObject({ phase: "denied", code: "setup_token_invalid" });
    expect(nodeOf(replay.deviceId)).toBeUndefined();
    expect(t.gateway.context.nodes.list().filter((n) => n.kind === "machine")).toHaveLength(1);
    expect(m.out.phase).toBe("paired");
  });

  it("a revoked or expired machine token pairs nothing", async () => {
    await start();
    const { a, made, token } = await makeMachineToken();
    await a.call("devices.setupToken.revoke", { id: made.setupToken.id }, "rt1");
    expect((await connect({ setupToken: token })).out.code).toBe("setup_token_invalid");
  });

  it("a machine cannot carry operator scopes: granted ones refuse its next connect", async () => {
    await start();
    const { m } = await pairMachine();
    updateDevice(t.gateway.context.db, m.deviceId, {
      scopes: ["node", "operator.read", "operator.admin"],
    });
    m.client.close();
    const r = await connect({ key: m.key, deviceId: m.deviceId });
    expect(r.out.phase).not.toBe("paired");
  });

  it("a connected machine cannot call operator methods", async () => {
    await start();
    const { m } = await pairMachine();
    for (const method of ["devices.list", "machines.list", "nodes.list", "settings.get"]) {
      expect(await m.client.request(method, {})).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
  });
});

describe("the accept-time capability allowlist", () => {
  it("drops everything off the list, once each", async () => {
    await start();
    const { token } = await makeMachineToken();
    const m = await connect({
      setupToken: token,
      capabilities: [...FULL, ...EXTRA, cap("health")],
    });
    expect(m.out.phase).toBe("paired");
    const names = (nodeOf(m.deviceId)?.capabilities ?? []).map((c) => c.name).sort();
    expect(names).toEqual(FULL.map((c) => c.name).sort());
  });
});

describe("nodes.invoke on a machine", () => {
  function answer(m: Awaited<ReturnType<typeof connect>>, seen: string[]) {
    m.client.ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as {
        type: string;
        id: string;
        method?: string;
        params?: { invocationId: string; capability: string };
      };
      if (frame.type !== "req" || frame.method !== "node.invoke" || !frame.params) return;
      seen.push(frame.params.capability);
      m.client.ws.send(
        JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { accepted: true } }),
      );
      void m.client.request("node.result", {
        invocationId: frame.params.invocationId,
        ok: true,
        result: { ok: true },
      });
    });
  }

  it("reaches health and machine.status only", async () => {
    await start();
    const { a, m } = await pairMachine();
    const seen: string[] = [];
    answer(m, seen);
    const nodeId = nodeOf(m.deviceId)?.id;
    for (const capability of ["health", "machine.status"]) {
      const r = await a.request(
        "nodes.invoke",
        { nodeId, capability, params: {} },
        `k-${capability}`,
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    for (const capability of [
      "computer.click",
      "computer.screenshot",
      "exec.host",
      "fs.write",
      "fs.read",
      "vscreen.input",
      "vscreen.frame",
      "apps.open",
      "a11y.status",
      "notify.show",
      "something.new",
    ]) {
      const r = await a.request(
        "nodes.invoke",
        { nodeId, capability, params: {} },
        `k-${capability}`,
      );
      expect(r, capability).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(seen).toEqual(["health", "machine.status"]);
  });
});

describe("machines.list and machines.rename", () => {
  it("renames case-insensitively unique, admin only, and announces it", async () => {
    await start();
    const { a } = await pairMachine("lab-box");
    const second = await connect({ setupToken: (await makeMachineToken()).token, name: "Lab-Box" });
    expect(second.out.phase).toBe("paired");
    const { machines } = await a.call<{ machines: { id: string; name: string }[] }>(
      "machines.list",
    );
    // The second box asked for the same name; it got a different one.
    expect(machines.map((x) => x.name)).toEqual(["lab-box", "Lab-Box 2"]);
    const [first, other] = machines;
    expect(
      await a.request("machines.rename", { id: other?.id, name: "LAB-BOX" }, "r1"),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    const ok = await a.call<{ machine: { name: string } }>(
      "machines.rename",
      { id: other?.id, name: "build box" },
      "r2",
    );
    expect(ok.machine.name).toBe("build box");
    expect(changes.find((c) => c.change === "renamed")).toMatchObject({
      previousName: "Lab-Box 2",
      name: "build box",
    });
    // Renaming a machine to its own name in another case is allowed (same machine).
    await a.call("machines.rename", { id: first?.id, name: "Lab-box" }, "r3");
    expect(await a.request("machines.rename", { id: "nope", name: "x" }, "r4")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    const reader = await TestClient.open(wsUrlOf(t.gateway));
    open.push(reader);
    // The Host's auto-paired desktop has no admin scope.
    const { handshake } = await import("./helpers.ts");
    await handshake(reader, t.gateway.origin, { handshakeSecret: t.gateway.handshakeSecret });
    expect(
      await reader.request("machines.rename", { id: first?.id, name: "mine" }, "r5"),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("revoking a machine", () => {
  it("closes it, removes the decision, audits, and ends in device_revoked", async () => {
    await start();
    const { a, m } = await pairMachine();
    const closed = new Promise<void>((resolve) => m.client.ws.once("close", () => resolve()));
    await a.call("devices.revoke", { deviceId: m.deviceId }, "rv1");
    await closed;
    expect(getMachineByDevice(t.gateway.context.db, m.deviceId)).toBeUndefined();
    expect(t.gateway.context.nodes.machine(m.deviceId)).toBeUndefined();
    expect(nodeOf(m.deviceId)?.status).toBe("offline");
    expect(changes.map((c) => c.change)).toEqual(["added", "removed"]);
    expect(changes[1]).toMatchObject({ name: "lab-box", byDeviceId: expect.any(String) });
    const { machines } = await a.call<{ machines: unknown[] }>("machines.list");
    expect(machines).toEqual([]);
    const back = await connect({ key: m.key, deviceId: m.deviceId });
    expect(back.out).toMatchObject({ phase: "denied", code: "device_revoked" });
    // The revoked key cannot use a fresh machine token either.
    const { token } = await makeMachineToken();
    const again = await connect({ key: m.key, deviceId: m.deviceId, setupToken: token });
    expect(again.out).toMatchObject({ phase: "denied", code: "device_revoked" });
  });

  it("a machine revoked behind the registry's back is not routable and cannot attach", async () => {
    await start();
    const { m } = await pairMachine();
    // A revoke that has committed while the connection is still open.
    t.gateway.context.db.sqlite
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), m.deviceId);
    expect(t.gateway.context.nodes.machine(m.deviceId)).toBeUndefined();
    const close = vi.fn();
    expect(() =>
      t.gateway.context.nodes.attach(
        { close, id: "c", open: true, peer: { transport: "ws" } } as never,
        { deviceId: m.deviceId, scopes: ["node"], role: "node", machine: true },
        { deviceFamily: "linux-helper", capabilities: FULL } as never,
      ),
    ).toThrow(/no longer paired/);
    expect(close).toHaveBeenCalled();
  });
});
