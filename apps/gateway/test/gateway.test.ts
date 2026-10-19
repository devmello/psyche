import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
} from "./helpers.ts";

let t: TestGateway;
let wsUrl: string;

beforeEach(async () => {
  t = await startTestGateway();
  wsUrl = `ws://127.0.0.1:${t.gateway.port}/ws`;
});

afterEach(async () => {
  await t.cleanup();
});

describe("HTTP", () => {
  it("serves a bare /healthz and /version", async () => {
    const health = await fetch(`${t.gateway.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const version = await (await fetch(`${t.gateway.origin}/version`)).json();
    expect(version).toMatchObject({ name: "psyched", protocolVersion: PROTOCOL_VERSION });
  });

  it("returns 404 for / when the web UI is not built", async () => {
    expect((await fetch(`${t.gateway.origin}/`)).status).toBe(404);
  });

  it("writes the handshake secret with mode 0600", () => {
    const path = join(t.home, "run", "handshake.secret");
    expect(readFileSync(path, "utf8").trim()).toBe(t.gateway.handshakeSecret);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("WebSocket origin validation", () => {
  it("rejects a foreign Origin with 403", async () => {
    await expect(TestClient.open(wsUrl, { origin: "https://evil.example" })).rejects.toThrow("403");
  });

  it("rejects upgrades on other paths", async () => {
    await expect(TestClient.open(`ws://127.0.0.1:${t.gateway.port}/other`)).rejects.toThrow("403");
  });

  it("accepts the Gateway's own origin", async () => {
    const c = await TestClient.open(wsUrl, { origin: t.gateway.origin });
    c.close();
  });
});

describe("pairing", () => {
  it("auto-pairs the desktop over loopback with the handshake secret", async () => {
    const c = await TestClient.open(wsUrl);
    const { verifyRes } = await handshake(c, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(verifyRes).toMatchObject({ ok: true, payload: { phase: "paired" } });
    // The handshake secret never buys operator.admin (S23 review PR-1-A).
    expect(verified<{ scopes: string[] }>({ verifyRes }).scopes).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
    ]);
    c.close();
  });

  it("does not auto-pair without the secret", async () => {
    const c = await TestClient.open(wsUrl);
    const { verifyRes } = await handshake(c, t.gateway.origin);
    expect(verifyRes).toMatchObject({ ok: true, payload: { phase: "pending" } });
    const res = await c.request("settings.get", {});
    expect(res).toMatchObject({ ok: false, error: { code: "pairing_pending" } });
    c.close();
  });

  it("never auto-pairs a connection that carries a browser Origin", async () => {
    const c = await TestClient.open(wsUrl, { origin: t.gateway.origin });
    const { verifyRes } = await handshake(c, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(verifyRes).toMatchObject({ ok: true, payload: { phase: "pending" } });
    c.close();
  });

  it("rejects a bad signature", async () => {
    const c = await TestClient.open(wsUrl);
    const { verifyRes } = await handshake(c, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
      tamperSignature: true,
    });
    expect(verifyRes).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("rejects a protocol version range that excludes the server", async () => {
    const c = await TestClient.open(wsUrl);
    const res = await c.request("connect", {
      protocolVersion: { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 2 },
      deviceId: "d1",
      publicKey: newDeviceKey().publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "x",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "protocol_version_mismatch" } });
  });

  it("refuses methods before pairing and unknown methods", async () => {
    const c = await TestClient.open(wsUrl);
    expect(await c.request("settings.get", {})).toMatchObject({
      ok: false,
      error: { code: "not_paired" },
    });
    expect(await c.request("nope.nothing", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
    c.close();
  });

  it("re-pairs a known device by key and denies a key mismatch", async () => {
    const key = newDeviceKey();
    const a = await TestClient.open(wsUrl);
    await handshake(a, t.gateway.origin, {
      key,
      deviceId: "dev-known",
      handshakeSecret: t.gateway.handshakeSecret,
    });
    a.close();
    const b = await TestClient.open(wsUrl);
    const again = await handshake(b, t.gateway.origin, { key, deviceId: "dev-known" });
    expect(again.verifyRes).toMatchObject({ ok: true, payload: { phase: "paired" } });
    b.close();
    const c = await TestClient.open(wsUrl);
    const other = await handshake(c, t.gateway.origin, { deviceId: "dev-known" });
    expect(other.verifyRes).toMatchObject({ ok: true, payload: { phase: "denied" } });
  });
});

describe("frames, settings and events", () => {
  async function paired(): Promise<TestClient> {
    const c = await TestClient.open(wsUrl);
    await handshake(c, t.gateway.origin, { handshakeSecret: t.gateway.handshakeSecret });
    return c;
  }

  it("answers invalid frames with invalid_frame", async () => {
    const c = await paired();
    c.sendRaw("{not json");
    expect(await c.nextResponse()).toMatchObject({
      type: "res",
      ok: false,
      error: { code: "invalid_frame" },
    });
    c.close();
  });

  it("sets and gets settings, emitting settings.changed with seq and stateVersion", async () => {
    const c = await paired();
    const watcher = await paired();
    const set = await c.request("settings.set", { key: "appearance.theme", value: "dark" }, "k1");
    expect(set).toMatchObject({
      ok: true,
      payload: { entry: { key: "appearance.theme", value: "dark" } },
    });
    const v1 = (set.payload as { stateVersion: number }).stateVersion;
    const get = await c.request("settings.get", { keys: ["appearance.theme"] });
    expect(get).toMatchObject({
      ok: true,
      payload: { settings: { "appearance.theme": "dark" }, stateVersion: v1 },
    });
    await c.request("settings.set", { key: "appearance.theme", value: "light" }, "k2");
    await new Promise((r) => setTimeout(r, 20));
    const changes = watcher.events.filter((e) => e.event === "settings.changed");
    expect(changes).toHaveLength(2);
    const [first, second] = changes as { seq: number; stateVersion: number }[];
    expect(second?.seq).toBeGreaterThan(first?.seq ?? Number.POSITIVE_INFINITY);
    expect(second?.stateVersion).toBe(v1 + 1);
    c.close();
    watcher.close();
  });

  it("requires idempotency keys and replays duplicates", async () => {
    const c = await paired();
    expect(await c.request("settings.set", { key: "appearance.b", value: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    const first = await c.request("settings.set", { key: "appearance.b", value: 1 }, "same");
    const replay = await c.request("settings.set", { key: "appearance.b", value: 1 }, "same");
    expect(replay.payload).toEqual(first.payload);
    expect(
      await c.request("settings.set", { key: "appearance.b", value: 2 }, "same"),
    ).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    c.close();
  });

  it("hides and protects internal setting keys", async () => {
    const c = await paired();
    const all = await c.request("settings.get", {});
    expect(
      Object.keys((all.payload as { settings: object }).settings).some((k) => k.startsWith("_")),
    ).toBe(false);
    expect(
      await c.request("settings.set", { key: "_gateway.stateVersion", value: 0 }, "x"),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    c.close();
  });

  it("returns not_implemented for methods S01 has not built yet", async () => {
    const c = await paired();
    expect(await c.request("tasks.list", {})).toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });
    c.close();
  });
});

describe("node socket", () => {
  it("issues a challenge to a node over the Unix socket with NDJSON frames", async () => {
    const socket = createConnection(t.gateway.config.nodeSocketPath);
    await new Promise<void>((r) => socket.once("connect", () => r()));
    if (process.platform !== "win32")
      expect(statSync(t.gateway.config.nodeSocketPath).mode & 0o777).toBe(0o600);
    const line = await new Promise<string>((resolve) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const i = buf.indexOf("\n");
        if (i !== -1) resolve(buf.slice(0, i));
      });
      socket.write(
        `${JSON.stringify({
          type: "req",
          id: "n1",
          method: "connect",
          params: {
            protocolVersion: { min: 1, max: PROTOCOL_VERSION },
            deviceId: "helper-1",
            publicKey: newDeviceKey().publicKey,
            role: "node",
            platform: "macos",
            deviceFamily: "mac-helper",
            name: "Psyche Helper",
            capabilities: [],
          },
        })}\n`,
      );
    });
    expect(JSON.parse(line)).toMatchObject({
      type: "res",
      id: "n1",
      ok: true,
      payload: { phase: "challenge" },
    });
    socket.destroy();
  });
});

describe("startup", () => {
  it("refuses a second Gateway on the same node socket without clobbering the first one's secret", async () => {
    const { startGateway } = await import("../src/server.ts");
    const { silentLogger } = await import("../src/log.ts");
    await expect(
      startGateway({
        config: { home: t.home, port: 0, dbPath: ":memory:", webRoot: null },
        env: {},
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(join(t.home, "run", "handshake.secret"), "utf8").trim()).toBe(
      t.gateway.handshakeSecret,
    );
    expect(statSync(t.gateway.config.nodeSocketPath).isSocket()).toBe(true);
  });
});

describe("review regressions", () => {
  it("lets the real desktop pair even if another process squatted on its device id", async () => {
    const squatter = await TestClient.open(wsUrl);
    const squat = await handshake(squatter, t.gateway.origin, { deviceId: "dev-desktop" });
    expect(squat.verifyRes).toMatchObject({ ok: true, payload: { phase: "pending" } });
    squatter.close();
    const real = await TestClient.open(wsUrl);
    const res = await handshake(real, t.gateway.origin, {
      deviceId: "dev-desktop",
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(res.verifyRes).toMatchObject({ ok: true, payload: { phase: "paired" } });
    real.close();
  });

  it("keeps the stored role of a paired device", async () => {
    const key = newDeviceKey();
    const a = await TestClient.open(wsUrl);
    await handshake(a, t.gateway.origin, {
      key,
      deviceId: "dev-r",
      handshakeSecret: t.gateway.handshakeSecret,
    });
    a.close();
    const b = await TestClient.open(wsUrl);
    const res = await handshake(b, t.gateway.origin, { key, deviceId: "dev-r", role: "node" });
    expect(res.verifyRes).toMatchObject({
      ok: true,
      payload: { phase: "denied", reason: "device role mismatch" },
    });
  });

  it("caps pending pairing requests", async () => {
    await t.cleanup();
    t = await startTestGateway({ limits: { pairingsPerHour: 1000, maxPendingPairings: 20 } });
    wsUrl = `ws://127.0.0.1:${t.gateway.port}/ws`;
    for (let i = 0; i < 20; i++) {
      const c = await TestClient.open(wsUrl);
      const r = await handshake(c, t.gateway.origin, { deviceId: `flood-${i}` });
      expect(r.verifyRes).toMatchObject({ payload: { phase: "pending" } });
      c.close();
    }
    const c = await TestClient.open(wsUrl);
    const r = await handshake(c, t.gateway.origin, { deviceId: "flood-20" });
    expect(r.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    c.close();
  });

  it("answers a malformed request with its own id when it had one", async () => {
    const c = await TestClient.open(wsUrl);
    c.sendRaw(JSON.stringify({ type: "req", id: "abc", method: 42 }));
    expect(await c.nextResponse()).toMatchObject({
      id: "abc",
      ok: false,
      error: { code: "invalid_frame" },
    });
    c.sendRaw("{nope");
    expect(await c.nextResponse()).toMatchObject({ id: "_unknown", ok: false });
    c.close();
  });

  it("does not send operator events to node-only devices", async () => {
    const op = await TestClient.open(wsUrl);
    await handshake(op, t.gateway.origin, { handshakeSecret: t.gateway.handshakeSecret });
    const node = await TestClient.open(wsUrl);
    const n = await handshake(node, t.gateway.origin, {
      role: "node",
      deviceFamily: "mac-helper",
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(n.verifyRes).toMatchObject({ ok: true, payload: { phase: "paired", scopes: ["node"] } });
    await op.request("settings.set", { key: "appearance.theme", value: "dark" }, "e1");
    await new Promise((r) => setTimeout(r, 20));
    expect(op.events.some((e) => e.event === "settings.changed")).toBe(true);
    expect(node.events.some((e) => e.event === "settings.changed")).toBe(false);
    op.close();
    node.close();
  });
});
