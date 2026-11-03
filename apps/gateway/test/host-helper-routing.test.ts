import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { NodeInfo } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { KEYCHAIN_CAPABILITIES } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import { computerHelper } from "../src/compose/computer.ts";
import { macHelper } from "../src/compose/connectors.ts";
import { dictationNode } from "../src/compose/dictation.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { speechNode } from "../src/compose/speech.ts";
import { HelperNodeClient } from "../src/compose/vault.ts";
import { silentLogger } from "../src/log.ts";
import type { Gateway } from "../src/server.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import {
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * R0 of the remote Gateway (docs/design/remote-gateway-2026.md §2.3, §4.1): every capability that
 * acts on the Host's own Mac (computer use, the Apple apps, Messages, the keychain, notifications,
 * speech, dictation, the screen ask, OCR, the on-device model, the sandbox Mac) goes to the Host's
 * own helper, the node on the Gateway's Unix node socket, and to no other node, however recently
 * that node connected and whatever it declares. A second Mac pairs as a node over the WebSocket
 * and says `mac-helper` too.
 */

let t: TestGateway | null = null;
let composed: ComposedGateway | null = null;
let home = "";
const nodes: FakeNode[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  await t?.cleanup();
  t = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const KEYCHAIN = [...Object.values(KEYCHAIN_CAPABILITIES), "keychain.status"];

/** Everything the Mac helper offers that is Host-bound, each answering with its own label. */
const HOST_BOUND = [
  "computer.ax_tree",
  "apps.list",
  "apps.applescript",
  "notify.show",
  "notify.subscribe",
  "notify.withdraw",
  "speech.transcribe_stream",
  "speech.transcribe_file",
  "dictation.target",
  "dictation.insert",
  "dictation.watch",
  "screen.context",
  "messages.send",
  "messages.watch",
  "messages.graph_read",
  "ocr.recognize",
  "llm.apple.generate",
  "vm.status",
  ...KEYCHAIN,
];

function handlers(label: string, names: string[] = HOST_BOUND): FakeNodeHandler[] {
  return names.map((name) => ({
    capability: { name, sideEffect: "read" as const, streaming: false },
    run: () => ({ who: label }),
  }));
}

async function start(): Promise<Gateway> {
  t = await startTestGateway();
  return t.gateway;
}

/** The Host's own helper: the Unix node socket, auto-paired with the handshake secret. */
async function hostHelper(
  g: Gateway,
  label: string,
  opts: { deviceId?: string; names?: string[] } = {},
): Promise<FakeNode> {
  const node = await FakeNode.connect(g.config.nodeSocketPath, {
    origin: g.origin,
    secret: g.handshakeSecret,
    handlers: handlers(label, opts.names),
    ...(opts.deviceId === undefined ? {} : { deviceId: opts.deviceId }),
  });
  nodes.push(node);
  return node;
}

/**
 * A second Mac's helper: an owner-approved node device that declares `mac-helper` over the
 * WebSocket, as it would from another machine on the tailnet.
 */
async function secondMac(g: Gateway, label: string, deviceId = "second-mac"): Promise<FakeNode> {
  const key = newDeviceKey();
  pairNodeDevice(g, deviceId, key);
  const node = await FakeNode.connectWs(wsUrlOf(g), {
    origin: g.origin,
    handlers: handlers(label),
    key,
    deviceId,
    deviceFamily: "mac-helper",
  });
  nodes.push(node);
  return node;
}

const gwOf = (g: Gateway) => () => g;
const nodeInfo = (g: Gateway, id: string): NodeInfo | undefined =>
  g.context.nodes.list().find((n) => n.id === id);

async function who(
  client: { invoke: (c: string, p: unknown) => Promise<unknown> } | undefined,
  cap: string,
) {
  const res = (await client?.invoke(cap, {})) as
    | { ok: boolean; result?: { who?: string } }
    | undefined;
  return res?.result?.who;
}

describe("a node's kind", () => {
  it("is mac-helper for the helper on the Unix node socket and remote for one over the WebSocket", async () => {
    const g = await start();
    const host = await hostHelper(g, "host");
    const other = await secondMac(g, "second");
    expect(nodeInfo(g, host.nodeId)?.kind).toBe("mac-helper");
    expect(nodeInfo(g, other.nodeId)?.kind).toBe("remote");
    expect(g.context.nodes.isHostHelper(host.nodeId)).toBe(true);
    expect(g.context.nodes.isHostHelper(other.nodeId)).toBe(false);
  });

  it("is remote for a WebSocket node that presents the handshake secret on loopback too", async () => {
    // Auto-pairing by the secret is unchanged (a same-user process on this Mac), but the family
    // is only a claim: only the Unix socket makes a node the Host's helper.
    const g = await start();
    const viaWs = await FakeNode.connectWs(wsUrlOf(g), {
      origin: g.origin,
      secret: g.handshakeSecret,
      handlers: handlers("loopback-ws"),
    });
    nodes.push(viaWs);
    expect(nodeInfo(g, viaWs.nodeId)?.kind).toBe("remote");
    expect(g.context.nodes.hostHelper()).toBeUndefined();
  });

  it("drops a stored mac-helper kind when the same device reconnects over the WebSocket", async () => {
    const g = await start();
    const key = newDeviceKey();
    const first = await FakeNode.connect(g.config.nodeSocketPath, {
      origin: g.origin,
      secret: g.handshakeSecret,
      handlers: handlers("a"),
      key,
      deviceId: "moving-mac",
    });
    nodes.push(first);
    expect(nodeInfo(g, first.nodeId)?.kind).toBe("mac-helper");
    await first.close();
    const second = await FakeNode.connectWs(wsUrlOf(g), {
      origin: g.origin,
      handlers: handlers("b"),
      key,
      deviceId: "moving-mac",
    });
    nodes.push(second);
    expect(nodeInfo(g, second.nodeId)?.kind).toBe("remote");
    expect(g.context.nodes.hostHelper()).toBeUndefined();
  });
});

describe("Host-bound capabilities with two Macs", () => {
  async function twoMacs(order: "host first" | "second first") {
    const g = await start();
    let host: FakeNode;
    let other: FakeNode;
    if (order === "host first") {
      host = await hostHelper(g, "host");
      other = await secondMac(g, "second");
    } else {
      other = await secondMac(g, "second");
      host = await hostHelper(g, "host");
    }
    return { g, host, other };
  }

  for (const order of ["host first", "second first"] as const) {
    it(`computer use, Apple apps, keychain, speech, dictation, Messages, OCR, the on-device model and the sandbox Mac reach only the Host helper (${order})`, async () => {
      const { g, host, other } = await twoMacs(order);
      const gw = gwOf(g);

      const computer = computerHelper(gw)();
      expect(computer?.nodeId).toBe(host.nodeId);
      expect(await who(computer?.client, "computer.ax_tree")).toBe("host");

      const apple = macHelper(gw)();
      expect(apple?.nodeId).toBe(host.nodeId);
      expect(apple?.capabilities).toContain("apps.applescript");
      expect((await apple?.invoke("apps.list", {}, {}))?.result).toEqual({ who: "host" });

      expect(await who(dictationNode(gw, "dictation.insert"), "dictation.insert")).toBe("host");
      expect(await who(dictationNode(gw, "screen.context"), "screen.context")).toBe("host");
      expect(await who(speechNode(gw)(), "speech.transcribe_stream")).toBe("host");
      expect(await who(speechNode(gw, "speech.transcribe_file")(), "speech.transcribe_file")).toBe(
        "host",
      );
      expect(await who(speechNode(gw, "apps.list")(), "apps.list")).toBe("host");

      const keychain = new HelperNodeClient(() => g.context.nodes);
      expect(keychain.nodeId).toBe(host.nodeId);
      expect(await who(keychain, "keychain.status")).toBe("host");

      for (const cap of [
        "messages.send",
        "messages.watch",
        "messages.graph_read",
        "ocr.recognize",
        "llm.apple.generate",
        "vm.status",
        "notify.show",
      ]) {
        const picked = g.context.nodes.hostHelper(cap);
        expect(picked?.info.id, cap).toBe(host.nodeId);
        expect(await who(picked?.client, cap), cap).toBe("host");
      }

      expect(other.invocations).toEqual([]);
      expect(host.invocations.length).toBeGreaterThan(10);
    });
  }

  it("never reaches the second Mac when the Host's helper is gone", async () => {
    const { g, host, other } = await twoMacs("host first");
    await host.close();
    await new Promise((r) => setTimeout(r, 50));
    const gw = gwOf(g);
    expect(computerHelper(gw)()).toBeUndefined();
    expect(macHelper(gw)()).toBeUndefined();
    expect(dictationNode(gw, "dictation.target")).toBeUndefined();
    expect(speechNode(gw)()).toBeUndefined();
    expect(new HelperNodeClient(() => g.context.nodes).nodeId).toBe("");
    expect(g.context.nodes.hostHelper()).toBeUndefined();
    expect(other.invocations).toEqual([]);
  });

  it("a helper that lacks the capability gets no call, and the second Mac does not fill in", async () => {
    const g = await start();
    const host = await hostHelper(g, "host", { names: ["apps.list"] });
    const other = await secondMac(g, "second");
    expect(computerHelper(gwOf(g))()).toBeUndefined();
    expect(macHelper(gwOf(g))()?.nodeId).toBe(host.nodeId);
    expect(other.invocations).toEqual([]);
  });
});

describe("an ambiguous Host denies", () => {
  it("two helpers on the node socket: nothing is picked, and it recovers when one leaves", async () => {
    const g = await start();
    const a = await hostHelper(g, "a", { deviceId: "helper-a" });
    const b = await hostHelper(g, "b", { deviceId: "helper-b" });
    const gw = gwOf(g);
    expect(computerHelper(gw)()).toBeUndefined();
    expect(macHelper(gw)()).toBeUndefined();
    expect(dictationNode(gw, "dictation.target")).toBeUndefined();
    expect(speechNode(gw)()).toBeUndefined();
    expect(new HelperNodeClient(() => g.context.nodes).nodeId).toBe("");
    expect(g.context.nodes.hostHelper("ocr.recognize")).toBeUndefined();
    // A pin by device id (Touch ID) still names one helper.
    expect(g.context.nodes.hostHelperOfDevice("helper-a")?.info.id).toBe(a.nodeId);
    expect(g.context.nodes.hostHelperOfDevice("helper-b")?.info.id).toBe(b.nodeId);
    expect(g.context.nodes.hostHelperOfDevice("second-mac")).toBeUndefined();
    expect(a.invocations).toEqual([]);
    expect(b.invocations).toEqual([]);

    await b.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(computerHelper(gw)()?.nodeId).toBe(a.nodeId);
  });

  it("the same helper reconnecting is one helper, not two", async () => {
    const g = await start();
    const key = newDeviceKey();
    const first = await FakeNode.connect(g.config.nodeSocketPath, {
      origin: g.origin,
      secret: g.handshakeSecret,
      handlers: handlers("one"),
      key,
      deviceId: "helper-x",
    });
    nodes.push(first);
    const again = await FakeNode.connect(g.config.nodeSocketPath, {
      origin: g.origin,
      secret: g.handshakeSecret,
      handlers: handlers("two"),
      key,
      deviceId: "helper-x",
    });
    nodes.push(again);
    expect(g.context.nodes.hostHelpers()).toHaveLength(1);
    expect(await who(computerHelper(gwOf(g))()?.client, "computer.ax_tree")).toBe("two");
  });
});

describe("through the Gateway's own methods", () => {
  async function setup() {
    home = mkdtempSync(join(tmpdir(), "psyche-hostrouting-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    return { g: composed.gateway, desk };
  }

  it("dictation.target goes to the Host helper, and a lone second Mac is unavailable", async () => {
    const { g, desk } = await setup();
    const other = await secondMac(g, "second");
    // Only a second Mac is connected: the desktop gets nothing, and the Mac gets nothing.
    await expect(desk.call("dictation.target", {})).rejects.toThrow(/"code":"unavailable"/);
    expect(other.invocations).toEqual([]);

    const host = await hostHelper(g, "host");
    expect(await desk.call("dictation.target", {})).toEqual({ who: "host" });
    expect(host.invocations.map((i) => i.capability)).toEqual(["dictation.target"]);
    expect(other.invocations).toEqual([]);
  });

  it("dictation.* and screen.capture refuse a paired device that is not the desktop shell, even one that says desktop", async () => {
    const { g } = await setup();
    const host = await hostHelper(g, "host");
    const key = newDeviceKey();
    // Approved by the owner with ordinary scopes, connecting without the handshake secret: a
    // paired device that declares `desktop` is still not the desktop shell (#278).
    const first = await TestClient.open(wsUrlOf(g));
    await handshake(first, g.origin, { key, deviceId: "lookalike", deviceFamily: "desktop" });
    first.close();
    updateDevice(g.context.db, "lookalike", {
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      pairedAt: new Date().toISOString(),
    });
    const plain = await TestClient.open(wsUrlOf(g));
    clients.push(plain);
    await handshake(plain, g.origin, { key, deviceId: "lookalike", deviceFamily: "desktop" });
    for (const [method, params] of [
      ["dictation.target", {}],
      ["dictation.insert", { text: "x" }],
      ["dictation.watch", { key: null }],
      ["screen.capture", { mode: "window" }],
    ] as const) {
      expect(await plain.request(method, params, ik()), method).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
    expect(host.invocations).toEqual([]);
  });

  it("screen.capture takes the Host helper's screen only", async () => {
    const { g, desk } = await setup();
    const other = await secondMac(g, "second");
    await expect(desk.call("screen.capture", { mode: "window" })).rejects.toThrow(
      /"code":"unavailable"/,
    );
    expect(other.invocations).toEqual([]);
  });

  it("with two Host helpers dictation is unavailable, not guessed", async () => {
    const { g, desk } = await setup();
    const a = await hostHelper(g, "a", { deviceId: "helper-a" });
    const b = await hostHelper(g, "b", { deviceId: "helper-b" });
    await expect(desk.call("dictation.target", {})).rejects.toThrow(/"code":"unavailable"/);
    expect(a.invocations).toEqual([]);
    expect(b.invocations).toEqual([]);
  });
});
