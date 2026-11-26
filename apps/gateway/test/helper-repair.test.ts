import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, upsertNode } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_AVAILABILITY_SETTING } from "../src/compose/helper-availability.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { HOST_HELPER_PIN_SETTING, HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import { FakeNode, pairNodeDevice } from "./fake-node.ts";
import {
  adminClient,
  desktopClient,
  ik,
  newDeviceKey,
  type TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * The helper re-pair audit (Nov 2026 logs): a Host helper that comes back under a new device id
 * must be used, two live Host helpers must be reported by name (never guessed between), and the
 * helper's availability must follow connect and disconnect at once.
 */

let composed: ComposedGateway | null = null;
let home = "";
const nodes: FakeNode[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-helperrepair-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const desk = await adminClient(composed.gateway);
  clients.push(desk);
  return { g: composed.gateway, desk };
}

const handlers = (label: string) =>
  ["apps.list", "computer.ax_tree"].map((name) => ({
    capability: { name, sideEffect: "read" as const, streaming: false },
    run: () => ({ who: label }),
  }));

async function helper(g: Gateway, label: string, deviceId: string): Promise<FakeNode> {
  const node = await FakeNode.connect(g.config.nodeSocketPath, {
    origin: g.origin,
    secret: g.handshakeSecret,
    handlers: handlers(label),
    deviceId,
  });
  nodes.push(node);
  return node;
}

const settle = () => new Promise((r) => setTimeout(r, 60));
/** What the app's banner reads; before the first change nothing is published (= not connected). */
const availability = (g: Gateway) =>
  (getSetting(g.context.db, HELPER_AVAILABILITY_SETTING)?.value ?? {
    connected: false,
    ambiguous: [],
  }) as {
    connected: boolean;
    ambiguous: { deviceId: string; name: string }[];
  };
const status = (g: Gateway) =>
  getSetting(g.context.db, HOST_HELPER_STATUS_SETTING)?.value as {
    ambiguous: boolean;
    helpers: number;
    candidates?: { deviceId: string; name: string }[];
  };
const hostId = (g: Gateway) => g.context.nodes.hostHelper()?.info.id;

describe("a Host helper that re-pairs under a new device id", () => {
  it("with the old connection open: refuses to guess, names both, and the pin settles it", async () => {
    const { g, desk } = await setup();
    const old = await helper(g, "old", "helper-old");
    const fresh = await helper(g, "fresh", "helper-new");
    expect(hostId(g)).toBeUndefined();
    expect(status(g)).toMatchObject({ ambiguous: true, helpers: 2 });
    expect(
      status(g)
        .candidates?.map((c) => c.deviceId)
        .sort(),
    ).toEqual(["helper-new", "helper-old"]);
    // The app's banner reads the availability setting: it names both, and is not just "offline".
    expect(availability(g).connected).toBe(false);
    expect(
      availability(g)
        .ambiguous.map((c) => c.deviceId)
        .sort(),
    ).toEqual(["helper-new", "helper-old"]);

    // "Use this one": the existing admin settings path, no new method.
    const res = await desk.request(
      "settings.set",
      { key: HOST_HELPER_PIN_SETTING, value: "helper-new" },
      ik(),
    );
    expect(JSON.stringify(res)).toContain('"ok":true');
    expect(hostId(g)).toBe(fresh.nodeId);
    expect(status(g)).toMatchObject({ ambiguous: false, helpers: 2 });
    expect(availability(g)).toMatchObject({ connected: true, ambiguous: [] });
    expect(old.invocations).toEqual([]);
  });

  it("with the old connection then closed: the new helper is used and the banner clears", async () => {
    const { g } = await setup();
    const old = await helper(g, "old", "helper-old");
    await helper(g, "fresh", "helper-new");
    expect(availability(g).ambiguous).toHaveLength(2);
    await old.close();
    await settle();
    expect(g.context.nodes.hostHelper()?.info.deviceId).toBe("helper-new");
    expect(g.context.nodes.isLive(old.nodeId)).toBe(false);
    expect(g.context.nodes.list().find((n) => n.id === old.nodeId)?.status).toBe("offline");
    expect(status(g)).toMatchObject({ ambiguous: false, helpers: 1 });
    expect(availability(g)).toMatchObject({ connected: true, ambiguous: [] });
  });

  it("with the old row left online by a crash and no connection: the new helper is simply used", async () => {
    const { g } = await setup();
    pairNodeDevice(g, "helper-stale", newDeviceKey());
    upsertNode(g.context.db, {
      id: "node-stale",
      deviceId: "helper-stale",
      kind: "mac-helper",
      capabilities: [],
      status: "online",
    });
    const fresh = await helper(g, "fresh", "helper-new");
    expect(hostId(g)).toBe(fresh.nodeId);
    expect(g.context.nodes.isLive("node-stale")).toBe(false);
    expect(status(g)).toMatchObject({ ambiguous: false, helpers: 1 });
  });

  it("a pin naming a device that is not a live Host helper never settles the ambiguity", async () => {
    const { g, desk } = await setup();
    await helper(g, "a", "helper-a");
    await helper(g, "b", "helper-b");
    await desk.request("settings.set", { key: HOST_HELPER_PIN_SETTING, value: "nobody" }, ik());
    expect(hostId(g)).toBeUndefined();
    expect(status(g).ambiguous).toBe(true);
  });
});

describe("a helper on another computer", () => {
  it("never becomes the Host, not even when it is the only one or is pinned", async () => {
    const { g, desk } = await setup();
    const key = newDeviceKey();
    pairNodeDevice(g, "second-mac", key);
    const other = await FakeNode.connectWs(wsUrlOf(g), {
      origin: g.origin,
      handlers: handlers("second"),
      key,
      deviceId: "second-mac",
      deviceFamily: "mac-helper",
    });
    nodes.push(other);
    expect(hostId(g)).toBeUndefined();
    expect(availability(g).connected).toBe(false);
    await desk.request("settings.set", { key: HOST_HELPER_PIN_SETTING, value: "second-mac" }, ik());
    expect(hostId(g)).toBeUndefined();

    // With the real Host helper alongside the pinned remote one: the Host helper is not displaced.
    const host = await helper(g, "host", "helper-host");
    expect(g.context.nodes.hostHelpers()).toHaveLength(1);
    expect(hostId(g)).toBe(host.nodeId);
    expect(status(g).ambiguous).toBe(false);
    expect(other.invocations).toEqual([]);
    expect(g.context.nodes.isHostHelper(other.nodeId)).toBe(false);
    expect(g.context.nodes.isHostHelper(host.nodeId)).toBe(true);
  });

  it("the helper itself cannot pin itself as the Host", async () => {
    const { g } = await setup();
    await helper(g, "a", "helper-a");
    await helper(g, "b", "helper-b");
    const self = await helper(g, "c", "helper-c");
    const res = await self.request("settings.set", {
      key: HOST_HELPER_PIN_SETTING,
      value: "helper-c",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(getSetting(g.context.db, HOST_HELPER_PIN_SETTING)?.value).toBeUndefined();
    expect(hostId(g)).toBeUndefined();
  });
});

describe("who may choose the Host helper", () => {
  it("a paired non-admin device cannot pin one", async () => {
    const { g } = await setup();
    await helper(g, "a", "helper-a");
    await helper(g, "b", "helper-b");
    const plain = await desktopClient(g);
    clients.push(plain);
    const res = await plain.request(
      "settings.set",
      { key: HOST_HELPER_PIN_SETTING, value: "helper-a" },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(hostId(g)).toBeUndefined();
  });
});

describe("the candidates the Gateway reports", () => {
  it("carry the Gateway's own pairing time, and only a device that may read settings sees them", async () => {
    const { g, desk } = await setup();
    await helper(g, "a", "helper-a");
    const b = await helper(g, "b", "helper-b");
    const read = (await desk.request("settings.get", {
      keys: [HOST_HELPER_STATUS_SETTING, HELPER_AVAILABILITY_SETTING],
    })) as {
      payload: { settings: Record<string, { candidates?: unknown[]; ambiguous?: unknown[] }> };
    };
    const settings = read.payload.settings;
    expect(settings[HOST_HELPER_STATUS_SETTING]?.candidates).toEqual([
      { deviceId: "helper-a", name: "Psyche helper", pairedAt: expect.any(String) },
      { deviceId: "helper-b", name: "Psyche helper", pairedAt: expect.any(String) },
    ]);
    expect(settings[HELPER_AVAILABILITY_SETTING]?.ambiguous).toHaveLength(2);
    // The helper's own connection has scope `node` only: no settings reads.
    const res = await b.request("settings.get", { keys: [HOST_HELPER_STATUS_SETTING] });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("liveness and the pin as a tie-breaker", () => {
  it("a connection that closed but has not detached yet is not a live helper", async () => {
    const { g } = await setup();
    const a = await helper(g, "a", "helper-a");
    const b = await helper(g, "b", "helper-b");
    expect(hostId(g)).toBeUndefined();
    const conn = [...g.context.connections()].find((c) => c.identity?.deviceId === "helper-a");
    expect(conn).toBeDefined();
    Object.defineProperty(conn, "open", { get: () => false });
    expect(g.context.nodes.hostHelpers().map((h) => h.info.id)).toEqual([b.nodeId]);
    expect(hostId(g)).toBe(b.nodeId);
    expect(g.context.nodes.isHostHelper(a.nodeId)).toBe(false);
    expect(g.context.nodes.isHostHelper(b.nodeId)).toBe(true);
    expect(g.context.nodes.ambiguousHelpers()).toEqual([]);
  });

  it("the pin settles a tie only: when the pinned helper leaves, the one left serves", async () => {
    const { g, desk } = await setup();
    const a = await helper(g, "a", "helper-a");
    const b = await helper(g, "b", "helper-b");
    await desk.request("settings.set", { key: HOST_HELPER_PIN_SETTING, value: "helper-a" }, ik());
    expect(hostId(g)).toBe(a.nodeId);
    await a.close();
    await settle();
    expect(hostId(g)).toBe(b.nodeId);
    expect(status(g)).toMatchObject({ ambiguous: false, helpers: 1 });
    // A new second helper is a tie again; the pin names a device that is gone, so nothing is chosen.
    await helper(g, "c", "helper-c");
    expect(hostId(g)).toBeUndefined();
    expect(status(g).ambiguous).toBe(true);
  });
});

describe("a Gateway restart", () => {
  /** Composes the Gateway again on the same home, with no helper connected. */
  async function recompose(): Promise<Gateway> {
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    return composed.gateway;
  }

  function expectNoStaleHelpers(g2: Gateway) {
    expect(g2.context.nodes.hostHelpers()).toEqual([]);
    expect(availability(g2)).toMatchObject({ connected: false, ambiguous: [] });
    expect(status(g2)).toMatchObject({ ambiguous: false, helpers: 0 });
  }

  it("stopped with both helpers still connected: nothing stale after the next start", async () => {
    const { g } = await setup();
    await helper(g, "a", "helper-a");
    await helper(g, "b", "helper-b");
    expect(availability(g).ambiguous).toHaveLength(2);
    expect(status(g)).toMatchObject({ ambiguous: true, helpers: 2 });
    // The helpers are not closed first: the change listener is unsubscribed before the Gateway
    // stops, so nothing cleans the persisted state on the way down.
    await composed?.stop("restart");
    composed = null;
    nodes.splice(0);
    expectNoStaleHelpers(await recompose());
  });

  it("a crash with no detach at all: nothing stale after the next start", async () => {
    const { g } = await setup();
    await helper(g, "a", "helper-a");
    await helper(g, "b", "helper-b");
    expect(availability(g).ambiguous).toHaveLength(2);
    (g.context.nodes as unknown as { detach: () => void }).detach = () => undefined;
    await composed?.stop("crash");
    composed = null;
    nodes.splice(0);
    expectNoStaleHelpers(await recompose());
  });
});

describe("helper availability follows the helper", () => {
  it("flips on connect and on disconnect without any job or search running", async () => {
    const { g } = await setup();
    const h = await helper(g, "host", "helper-1");
    expect(availability(g).connected).toBe(true);
    await h.close();
    await settle();
    expect(availability(g).connected).toBe(false);
    await helper(g, "host", "helper-2");
    expect(availability(g).connected).toBe(true);
  });
});
