import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { NodeAgent } from "../src/agent.ts";
import { Backoff } from "../src/backoff.ts";
import { parseArgs } from "../src/config.ts";
import { generateIdentity, identityPath, loadOrCreateIdentity } from "../src/identity.ts";
import { ChannelEvents, type FrameChannel } from "../src/transports/channel.ts";
import { NdjsonChannel } from "../src/transports/ndjson.ts";
import { channelFactory, planTransports, type TransportOpeners } from "../src/transports/select.ts";
import { openUnixSocket } from "../src/transports/unix.ts";
import { bridgeArgv, detectVmGuest, openVsock } from "../src/transports/vsock.ts";
import { openWebSocket } from "../src/transports/ws.ts";
import { FakeGateway } from "./fake-gateway.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  // Short paths: macOS limits Unix socket paths to 104 bytes.
  const dir = mkdtempSync(join(tmpdir(), "pn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serveFakeOverUnix(gw: FakeGateway, path: string): Promise<Server> {
  const server = createServer((socket) => {
    const ndjson = NdjsonChannel.fromDuplex("test", socket);
    void gw.connect().then((node) => {
      // node <-> gateway in memory; relay ndjson <-> node side.
      node.onFrame((f) => ndjson.send(f));
      ndjson.onFrame((f) => node.send(f));
      ndjson.onClose(() => node.close("socket closed"));
      node.onClose(() => ndjson.close("gateway closed"));
    });
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

async function pairOver(connect: () => Promise<FrameChannel>, gw: FakeGateway) {
  const paired = gw.nextPaired();
  const agent = new NodeAgent({
    identity: generateIdentity(),
    name: "t",
    platform: "linux",
    deviceFamily: "vm-guest",
    version: "0",
    providers: [
      {
        id: "t",
        async entries() {
          return [
            {
              manifest: { name: "test.ping", sideEffect: "none" as const },
              handler: async () => ({ ok: true as const, result: "pong" }),
            },
          ];
        },
      },
    ],
    connect,
    backoff: new Backoff({ initialMs: 5, maxMs: 10 }),
  });
  cleanups.push(() => agent.stop());
  void agent.start();
  await paired;
  return agent;
}

describe("transports", () => {
  it("pairs and invokes over NDJSON on a Unix socket", async () => {
    const gw = new FakeGateway();
    const path = join(tempDir(), "gw.sock");
    await serveFakeOverUnix(gw, path);
    await pairOver(() => openUnixSocket(path), gw);
    const r = await (await gw.invoke("test.ping", {})).result;
    expect(r).toMatchObject({ ok: true, result: "pong" });
  });

  it("pairs over a WebSocket without an Origin header and without a token in the URL", async () => {
    const gw = new FakeGateway();
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    const seen: { origin: string | undefined; url: string | undefined }[] = [];
    wss.on("connection", (ws, req) => {
      seen.push({ origin: req.headers.origin, url: req.url });
      void gw.connect().then((node) => {
        node.onFrame((f) => ws.send(f));
        ws.on("message", (d) => node.send(d.toString()));
        ws.on("close", () => node.close("ws closed"));
      });
    });
    await new Promise((r) => wss.on("listening", r));
    const { port } = wss.address() as { port: number };
    await pairOver(() => openWebSocket(`ws://127.0.0.1:${port}`), gw);
    expect(seen[0]).toEqual({ origin: undefined, url: "/ws" });
    const r = await (await gw.invoke("test.ping", {})).result;
    expect(r.ok).toBe(true);
  });

  it("refuses URLs that carry credentials or a query", () => {
    expect(() => openWebSocket("ws://u:p@127.0.0.1:1/ws")).toThrow(/credentials/);
    expect(() => openWebSocket("ws://127.0.0.1:1/ws?token=x")).toThrow(/query/);
    expect(() => openWebSocket("http://127.0.0.1:1/ws")).toThrow(/ws:\/\//);
  });

  it("speaks NDJSON through a vsock bridge process (simulated with a stdio relay)", async () => {
    const gw = new FakeGateway();
    const dir = tempDir();
    const path = join(dir, "gw.sock");
    await serveFakeOverUnix(gw, path);
    // Stands in for `socat - VSOCK-CONNECT:2:<port>`: relays stdio to the Unix socket.
    const relay = join(dir, "relay.mjs");
    writeFileSync(
      relay,
      `import { createConnection } from "node:net";
const s = createConnection(process.argv[2]);
process.stdin.pipe(s); s.pipe(process.stdout);
s.on("close", () => process.exit(0));`,
    );
    const endpoint = { cid: 2, port: 7980, bridge: [process.execPath, relay, path] };
    await pairOver(() => openVsock(endpoint), gw);
    const r = await (await gw.invoke("test.ping", {})).result;
    expect(r).toMatchObject({ ok: true, result: "pong" });
  });

  it("builds the socat bridge on Linux and needs an explicit bridge elsewhere", () => {
    expect(bridgeArgv({ cid: 2, port: 7980 }, "linux")).toEqual([
      "socat",
      "-",
      "VSOCK-CONNECT:2:7980",
    ]);
    expect(() => bridgeArgv({ cid: 2, port: 7980 }, "darwin")).toThrow(/PSYCHE_NODE_VSOCK_BRIDGE/);
  });

  it("detects a VM guest", () => {
    const probe = (platform: NodeJS.Platform, vsock: boolean, vmm: string | null) => ({
      platform,
      exists: (p: string) => vsock && p === "/dev/vsock",
      sysctl: () => vmm,
    });
    expect(detectVmGuest(probe("linux", true, null))).toBe(true);
    expect(detectVmGuest(probe("linux", false, null))).toBe(false);
    expect(detectVmGuest(probe("darwin", false, "1"))).toBe(true);
    expect(detectVmGuest(probe("darwin", false, "0"))).toBe(false);
  });
});

describe("transport selection", () => {
  const openers: TransportOpeners = {
    ws: async () => fail("ws"),
    unix: async () => fail("unix"),
    vsock: async () => fail("vsock"),
  };
  function fail(kind: string): never {
    throw new Error(`${kind} down`);
  }

  it("prefers vsock in a guest, then the configured socket and URL", () => {
    const plans = planTransports(
      {
        vsock: { cid: 2, port: 1 },
        socket: "/s",
        url: "ws://h/ws",
        isGuest: true,
        defaultUrl: "ws://d/ws",
      },
      openers,
    );
    expect(plans.map((p) => p.kind)).toEqual(["vsock", "unix", "ws"]);
  });

  it("puts vsock last outside a guest", () => {
    const plans = planTransports(
      { vsock: { cid: 2, port: 1 }, url: "ws://h/ws", isGuest: false, defaultUrl: "ws://d/ws" },
      openers,
    );
    expect(plans.map((p) => p.kind)).toEqual(["ws", "vsock"]);
  });

  it("defaults to a local node socket, then loopback WS", () => {
    const plans = planTransports(
      { isGuest: false, localSocket: "/r/node.sock", defaultUrl: "ws://d/ws" },
      openers,
    );
    expect(plans.map((p) => p.describe)).toEqual(["unix:/r/node.sock", "ws://d/ws"]);
  });

  it("falls through plans and reports every failure", async () => {
    const ok = new ChannelEvents();
    const channel: FrameChannel = {
      describe: "ok",
      send() {},
      onFrame: (l) => ok.onFrame(l),
      onClose: (l) => ok.onClose(l),
      close() {},
    };
    const factory = channelFactory([
      { kind: "vsock", describe: "a", open: async () => fail("a") },
      { kind: "ws", describe: "b", open: async () => channel },
    ]);
    expect(await factory()).toBe(channel);
    const none = channelFactory([{ kind: "ws", describe: "b", open: async () => fail("b") }]);
    await expect(none()).rejects.toThrow(/no Gateway reachable \(b: b down\)/);
  });
});

describe("identity and config", () => {
  it("creates the identity file 0600 and reloads the same key", () => {
    const home = tempDir();
    const a = loadOrCreateIdentity(home);
    expect(statSync(identityPath(home)).mode & 0o777).toBe(0o600);
    const b = loadOrCreateIdentity(home);
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses an identity file readable by others", async () => {
    const home = tempDir();
    loadOrCreateIdentity(home);
    const { chmodSync } = await import("node:fs");
    chmodSync(identityPath(home), 0o644);
    expect(() => loadOrCreateIdentity(home)).toThrow(/must be 0600/);
  });

  it("reads node.json, env and flags; host exec only from the file", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "node.json"),
      JSON.stringify({
        name: "guest",
        gateway: { url: "ws://10.0.0.2:7979/ws", vsock: { port: 7980 } },
        fs: { roots: [{ path: home, mode: "ro" }] },
        exec: { host: { enabled: true, cwdRoots: [home] } },
      }),
    );
    const { config, command } = parseArgs(["run", "--home", home, "--name", "flagged"], {
      PSYCHE_NODE_VSOCK_BRIDGE: '["my-bridge","{cid}","{port}"]',
    });
    expect(command).toBe("run");
    expect(config.name).toBe("flagged");
    expect(config.gateway).toEqual({
      url: "ws://10.0.0.2:7979/ws",
      vsock: { cid: 2, port: 7980, bridge: ["my-bridge", "{cid}", "{port}"] },
    });
    expect(config.fs.roots).toEqual([{ path: home, mode: "ro" }]);
    expect(config.exec.host).toEqual({ enabled: true, cwdRoots: [home] });
    const plain = parseArgs(["--home", tempDir()], {});
    expect(plain.config.exec.host.enabled).toBe(false);
    expect(() => parseArgs(["--host-exec", "on"], {})).toThrow(/unknown option/);
    expect(() => parseArgs(["--vsock", "nope"], {})).toThrow(/CID:PORT/);
  });

  it("rejects relative fs roots", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "node.json"),
      JSON.stringify({ fs: { roots: [{ path: "rel", mode: "rw" }] } }),
    );
    expect(() => parseArgs(["--home", home], {})).toThrow(/absolute/);
  });
});
