import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { connectSigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";
import WebSocket from "ws";
import { silentLogger } from "../src/log.ts";
import { type Gateway, type GatewayOptions, startGateway } from "../src/server.ts";

export interface TestGateway {
  gateway: Gateway;
  home: string;
  cleanup(): Promise<void>;
}

export async function startTestGateway(
  options: Omit<GatewayOptions, "config"> & {
    config?: GatewayOptions["config"];
    home?: string;
  } = {},
): Promise<TestGateway> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "psyche-gw-"));
  const { home: _h, config, limits, ...rest } = options;
  const gateway = await startGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    ...rest,
    config: { home, port: 0, dbPath: ":memory:", webRoot: null, ...config },
    // Tests open many pending requests from 127.0.0.1; the per-address limit has its own test.
    limits: { pairingsPerHour: 1000, ...limits },
  });
  return {
    gateway,
    home,
    async cleanup() {
      await gateway.stop("test");
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface DeviceKey {
  publicKey: string;
  privateKey: KeyObject;
}

export function newDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("no x");
  return { publicKey: jwk.x, privateKey };
}

type Json = Record<string, unknown>;

/** Minimal frame client over `ws` (supports custom Origin headers, unlike the global WebSocket). */
export class TestClient {
  readonly ws: WebSocket;
  readonly events: Json[] = [];
  readonly #waiting = new Map<string, (frame: Json) => void>();
  #next = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Json;
      if (frame.type === "res") this.#waiting.get(String(frame.id))?.(frame);
      else if (frame.type === "event") this.events.push(frame);
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  request(method: string, params?: unknown, idempotencyKey?: string): Promise<Json> {
    const id = `r${++this.#next}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.ws.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      );
    });
  }

  /** Resolves with the first event (already received or future) matching `pred`. */
  waitForEvent(pred: (frame: Json) => boolean, timeoutMs = 4000): Promise<Json> {
    const seen = this.events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off("message", onMessage);
        reject(new Error("timed out waiting for an event"));
      }, timeoutMs);
      const onMessage = () => {
        const hit = this.events.find(pred);
        if (hit) {
          clearTimeout(timer);
          this.ws.off("message", onMessage);
          resolve(hit);
        }
      };
      this.ws.on("message", onMessage);
    });
  }

  eventsNamed(name: string): Json[] {
    return this.events.filter((e) => e.event === name);
  }

  /** `request` that throws on an error response and returns the payload. */
  async call<T = Json>(method: string, params?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await this.request(method, params, idempotencyKey);
    if (res.ok !== true) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
    return res.payload as T;
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  async nextResponse(): Promise<Json> {
    return new Promise((resolve) => {
      this.ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Json));
    });
  }

  close(): void {
    this.ws.close();
  }
}

export interface HandshakeOptions {
  key?: DeviceKey;
  deviceId?: string;
  role?: "client" | "node";
  deviceFamily?: string;
  handshakeSecret?: string;
  tamperSignature?: boolean;
}

export async function handshake(client: TestClient, origin: string, opts: HandshakeOptions = {}) {
  const key = opts.key ?? newDeviceKey();
  const platform = "macos";
  const deviceFamily = opts.deviceFamily ?? "desktop";
  const challengeRes = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: opts.deviceId ?? `dev-${Math.random().toString(36).slice(2)}`,
    publicKey: key.publicKey,
    role: opts.role ?? "client",
    platform,
    deviceFamily,
    name: "test device",
    ...(opts.handshakeSecret === undefined ? {} : { handshakeSecret: opts.handshakeSecret }),
  });
  if (challengeRes.ok !== true) return { challengeRes, verifyRes: null, key };
  const challenge = challengeRes.payload as {
    nonce: string;
    serverOrigin: string;
    protocolVersion: number;
  };
  const payload = connectSigningPayload({
    nonce: challenge.nonce,
    platform,
    deviceFamily,
    protocolVersion: challenge.protocolVersion,
    serverOrigin: origin,
  });
  const signature = sign(null, payload, key.privateKey);
  if (opts.tamperSignature) signature[0] = (signature[0] ?? 0) ^ 0xff;
  const verifyRes = await client.request("connect.verify", {
    nonce: challenge.nonce,
    signature: signature.toString("base64url"),
  });
  return { challengeRes, verifyRes, key };
}

let keySeq = 0;
/** A fresh idempotency key. */
export function ik(): string {
  return `k${++keySeq}-${Math.random().toString(36).slice(2)}`;
}

export function wsUrlOf(gateway: Gateway): string {
  return `ws://127.0.0.1:${gateway.port}/ws`;
}

/** The desktop, auto-paired with the handshake secret (read, write, approvals). */
export async function desktopClient(
  gateway: Gateway,
  key = newDeviceKey(),
  deviceId?: string,
): Promise<TestClient> {
  const c = await TestClient.open(wsUrlOf(gateway));
  const r = await handshake(c, gateway.origin, {
    key,
    handshakeSecret: gateway.handshakeSecret,
    ...(deviceId ? { deviceId } : {}),
  });
  if ((r.verifyRes?.payload as { phase?: string } | undefined)?.phase !== "paired") {
    throw new Error(`desktop did not pair: ${JSON.stringify(r.verifyRes)}`);
  }
  return c;
}

/** A device the owner granted every operator scope (what `psyched devices grant` does). */
export async function adminClient(gateway: Gateway): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `admin-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(gateway, key, deviceId);
  first.close();
  updateDevice(gateway.context.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  return desktopClient(gateway, key, deviceId);
}

/** The `connect.verify` payload of a handshake (tests assert on its fields). */
export function verified<T>(res: { verifyRes: Json | null }): T {
  return res.verifyRes?.payload as T;
}
