import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";
import WebSocket from "ws";
import { silentLogger } from "../src/log.ts";
import { type Gateway, startGateway } from "../src/server.ts";

export interface TestGateway {
  gateway: Gateway;
  home: string;
  cleanup(): Promise<void>;
}

export async function startTestGateway(): Promise<TestGateway> {
  const home = mkdtempSync(join(tmpdir(), "psyche-gw-"));
  const gateway = await startGateway({
    config: { home, port: 0, dbPath: ":memory:", webRoot: null },
    env: {},
    logger: silentLogger,
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
