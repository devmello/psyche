import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDeviceFamily, getSetting, setSetting } from "@psyche/db";
import type { NodeInfo } from "@psyche/protocol";
import { isNamedPipePath } from "@psyche/protocol/platform";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerHelper } from "../src/compose/computer.ts";
import { dictationNode } from "../src/compose/dictation.ts";
import { composeHelper, helperPresenceVerifier } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  HOST_HELPER_PIN_SETTING,
  HOST_HELPER_STATUS_SETTING,
  NodeRegistry,
} from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import { resolveGuestSocketPath, resolveNodeSocketPath } from "../src/socket-path.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import {
  desktopClient,
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Who counts as the Host's own Mac helper (remote-gateway design §4.1, review of #1167). The
 * `deviceFamily` a node declares proves nothing: the sandbox guest's psyche-node reaches the
 * Gateway through the Host helper's relay, and its identity file is readable inside the guest, so
 * a guest can reconnect as `mac-helper`. The Host helper is the `mac-helper` on the node socket
 * that presents the per-launch handshake secret; the family is pinned at pairing; a Mac helper
 * never pairs by owner approval; and guests arrive on their own socket.
 */

let t: TestGateway | null = null;
const nodes: FakeNode[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  await t?.cleanup();
  t = null;
});

const CAPS: FakeNodeHandler[] = ["computer.ax_tree", "dictation.target", "notify.show"].map(
  (name) => ({
    capability: { name, sideEffect: "read" as const, streaming: false },
    run: () => ({ who: name }),
  }),
);

async function start(): Promise<Gateway> {
  t = await startTestGateway();
  return t.gateway;
}

function guestSocket(g: Gateway): string {
  const path = g.config.guestSocketPath;
  if (path === null) throw new Error("no guest socket");
  return path;
}

async function track(p: Promise<FakeNode>): Promise<FakeNode> {
  const n = await p;
  nodes.push(n);
  return n;
}

const info = (g: Gateway, id: string): NodeInfo | undefined =>
  g.context.nodes.list().find((n) => n.id === id);

// Sandbox guest VMs (Virtualization.framework) and their relay socket are macOS only: a Windows
// Gateway has no guest socket (`resolveGuestSocketPath` is null there).
describe.skipIf(process.platform === "win32")("a sandbox guest relayed to the Gateway", () => {
  it("listens on its own socket, next to the node socket", async () => {
    const g = await start();
    expect(guestSocket(g)).not.toBe(g.config.nodeSocketPath);
    expect(existsSync(guestSocket(g))).toBe(true);
    expect(resolveGuestSocketPath("/h/run/node.sock", undefined)).toBe("/h/run/guest.sock");
    expect(resolveGuestSocketPath("/tmp/psyche-1/abc.sock", undefined)).toBe(
      "/tmp/psyche-1/abc-guest.sock",
    );
  });

  it("a guest that copied its identity and declares mac-helper never becomes the Host helper", async () => {
    const g = await start();
    // The guest's own device, approved by the owner as a vm-guest, as in a real VM setup.
    const key = newDeviceKey();
    pairNodeDevice(g, "guest-psyche-node", key);
    const asGuest = await track(
      FakeNode.connect(guestSocket(g), {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "guest-psyche-node",
        deviceFamily: "vm-guest",
      }),
    );
    expect(info(g, asGuest.nodeId)?.kind).toBe("vm-guest");
    await asGuest.close();

    // Sandbox code reads identity.json and reconnects declaring mac-helper: refused, the family
    // is pinned.
    await expect(
      FakeNode.connect(guestSocket(g), {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "guest-psyche-node",
        deviceFamily: "mac-helper",
      }),
    ).rejects.toThrow(/device family mismatch/);
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("even a guest device with no pinned family and even the right secret is not the Host helper", async () => {
    const g = await start();
    // Worst case: a device paired before the family column existed (NULL) and a leaked secret.
    const key = newDeviceKey();
    pairNodeDevice(g, "legacy-guest", key);
    expect(getDeviceFamily(g.context.db, "legacy-guest")).toBeNull();
    const node = await track(
      FakeNode.connect(guestSocket(g), {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
        key,
        deviceId: "legacy-guest",
        deviceFamily: "mac-helper",
      }),
    );
    expect(info(g, node.nodeId)?.kind).toBe("remote");
    expect(g.context.nodes.isHostHelper(node.nodeId)).toBe(false);
    expect(g.context.nodes.hostHelper()).toBeUndefined();
    expect(computerHelper(() => g)()).toBeUndefined();
    expect(dictationNode(() => g, "dictation.target")).toBeUndefined();
  });

  it("a guest cannot auto-pair as a mac-helper over the relay, with or without the secret", async () => {
    const g = await start();
    for (const secret of [undefined, g.handshakeSecret]) {
      await expect(
        FakeNode.connect(guestSocket(g), {
          origin: g.origin,
          ...(secret === undefined ? {} : { secret }),
          handlers: CAPS,
          deviceFamily: "mac-helper",
        }),
      ).rejects.toThrow(/handshake secret on its own Mac/);
    }
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("a real helper stays the only Host helper when a guest declares mac-helper, so nothing is denied", async () => {
    const g = await start();
    const host = await track(
      FakeNode.connect(g.config.nodeSocketPath, {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
      }),
    );
    const key = newDeviceKey();
    pairNodeDevice(g, "legacy-guest", key);
    await track(
      FakeNode.connect(guestSocket(g), {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "legacy-guest",
        deviceFamily: "mac-helper",
      }),
    );
    expect(g.context.nodes.hostHelper("computer.ax_tree")?.info.id).toBe(host.nodeId);
  });
});

describe("the Host helper's proof", () => {
  it("a mac-helper on the node socket with a stale or missing secret is refused, so it reconnects with the current one", async () => {
    const g = await start();
    const key = newDeviceKey();
    const first = await track(
      FakeNode.connect(g.config.nodeSocketPath, {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
        key,
        deviceId: "helper-x",
      }),
    );
    expect(g.context.nodes.isHostHelper(first.nodeId)).toBe(true);
    await first.close();
    // Missing, or the previous launch's secret (the window around a Gateway restart): refused
    // (not accepted as an ordinary node, which would never retry), paired device or not.
    for (const secret of [undefined, "previous-launch-secret"]) {
      await expect(
        FakeNode.connect(g.config.nodeSocketPath, {
          origin: g.origin,
          ...(secret === undefined ? {} : { secret }),
          handlers: CAPS,
          key,
          deviceId: "helper-x",
        }),
      ).rejects.toThrow(/stale or missing handshake secret/);
    }
    // The helper re-reads the secret file and retries: it is the Host helper again.
    const retried = await track(
      FakeNode.connect(g.config.nodeSocketPath, {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
        key,
        deviceId: "helper-x",
      }),
    );
    expect(g.context.nodes.isHostHelper(retried.nodeId)).toBe(true);
    expect(g.context.nodes.hostHelper()?.info.id).toBe(retried.nodeId);
  });

  it("writes this launch's secret before the node socket accepts anyone, replacing a stale file atomically", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-race-"));
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    const secretFile = join(home, "run", "handshake.secret");
    // What a crash leaves behind: the previous launch's secret.
    writeFileSync(secretFile, "stale-secret\n", { mode: 0o600 });
    const starting = startTestGateway({ home });
    let seen = "";
    // The node endpoint: a Unix socket file, or on Windows a named pipe (no file: it is up once
    // a connect succeeds).
    const socket = resolveNodeSocketPath(home, undefined);
    const up = async () =>
      isNamedPipePath(socket)
        ? new Promise<boolean>((r) => {
            const probe = createConnection(socket);
            probe.once("connect", () => {
              probe.destroy();
              r(true);
            });
            probe.once("error", () => r(false));
          })
        : existsSync(socket);
    const deadline = Date.now() + 10_000;
    while (!(await up()) && Date.now() < deadline) await new Promise((r) => setImmediate(r));
    // The moment a helper could connect, the file already holds a fresh secret (and never
    // vanished in between).
    seen = readFileSync(secretFile, "utf8").trim();
    t = await starting;
    expect(seen).not.toBe("stale-secret");
    expect(seen).toBe(t.gateway.handshakeSecret);
    expect(readdirSync(join(home, "run")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a mac-helper never pairs by owner approval, over the node socket or the WebSocket", async () => {
    const g = await start();
    await expect(
      FakeNode.connect(g.config.nodeSocketPath, { origin: g.origin, handlers: CAPS }),
    ).rejects.toThrow(/stale or missing handshake secret/);
    await expect(
      FakeNode.connectWs(wsUrlOf(g), { origin: g.origin, handlers: CAPS }),
    ).rejects.toThrow(/handshake secret on its own Mac/);
    expect(g.context.db.sqlite.prepare("SELECT COUNT(*) AS n FROM devices").get()).toEqual({
      n: 0,
    });
  });
});

describe("the device family is pinned at pairing", () => {
  it("a paired device that reconnects declaring another family is denied", async () => {
    const g = await start();
    const key = newDeviceKey();
    pairNodeDevice(g, "phone-1", key);
    const first = await track(
      FakeNode.connectWs(wsUrlOf(g), {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "phone-1",
        deviceFamily: "phone",
      }),
    );
    expect(getDeviceFamily(g.context.db, "phone-1")).toBe("phone");
    await first.close();
    await expect(
      FakeNode.connectWs(wsUrlOf(g), {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "phone-1",
        deviceFamily: "mac-helper",
      }),
    ).rejects.toThrow(/device family mismatch/);
    // The pin did not move.
    expect(getDeviceFamily(g.context.db, "phone-1")).toBe("phone");
  });

  it("a client device cannot change family either", async () => {
    const g = await start();
    const key = newDeviceKey();
    const first = await desktopClient(g, key, "desk-1");
    first.close();
    const again = await TestClient.open(wsUrlOf(g));
    clients.push(again);
    const r = await handshake(again, g.origin, {
      key,
      deviceId: "desk-1",
      deviceFamily: "cli",
      handshakeSecret: g.handshakeSecret,
    });
    expect(r.verifyRes?.payload).toMatchObject({
      phase: "denied",
      reason: "device family mismatch",
    });
  });
});

describe("a pinned Host helper settles two helpers", () => {
  it("denies without a pin, reports the ambiguity, and uses the pinned device with one", async () => {
    const g = await start();
    const desk = await desktopClient(g);
    clients.push(desk);
    const a = await track(
      FakeNode.connect(g.config.nodeSocketPath, {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
        deviceId: "helper-a",
      }),
    );
    const b = await track(
      FakeNode.connect(g.config.nodeSocketPath, {
        origin: g.origin,
        secret: g.handshakeSecret,
        handlers: CAPS,
        deviceId: "helper-b",
      }),
    );
    expect(g.context.nodes.hostHelper()).toBeUndefined();
    expect(getSetting(g.context.db, HOST_HELPER_STATUS_SETTING)?.value).toEqual({
      ambiguous: true,
      helpers: 2,
    });
    await desk.waitForEvent(
      (e) =>
        e.event === "settings.changed" &&
        JSON.stringify(e.payload).includes(HOST_HELPER_STATUS_SETTING),
    );

    // The owner pins the helper the desktop launched (devices.* needs admin and presence).
    setSetting(g.context.db, HOST_HELPER_PIN_SETTING, "helper-b");
    expect(g.context.nodes.hostHelper("computer.ax_tree")?.info.id).toBe(b.nodeId);
    expect(dictationNode(() => g, "dictation.target")).toBeDefined();

    // A pin to a helper that is not connected settles nothing.
    setSetting(g.context.db, HOST_HELPER_PIN_SETTING, "helper-gone");
    expect(g.context.nodes.hostHelper()).toBeUndefined();

    // Back to one helper: status clears.
    await b.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(g.context.nodes.hostHelper()?.info.id).toBe(a.nodeId);
    expect(getSetting(g.context.db, HOST_HELPER_STATUS_SETTING)?.value).toEqual({
      ambiguous: false,
      helpers: 1,
    });
  });
});

describe("presence keys of devices that are not the Host helper", () => {
  const assertion = { kind: "helper" as const, deviceId: "d", signature: "x" };

  it("never verify, whatever key is registered", async () => {
    let asked = 0;
    const notHost = helperPresenceVerifier(
      () => {
        asked++;
        return "registered";
      },
      () => false,
    );
    expect(await notHost.verify(assertion, "challenge", "d")).toBe(false);
    expect(asked).toBe(0);
  });

  it("consult the key only for the Host helper's device", async () => {
    let asked = 0;
    const host = helperPresenceVerifier(
      () => {
        asked++;
        return undefined;
      },
      (id) => id === "d",
    );
    expect(await host.verify(assertion, "challenge", "d")).toBe(false);
    expect(asked).toBe(1);
  });
});

describe("the status of an ambiguous Host", () => {
  it("a status left by the previous run does not survive a restart", async () => {
    const g = await start();
    setSetting(g.context.db, HOST_HELPER_STATUS_SETTING, { ambiguous: true, helpers: 2 });
    // A new registry is what a restarted Gateway builds; nobody is connected yet.
    new NodeRegistry(g.context);
    expect(getSetting(g.context.db, HOST_HELPER_STATUS_SETTING)?.value).toEqual({
      ambiguous: false,
      helpers: 0,
    });
  });
});

describe("the helper plumbing talks only to Host helpers", () => {
  let composed: ComposedGateway | null = null;
  afterEach(async () => {
    await composed?.stop("test");
    composed = null;
  });

  it("a node that stops being the Host helper loses its subscription and gets no approval card", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-helperclient-"));
    try {
      composed = await composeGateway({
        env: {},
        logger: silentLogger,
        retentionIntervalMs: 0,
        background: false,
        config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
        model: { provider: new FakeModelProvider(), model: "fake/model" },
        parts: [(s) => composeHelper(s)],
      });
      const g = composed.gateway;
      const notifyCaps: FakeNodeHandler[] = [
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
      const card = () =>
        g.context.broker.requestApproval({
          kind: "policy_change",
          summary: "Change a security setting",
          details: {},
          bindingHash: "d".repeat(64),
          grantKey: "d".repeat(64),
          requestedBy: { runId: null, taskId: null, threadId: null },
          sideEffect: "destructive",
          surfaces: ["desktop", "notification"],
          scopesOffered: ["once"],
          taint: false,
        });

      const key = newDeviceKey();
      const host = await track(
        FakeNode.connect(g.config.nodeSocketPath, {
          origin: g.origin,
          secret: g.handshakeSecret,
          handlers: notifyCaps,
          key,
          deviceId: "helper-flip",
        }),
      );
      await vi.waitFor(() =>
        expect(host.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
      );
      await card();
      await vi.waitFor(() =>
        expect(host.invocations.map((i) => i.capability)).toContain("notify.show"),
      );

      // The same device reconnects without the proof (over the WebSocket, still declaring
      // mac-helper): paired, family unchanged, but no longer the Host helper.
      const flipped = await track(
        FakeNode.connectWs(wsUrlOf(g), {
          origin: g.origin,
          handlers: notifyCaps,
          key,
          deviceId: "helper-flip",
          deviceFamily: "mac-helper",
        }),
      );
      expect(g.context.nodes.isHostHelper(flipped.nodeId)).toBe(false);
      await card();
      await new Promise((r) => setTimeout(r, 100));
      // No subscription, no card, nothing: the plumbing never invokes a non-Host node.
      expect(flipped.invocations).toEqual([]);
    } finally {
      await composed?.stop("test");
      composed = null;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
