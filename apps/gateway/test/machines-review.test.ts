import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getDevice, getMachineByDevice, insertDevice, insertMachine, openDb } from "@psyche/db";
import { connectSigningPayload, PROTOCOL_VERSION, parseMachineLink } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { setupTokenHandlers } from "../src/compose/setup-tokens.ts";
import {
  forceMachinePairingCardsForTests,
  isMixedScriptName,
  machineNameKey,
  machineNameRefusal,
} from "../src/nodes/machines.ts";
import { StateSeal } from "../src/security/state-seal.ts";
import {
  adminClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Review round 1 of the machine registry (#1460): a machine card approved by the CLI or by a
 * recovery after the card expired, the name a card shows, lookalike names, and the seal.
 */

const publicOrigin = "https://studio-mac.tail1234.ts.net";
const forwarded = { "x-forwarded-for": "100.64.0.9" };
const DAY = 24 * 60 * 60 * 1000;
let t: TestGateway | undefined;
const open: TestClient[] = [];
let offsetMs = 0;

afterEach(async () => {
  forceMachinePairingCardsForTests(undefined);
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
  t = undefined;
  offsetMs = 0;
});

async function boot(): Promise<TestGateway> {
  const home = mkdtempSync(join(tmpdir(), "psyche-m1460-"));
  const db = openDb(join(home, "state", "psyche.sqlite"), {
    now: () => new Date(Date.now() + offsetMs).toISOString(),
  });
  t = await startTestGateway({
    home,
    db,
    handlers: setupTokenHandlers({
      db,
      audit: { append: async (entry) => entry as never },
    }),
    config: {
      dbPath: join(home, "state", "psyche.sqlite"),
      allowedOrigins: [publicOrigin],
      publicOrigin,
    },
    now: () => new Date(Date.now() + offsetMs),
    security: { pollMs: 20 },
  });
  return t;
}

async function connect(
  o: {
    key?: ReturnType<typeof newDeviceKey>;
    deviceId?: string;
    name?: string;
    family?: string;
    setupToken?: string;
  } = {},
) {
  const gw = t as TestGateway;
  const key = o.key ?? newDeviceKey();
  const deviceId = o.deviceId ?? `box-${Math.random().toString(36).slice(2)}`;
  const family = o.family ?? "linux-helper";
  const gatewayKey = gw.gateway.context.identity.publicKey;
  const client = await TestClient.open(wsUrlOf(gw.gateway), forwarded);
  open.push(client);
  const ch = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId,
    publicKey: key.publicKey,
    role: "node",
    platform: "linux",
    deviceFamily: family,
    name: o.name ?? "lab-box",
    capabilities: [{ name: "health", sideEffect: "none" }],
  });
  const c = ch.payload as { nonce: string; protocolVersion: number };
  const payload = connectSigningPayload({
    nonce: c.nonce,
    platform: "linux",
    deviceFamily: family,
    protocolVersion: c.protocolVersion,
    serverOrigin: publicOrigin,
    gatewayKey,
  });
  const verify = await client.request("connect.verify", {
    nonce: c.nonce,
    signature: sign(null, payload, key.privateKey).toString("base64url"),
    gatewayKey,
    ...(o.setupToken === undefined ? {} : { setupToken: o.setupToken }),
  });
  return {
    client,
    key,
    deviceId,
    out: verify.payload as { phase?: string; code?: string; reason?: string },
  };
}

async function cli(args: string[]) {
  const lines: string[] = [];
  const prev = process.env.PSYCHE_HOME;
  process.env.PSYCHE_HOME = t?.home ?? "";
  try {
    const code = await runCli(args, (l) => lines.push(l), { pollMs: 20 });
    return { code, lines };
  } finally {
    if (prev === undefined) delete process.env.PSYCHE_HOME;
    else process.env.PSYCHE_HOME = prev;
  }
}

const nodeOf = (gw: TestGateway, deviceId: string) =>
  gw.gateway.context.nodes.list().find((n) => n.deviceId === deviceId);

describe("the machine card path is off until the machine UI exists", () => {
  it("refuses a network linux-helper that has no machine token (main's behaviour)", async () => {
    const gw = await boot();
    const m = await connect();
    expect(m.out.phase).toBe("denied");
    expect(getDevice(gw.gateway.context.db, m.deviceId)).toBeUndefined();
  });
});

describe("a machine card approved by the CLI or a recovery stays a machine", () => {
  async function pendingMachineCard() {
    forceMachinePairingCardsForTests(true);
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const m = await connect();
    expect(m.out.phase).toBe("pending");
    return { gw, admin, m };
  }

  it("psyched devices approve, applied after the delay and the card's expiry: [node] and kind machine", async () => {
    const { gw, m } = await pendingMachineCard();
    // The operator asks for admin; the card is a machine card, so that is dropped at intake.
    await cli(["devices", "approve", m.out.code as string]);
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    const device = getDevice(gw.gateway.context.db, m.deviceId);
    expect(device?.scopes).toEqual(["node"]);
    expect(getMachineByDevice(gw.gateway.context.db, m.deviceId)).toBeDefined();
    m.client.close();
    const again = await connect({ key: m.key, deviceId: m.deviceId });
    expect(again.out.phase).toBe("paired");
    expect(nodeOf(gw, m.deviceId)?.kind).toBe("machine");
    expect(await again.client.request("devices.list", {})).toMatchObject({ ok: false });
  });

  it("approve now (security.recoveries.approve) after the card expired: [node] and kind machine", async () => {
    const { gw, admin, m } = await pendingMachineCard();
    await cli(["devices", "approve", m.out.code as string]);
    offsetMs = 10 * 60_000;
    const s = await admin.call<{ recoveries: { id: string; status: string }[] }>(
      "security.state.get",
      {},
    );
    const waiting = s.recoveries.find((x) => x.status === "waiting");
    const res = await admin.request("security.recoveries.approve", { id: waiting?.id }, ik());
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(getDevice(gw.gateway.context.db, m.deviceId)?.scopes).toEqual(["node"]);
    expect(getMachineByDevice(gw.gateway.context.db, m.deviceId)).toBeDefined();
  });

  it("a machine card never takes the first-admin shortcut", async () => {
    forceMachinePairingCardsForTests(true);
    const gw = await boot();
    const m = await connect();
    await cli(["devices", "approve", m.out.code as string]);
    // No admin exists, but the box was not made one: the approval waits like any other.
    expect(getDevice(gw.gateway.context.db, m.deviceId)?.scopes).toEqual([]);
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(gw.gateway.context.db, m.deviceId)?.scopes).toEqual(["node"]);
  });
});

describe("the name on the card is the name the machine gets", () => {
  it("a reconnect that changes the claimed name expires the card", async () => {
    forceMachinePairingCardsForTests(true);
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const key = newDeviceKey();
    const first = await connect({ key, deviceId: "swap", name: "lab-box" });
    first.client.close();
    await connect({ key, deviceId: "swap", name: "something else" });
    const { pairingRequests } = await admin.call<{
      pairingRequests: { id: string; display: string; status: string }[];
    }>("devices.pairing.list", {});
    // Only the card for the new claim is pending; the old one cannot be approved.
    expect(pairingRequests).toHaveLength(1);
    expect(pairingRequests[0]?.display).toMatch(/something else/);
    await admin.call(
      "devices.approve",
      { pairingRequestId: pairingRequests[0]?.id, scopes: ["node"] },
      ik(),
    );
    expect(getDevice(gw.gateway.context.db, "swap")?.name).toBe("something else");
  });
});

describe("machine names", () => {
  it("compare by look: NFKC, case-folding and invisible characters", () => {
    for (const same of [
      ["lab-box", "ⅼab-box"],
      ["lab-box", "LAB-BOX"],
      ["lab-box", "lab​-box"],
      ["lab box", "lab  box"],
      ["Ｌab-box", "lab-box"],
    ]) {
      expect(machineNameKey(same[0] as string), same.join(" / ")).toBe(
        machineNameKey(same[1] as string),
      );
    }
    expect(machineNameKey("lab-box")).not.toBe(machineNameKey("lab-box2"));
  });

  it("rename refuses lookalikes, the Host's labels and other devices' names; invalid text is invalid_params", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    insertDevice(gw.gateway.context.db, {
      id: "phone",
      name: "Dev's iPhone",
      platform: "ios",
      role: "client",
      publicKey: newDeviceKey().publicKey,
      scopes: ["operator.read"],
      pairedAt: new Date().toISOString(),
    });
    const made = async (name: string) => {
      const token = await admin.call<{ link: string }>("devices.setupToken.create", {
        purpose: "machine",
      });
      const { parseMachineLink } = await import("@psyche/protocol");
      const key = newDeviceKey();
      const client = await TestClient.open(wsUrlOf(gw.gateway), forwarded);
      open.push(client);
      const deviceId = `m-${name}`;
      const ch = await client.request("connect", {
        protocolVersion: { min: 1, max: PROTOCOL_VERSION },
        deviceId,
        publicKey: key.publicKey,
        role: "node",
        platform: "linux",
        deviceFamily: "linux-helper",
        name,
        capabilities: [],
      });
      const c = ch.payload as { nonce: string; protocolVersion: number };
      const gatewayKey = gw.gateway.context.identity.publicKey;
      const payload = connectSigningPayload({
        nonce: c.nonce,
        platform: "linux",
        deviceFamily: "linux-helper",
        protocolVersion: c.protocolVersion,
        serverOrigin: publicOrigin,
        gatewayKey,
      });
      await client.request("connect.verify", {
        nonce: c.nonce,
        signature: sign(null, payload, key.privateKey).toString("base64url"),
        gatewayKey,
        setupToken: parseMachineLink(token.link).setupToken,
      });
    };
    await made("lab-box");
    await made("other-box");
    const { machines } = await admin.call<{ machines: { id: string; name: string }[] }>(
      "machines.list",
      {},
    );
    const other = machines.find((m) => m.name === "other-box");
    for (const name of ["ⅼab-box", "This Mac", "this  mac", hostname(), "dev's iphone"]) {
      expect(
        await admin.request("machines.rename", { id: other?.id, name }, ik()),
        name,
      ).toMatchObject({ ok: false, error: { code: "conflict" } });
    }
    expect(
      await admin.request("machines.rename", { id: other?.id, name: "lab\udb40box" }, ik()),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    // And a box that asks for a reserved name at pairing gets a plain one.
    await made("This Mac");
    const list = await admin.call<{ machines: { name: string }[] }>("machines.list", {});
    expect(list.machines.map((m) => m.name)).not.toContain("This Mac");
  });
});

describe("a machines row planted outside Psyche", () => {
  it("is removed by the seal, while the Gateway runs and while it is down", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-m1460s-"));
    const dbPath = join(home, "state", "psyche.sqlite");
    const d = openDb(dbPath);
    const seal = await StateSeal.open(d, { home });
    insertDevice(d, {
      id: "plain",
      name: "plain",
      platform: "linux",
      role: "node",
      publicKey: Buffer.alloc(32, 3),
      scopes: ["node"],
      pairedAt: d.now(),
      deviceFamily: "linux-helper",
    } as never);
    seal.ensure();
    const foreign = openDb(dbPath, { migrate: false });
    foreign.sqlite
      .prepare(
        "INSERT INTO machines (id, device_id, approved_at, via) VALUES ('m1', 'plain', ?, 'pairing_card')",
      )
      .run(d.now());
    foreign.close();
    expect(getMachineByDevice(d, "plain")).toBeUndefined();
    expect(d.sqlite.prepare("SELECT count(*) AS n FROM machines").get()).toEqual({ n: 0 });
    expect(seal.alerts.open().map((a) => a.kind)).toContain("state_changed_outside");
    d.close();
    // Planted while the Gateway is down.
    const down = openDb(dbPath, { migrate: false });
    down.sqlite
      .prepare(
        "INSERT INTO machines (id, device_id, approved_at, via) VALUES ('m2', 'plain', ?, 'setup_token')",
      )
      .run(new Date().toISOString());
    down.close();
    const d2 = openDb(dbPath);
    await StateSeal.open(d2, { home });
    expect(getMachineByDevice(d2, "plain")).toBeUndefined();
    expect(d2.sqlite.prepare("SELECT count(*) AS n FROM machines").get()).toEqual({ n: 0 });
    d2.close();
  });
});

describe("a live machine socket never picks up operator scopes (r2 finding 1)", () => {
  async function machineLink(admin: TestClient): Promise<string> {
    const made = await admin.call<{ link: string }>("devices.setupToken.create", {
      purpose: "machine",
    });
    return parseMachineLink(made.link).setupToken;
  }

  it("R3b: a client card approved by the CLI, the same key then paired by machine link", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    // A client card for a key, queued with admin through the CLI.
    const key = newDeviceKey();
    const c = await TestClient.open(wsUrlOf(gw.gateway), forwarded);
    open.push(c);
    const pending = await handshake(c, publicOrigin, {
      key,
      deviceId: "both",
      role: "client",
      deviceFamily: "desktop",
      gatewayKey: gw.gateway.context.identity.publicKey,
    });
    const code = (pending.verifyRes?.payload as { code: string } | undefined)?.code ?? "";
    expect(code).not.toBe("");
    await cli(["devices", "approve", code]);
    // The same key pairs as a machine.
    const m = await connect({
      key,
      deviceId: "both",
      setupToken: await machineLink(admin),
    });
    expect(m.out.phase).toBe("paired");
    expect(nodeOf(gw, "both")?.kind).toBe("machine");
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(gw.gateway.context.db, "both")?.scopes).toEqual(["node"]);
    // The socket that is still open is refused or closed, never widened.
    const res = await m.client.request("devices.list", {});
    expect(res.ok).toBe(false);
  });

  it("a grant on a machine is refused, at intake and at apply", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const m = await connect({ setupToken: await machineLink(admin) });
    expect(m.out.phase).toBe("paired");
    const r = await cli(["devices", "grant", m.deviceId, "operator.read,operator.admin"]);
    expect(r.code).not.toBe(0);
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(gw.gateway.context.db, m.deviceId)?.scopes).toEqual(["node"]);
  });

  it("a grant queued while the device was a client is refused at apply once it is a machine", async () => {
    const gw = await boot();
    // An admin exists, so the grant queues instead of taking the first-admin shortcut.
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const db = gw.gateway.context.db;
    insertDevice(db, {
      id: "late",
      name: "late-box",
      platform: "linux",
      role: "client",
      publicKey: newDeviceKey().publicKey,
      scopes: ["operator.read"],
      pairedAt: new Date().toISOString(),
    });
    const r = await cli(["devices", "grant", "late", "operator.read,operator.admin"]);
    expect(r.code).toBe(3); // waiting: queued, not applied
    // The device becomes a machine while the grant waits.
    insertMachine(db, { deviceId: "late", approvedByDeviceId: null, via: "setup_token" });
    offsetMs = DAY + 1000;
    gw.gateway.context.securityRecoveries?.applyDue();
    expect(getDevice(db, "late")?.scopes).toEqual(["operator.read"]);
  });

  it("a machine socket whose row holds more than [node] is closed on its next call", async () => {
    const gw = await boot();
    const admin = await adminClient(gw.gateway);
    open.push(admin);
    const m = await connect({ setupToken: await machineLink(admin) });
    gw.gateway.context.db.sqlite
      .prepare("UPDATE devices SET scopes = ? WHERE id = ?")
      .run('["node","operator.read"]', m.deviceId);
    expect(await m.client.request("devices.list", {})).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  });
});

describe("machine names: lookalikes and squatting (r2 findings 2 and 3)", () => {
  const SAME: [string, string][] = [
    ["lab-box", "l\u0430b-box"],
    ["lab-box", "lab_box"],
    ["lab-box", "lab\u2013box"],
    ["lab-box", "lab\u2010box"],
    ["This Mac", "This Mac."],
    ["This Mac", "ThisMac"],
    ["This Mac", "This-Mac"],
    ["This Mac", "\u03a4his Mac"],
    ["lab-box", "\uff4c\uff41\uff42\uff0d\uff42\uff4f\uff58"],
    ["lab-box", "\u217cab-box"],
  ];
  it.each(SAME)("%s and %s are one name", (a, b) => {
    expect(machineNameKey(a)).toBe(machineNameKey(b));
  });
  it("different names stay different", () => {
    for (const [a, b] of [
      ["lab-box", "lab-box 2"],
      ["lab-box", "lab-bay"],
      ["build", "builds"],
    ] as const) {
      expect(machineNameKey(a)).not.toBe(machineNameKey(b));
    }
  });
  it("mixed Latin and Cyrillic or Greek is refused; a whole-script name is not", () => {
    expect(isMixedScriptName("l\u0430b-box")).toBe(true);
    expect(isMixedScriptName("\u03a4his Mac")).toBe(true);
    expect(isMixedScriptName("lab-box")).toBe(false);
    expect(isMixedScriptName("\u0441\u0435\u0440\u0432\u0435\u0440")).toBe(false);
    expect(isMixedScriptName("\u5b9e\u9a8c\u673a")).toBe(false);
  });
  it("the Host's name without .local is reserved", async () => {
    const gw = await boot();
    const { machineNameRefusal } = await import("../src/nodes/machines.ts");
    const host = hostname();
    for (const name of [host, host.replace(/\.local$/iu, ""), "This Mac.", "ThisMac"]) {
      expect(machineNameRefusal(gw.gateway.context.db, name), name).toBe("reserved");
    }
  });
  it("an unpaired or revoked device does not hold a name", async () => {
    const gw = await boot();
    const { machineNameRefusal } = await import("../src/nodes/machines.ts");
    const db = gw.gateway.context.db;
    insertDevice(db, {
      id: "unpaired",
      name: "studio",
      platform: "linux",
      role: "client",
      publicKey: newDeviceKey().publicKey,
      pairedAt: null,
    });
    insertDevice(db, {
      id: "gone",
      name: "attic",
      platform: "linux",
      role: "client",
      publicKey: newDeviceKey().publicKey,
      pairedAt: new Date().toISOString(),
    });
    db.sqlite
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = 'gone'")
      .run(new Date().toISOString());
    expect(machineNameRefusal(db, "Studio")).toBeUndefined();
    expect(machineNameRefusal(db, "attic")).toBeUndefined();
    insertDevice(db, {
      id: "real",
      name: "studio2",
      platform: "linux",
      role: "client",
      publicKey: newDeviceKey().publicKey,
      pairedAt: new Date().toISOString(),
    });
    expect(machineNameRefusal(db, "Studio-2")).toBe("taken");
  });
});

describe("node.unpair tells the owner", () => {
  it("notifies when a machine removes itself, not when the owner removes it", async () => {
    const { machineChangeHook } = await import("../src/compose/machine-notices.ts");
    const notes: { title: string; message?: { titleKey: string } }[] = [];
    const hook = machineChangeHook({
      audit: { append: async (e) => e as never },
      notifier: {
        notify: async (n: never) => {
          notes.push(n);
          return n;
        },
      } as never,
    });
    hook({ change: "removed", machineId: "m", deviceId: "d", name: "lab-box", byDeviceId: "d" });
    hook({ change: "removed", machineId: "m2", deviceId: "d2", name: "x", byDeviceId: "admin" });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message?.titleKey).toBe("notice.machine.removed.title");
    expect(notes[0]?.title).toBe("lab-box removed itself");
  });
});

describe("machine names: two-way table (lookalikes, reserved, scripts)", () => {
  // Must collide with the first name, or be refused next to it.
  const COLLIDE: [string, string][] = [
    ["lab-box", "Iab-box"],
    ["lab-box", "1ab-box"],
    ["lab-box", "lab-b0x"],
    ["lab-box", "\u029fab-box"],
    ["lab-box", "l\u0251b-box"],
    ["lab-box", "\u04cf\u0430\u044c-\u0432\u043e\u0445"],
    ["MINI", "\u039c\u0399\u039d\u0399"],
    ["mini", "M1N1"],
    ["BOX", "\u0392\u039f\u03a7"],
    ["This Mac", "Th1s Mac"],
  ];
  it.each(COLLIDE)("%s and %s are one name", (a, b) => {
    expect(machineNameKey(a)).toBe(machineNameKey(b));
  });

  // Near misses that must stay different.
  const DIFFERENT: [string, string][] = [
    ["lab-box", "lab-bax"],
    ["lab-box", "lab-box 2"],
    ["build", "builds"],
    ["cafe", "caf\u00e9"],
    ["\u5b9e\u9a8c\u673a", "\u5b9e\u9a8c\u5ba4"],
    ["\u0915\u093f\u0924\u093e\u092c", "\u0915\u0924\u093e\u092c"],
    ["\u0995\u09bf\u09a4\u09be\u09ac", "\u0995\u09a4\u09be\u09ac"],
    ["\u0b95\u0bbf\u0b9f\u0bc1", "\u0b95\u0b9f\u0bc1"],
    ["\u30e9\u30dc", "\u30ea\u30dc"],
    ["\u043c\u0438\u043d\u0438", "\u043c\u0438\u043d\u044b"],
    ["\u03bc\u03b9\u03bd\u03b9", "\u03bc\u03b9\u03bd\u03b1"],
  ];
  it.each(DIFFERENT)("%s and %s stay different", (a, b) => {
    expect(machineNameKey(a)).not.toBe(machineNameKey(b));
  });

  it("reserved names, with digits, lookalikes and the mDNS label, are refused; others are allowed", async () => {
    const gw = await boot();
    const db = gw.gateway.context.db;
    const { defaultHostLabel } = await import("../src/lan/names.ts");
    for (const name of [
      "This Mac",
      "This Mac 2",
      "Thismac2",
      "this-mac 10",
      "This computer 3",
      "Th1s Mac",
      defaultHostLabel(),
      `${defaultHostLabel()} 2`,
      hostname(),
    ]) {
      expect(machineNameRefusal(db, name), name).toBe("reserved");
    }
    for (const name of [
      "lab-box",
      "lab-box 2",
      "Linux computer",
      "\u5b9e\u9a8c\u673a",
      "caf\u00e9",
    ]) {
      expect(machineNameRefusal(db, name), name).toBeUndefined();
    }
  });

  it("lookalikes of a paired machine are taken", async () => {
    const gw = await boot();
    const db = gw.gateway.context.db;
    insertDevice(db, {
      id: "lab",
      name: "lab-box",
      platform: "linux",
      role: "node",
      publicKey: newDeviceKey().publicKey,
      scopes: ["node"],
      pairedAt: new Date().toISOString(),
    });
    for (const name of ["Iab-box", "1ab-box", "lab-b0x", "\u029fab-box", "l\u0251b-box"]) {
      expect(machineNameRefusal(db, name), name).toBe("taken");
    }
    expect(machineNameRefusal(db, "lab-bay")).toBeUndefined();
  });
});
