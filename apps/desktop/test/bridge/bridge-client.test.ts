import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeEventName,
  type BridgeTab,
  PsycheError,
  validateBridgeEventPayload,
} from "@psyche/protocol";
import { MockGateway } from "@psyche/web/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient, checkBridgeSocket } from "../../src/main/bridge/bridge-client.ts";
import {
  type BridgeHighlight,
  type BridgeHostEvents,
  type BridgeOpenOptions,
  type BridgeTabHost,
  TypedEmitter,
  type Unsubscribe,
} from "../../src/main/bridge/bridge-host.ts";

class FakeTabHost implements BridgeTabHost {
  readonly emitter = new TypedEmitter<BridgeHostEvents>();
  readonly tabs = new Map<string, BridgeTab>();
  readonly sent: { tabId: string; method: string; params: unknown; sessionId?: string }[] = [];
  readonly statuses: { tabId: string; text: string | null; highlight?: BridgeHighlight }[] = [];
  cdpImpl: (method: string, params: Record<string, unknown> | undefined) => unknown = () => ({});
  private n = 0;

  list(): BridgeTab[] {
    return [...this.tabs.values()];
  }
  async open(opts: BridgeOpenOptions): Promise<BridgeTab> {
    const tab: BridgeTab = {
      tabId: `tab_${++this.n}`,
      url: opts.url,
      title: "",
      partition: "persist:agent-default",
      profile: opts.profile ?? "logged-in",
      attached: true,
      openerTabId: null,
      taskId: opts.taskId ?? null,
    };
    this.tabs.set(tab.tabId, tab);
    this.emitter.emit("tabCreated", { tab });
    return tab;
  }
  private need(tabId: string): BridgeTab {
    const t = this.tabs.get(tabId);
    if (!t) throw new PsycheError("tab_not_found", `no tab ${tabId}`);
    return t;
  }
  async close(tabId: string): Promise<void> {
    this.need(tabId);
    this.tabs.delete(tabId);
    this.emitter.emit("tabClosed", { tabId });
  }
  async attach(tabId: string): Promise<BridgeTab> {
    return this.need(tabId);
  }
  async detach(tabId: string): Promise<void> {
    this.need(tabId);
  }
  async cdpSend(
    tabId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<unknown> {
    this.need(tabId);
    this.sent.push({ tabId, method, params, ...(sessionId ? { sessionId } : {}) });
    return this.cdpImpl(method, params);
  }
  async setStatus(tabId: string, text: string | null, highlight?: BridgeHighlight): Promise<void> {
    this.need(tabId);
    this.statuses.push({ tabId, text, ...(highlight ? { highlight } : {}) });
  }
  on<E extends keyof BridgeHostEvents>(
    event: E,
    cb: (payload: BridgeHostEvents[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, cb);
  }
}

const SECRET = "s3cret-handshake";

let dir: string;
let sockPath: string;
let gw: MockGateway | undefined;
let client: BridgeClient | undefined;
let host: FakeTabHost;
const extraServers: Server[] = [];

function writeSecret(s: string): void {
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "run", "handshake.secret"), `${s}\n`, { mode: 0o600 });
}

async function startGateway(): Promise<MockGateway> {
  gw = await new MockGateway({ bridgeSocketPath: sockPath, handshakeSecret: SECRET }).start();
  return gw;
}

function startClient(): BridgeClient {
  client = new BridgeClient({
    socketPath: sockPath,
    psycheHome: dir,
    desktopVersion: "0.0.0-test",
    host,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    random: () => 0.5,
  });
  client.start();
  return client;
}

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pb-"));
  sockPath = join(dir, "b.sock");
  host = new FakeTabHost();
  writeSecret(SECRET);
});

afterEach(async () => {
  await client?.stop();
  client = undefined;
  await gw?.stop();
  gw = undefined;
  for (const s of extraServers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("BridgeClient", () => {
  it("connects, says hello with the secret and reports connected", async () => {
    await startGateway();
    const changes: boolean[] = [];
    const c = startClient();
    c.onConnectedChange((on) => changes.push(on));
    const peer = await (gw as MockGateway).waitForBridge();
    expect(peer.hello).toEqual({ protocolVersion: 1, desktopVersion: "0.0.0-test" });
    await until(() => c.connected);
    expect(changes).toEqual([true]);
    expect(c.status().attempt).toBe(0);
  });

  it("is rejected with a wrong secret and re-reads the secret on retry", async () => {
    writeSecret("wrong");
    await startGateway();
    const c = startClient();
    await until(() => (c.status().lastError ?? "").includes("unauthorized"));
    expect(c.connected).toBe(false);
    writeSecret(SECRET);
    await until(() => c.connected);
  });

  it("serves tabs.list, tab.open, tab.close and tab.status", async () => {
    await startGateway();
    startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    expect(await peer.call("bridge.tabs.list", {})).toEqual({ tabs: [] });
    const opened = (await peer.call("bridge.tab.open", {
      url: "https://example.com/",
      profile: "clean",
      taskId: "tsk_1",
    })) as { tab: BridgeTab };
    expect(opened.tab).toMatchObject({ tabId: "tab_1", url: "https://example.com/" });
    expect(((await peer.call("bridge.tabs.list")) as { tabs: BridgeTab[] }).tabs).toHaveLength(1);
    expect(
      await peer.call("bridge.tab.status", {
        tabId: "tab_1",
        text: "Clicking Sign in",
        highlight: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toEqual({ ok: true });
    expect(host.statuses).toEqual([
      { tabId: "tab_1", text: "Clicking Sign in", highlight: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
    expect(await peer.call("bridge.attach", { tabId: "tab_1" })).toMatchObject({
      tab: { tabId: "tab_1" },
    });
    expect(await peer.call("bridge.detach", { tabId: "tab_1" })).toEqual({ ok: true });
    expect(await peer.call("bridge.tab.close", { tabId: "tab_1" })).toEqual({ ok: true });
    await expect(peer.call("bridge.tab.close", { tabId: "tab_1" })).rejects.toMatchObject({
      code: "tab_not_found",
    });
  });

  it("validates params and maps errors", async () => {
    await startGateway();
    startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    await expect(peer.call("bridge.tab.open", { url: "file:///etc/passwd" })).rejects.toMatchObject(
      { code: "invalid_params" },
    );
    await expect(peer.call("bridge.nope", {})).rejects.toMatchObject({ code: "unknown_method" });
    await expect(peer.call("tabs.list", {})).rejects.toMatchObject({ code: "unknown_method" });
    await expect(
      peer.call("bridge.hello", { protocolVersion: 1, handshakeSecret: "x", desktopVersion: "1" }),
    ).rejects.toMatchObject({ code: "unknown_method" });
    await expect(
      peer.call("bridge.cdp.send", { tabId: "tab_1", method: "not a method" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("forwards cdp.send and maps host errors", async () => {
    await startGateway();
    startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    await host.open({ url: "https://example.com/" });
    host.cdpImpl = (method) => {
      if (method === "Input.insertText")
        throw new PsycheError("user_in_control", "the user is driving", { retryable: true });
      if (method === "Network.getCookies")
        throw new PsycheError("method_not_allowed", "not in the allowlist");
      if (method === "Page.crash") throw new Error("CDP said no");
      return { root: { nodeId: 1 } };
    };
    expect(
      await peer.call("bridge.cdp.send", {
        tabId: "tab_1",
        method: "DOM.getDocument",
        params: { depth: 1 },
        sessionId: "S1",
      }),
    ).toEqual({ result: { root: { nodeId: 1 } } });
    expect(host.sent).toEqual([
      { tabId: "tab_1", method: "DOM.getDocument", params: { depth: 1 }, sessionId: "S1" },
    ]);
    await expect(
      peer.call("bridge.cdp.send", {
        tabId: "tab_1",
        method: "Input.insertText",
        params: { text: "x" },
      }),
    ).rejects.toMatchObject({ code: "user_in_control", retryable: true });
    await expect(
      peer.call("bridge.cdp.send", { tabId: "tab_1", method: "Network.getCookies" }),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
    await expect(
      peer.call("bridge.cdp.send", { tabId: "tab_1", method: "Page.crash" }),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      peer.call("bridge.cdp.send", { tabId: "tab_9", method: "DOM.getDocument" }),
    ).rejects.toMatchObject({ code: "tab_not_found" });
  });

  it("pushes valid events with seq increasing from 0", async () => {
    await startGateway();
    const c = startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    await until(() => c.connected);
    const tab = await host.open({ url: "https://example.com/" });
    host.emitter.emit("tabUpdated", { tab: { ...tab, title: "Example" } });
    host.emitter.emit("cdpEvent", {
      tabId: tab.tabId,
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
    });
    host.emitter.emit("controlChanged", { tabId: tab.tabId, state: "user", via: "keyboard" });
    host.emitter.emit("debuggerDetached", { tabId: tab.tabId, reason: "target closed" });
    host.emitter.emit("download", {
      notice: {
        downloadId: "dl_1",
        tabId: tab.tabId,
        filename: "a.pdf",
        state: "completed",
        quarantined: true,
      },
      payload: {
        tabId: tab.tabId,
        downloadId: "dl_1",
        url: "https://example.com/a.pdf",
        filename: "a.pdf",
        mime: "application/pdf",
        state: "completed",
        bytes: 590,
        quarantinePath: "/q/1-a.pdf",
        at: new Date().toISOString(),
      },
    });
    await host.close(tab.tabId);
    await peer.waitForEvent("bridge.tab.closed");
    expect(peer.events.map((e) => e.event)).toEqual([
      "bridge.tab.created",
      "bridge.tab.updated",
      "bridge.cdp.event",
      "bridge.control.changed",
      "bridge.debugger.detached",
      "bridge.download",
      "bridge.tab.closed",
    ]);
    expect(peer.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const e of peer.events)
      expect(() => validateBridgeEventPayload(e.event as BridgeEventName, e.payload)).not.toThrow();
    expect(peer.events[5]?.payload).not.toHaveProperty("notice");
  });

  it("round-trips frames over 1 MiB in both directions", async () => {
    await startGateway();
    startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    await host.open({ url: "https://example.com/" });
    const big = "é".repeat(1_500_000); // 3 MB of UTF-8
    host.cdpImpl = (_m, params) => ({ nodes: [params?.text, big] });
    const res = (await peer.call("bridge.cdp.send", {
      tabId: "tab_1",
      method: "Accessibility.getFullAXTree",
      params: { text: "x".repeat(2_000_000) },
    })) as { result: { nodes: string[] } };
    expect(res.result.nodes[0]).toHaveLength(2_000_000);
    expect(res.result.nodes[1]).toBe(big);
    host.emitter.emit("cdpEvent", {
      tabId: "tab_1",
      method: "Page.screencastFrame",
      params: { data: big },
    });
    const ev = (await peer.waitForEvent("bridge.cdp.event")) as { params: { data: string } };
    expect(ev.params.data).toBe(big);
  });

  it("answers with an error instead of sending a result over 16 MiB", async () => {
    await startGateway();
    startClient();
    const peer = await (gw as MockGateway).waitForBridge();
    await host.open({ url: "https://example.com/" });
    host.cdpImpl = () => ({ data: "x".repeat(17 * 1_048_576) });
    await expect(
      peer.call("bridge.cdp.send", { tabId: "tab_1", method: "DOMSnapshot.captureSnapshot" }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("reconnects after the Gateway restarts and restarts seq at 0", async () => {
    await startGateway();
    const c = startClient();
    const changes: boolean[] = [];
    c.onConnectedChange((on) => changes.push(on));
    let peer = await (gw as MockGateway).waitForBridge();
    await until(() => c.connected);
    await host.open({ url: "https://example.com/" });
    await peer.waitForEvent("bridge.tab.created");
    await (gw as MockGateway).stop();
    await until(() => !c.connected);
    await startGateway();
    peer = await (gw as MockGateway).waitForBridge();
    await until(() => c.connected);
    expect(changes).toEqual([true, false, true]);
    await host.open({ url: "https://example.org/" });
    const created = await peer.waitForEvent("bridge.tab.created");
    expect(created).toMatchObject({ tab: { tabId: "tab_2" } });
    expect(peer.events[0]?.seq).toBe(0);
    expect(await peer.call("bridge.tabs.list")).toMatchObject({ tabs: [{}, {}] });
  });

  it("refuses a socket with group or other permission bits", async () => {
    let accepted = 0;
    const srv = createServer((s) => {
      accepted++;
      s.destroy();
    });
    extraServers.push(srv);
    await new Promise<void>((r) => srv.listen(sockPath, r));
    chmodSync(sockPath, 0o660);
    expect(checkBridgeSocket(sockPath)).toBe("socket is accessible to group or others");
    const c = startClient();
    await until(() => c.status().attempt >= 3);
    expect(accepted).toBe(0);
    expect(c.status().lastError).toBe("socket is accessible to group or others");
    // Fixing the mode lets the next attempt through.
    chmodSync(sockPath, 0o600);
    await until(() => accepted > 0);
  });

  it("refuses paths that are not sockets and waits for a missing one", async () => {
    writeFileSync(join(dir, "plain"), "x");
    expect(checkBridgeSocket(join(dir, "plain"))).toBe("not a socket");
    expect(checkBridgeSocket(join(dir, "missing.sock"))).toBe("socket missing");
    const c = startClient();
    await until(() => c.status().attempt >= 2);
    expect(c.status().lastError).toBe("socket missing");
    await startGateway();
    await until(() => c.connected);
  });
});
