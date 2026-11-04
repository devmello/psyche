import { generateKeyPairSync, sign } from "node:crypto";
import { gatewaySigningPayload } from "@psyche/protocol";
import { GatewayConnection, Handshake, type WebSocketLike } from "@psyche/web/client";
import { describe, expect, it } from "vitest";
import {
  createGatewayVerifier,
  fingerprintOf,
  originMatchesDialed,
} from "../src/lib/gateway-identity.ts";

interface Identity {
  publicKey: string;
  signFor(input: { nonce: string; serverOrigin: string; devicePublicKey: string }): string;
}

function newIdentity(): Identity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return {
    publicKey: x,
    signFor: (input) => sign(null, gatewaySigningPayload(input), privateKey).toString("base64url"),
  };
}

const NONCE = Buffer.alloc(32, 9).toString("base64url");
const DEVICE = Buffer.alloc(32, 3).toString("base64url");
const REMOTE = "https://studio-mac.tail1234.ts.net";

function challenge(id: Identity, over: Partial<{ serverOrigin: string; device: string }> = {}) {
  const serverOrigin = over.serverOrigin ?? REMOTE;
  return {
    nonce: NONCE,
    serverOrigin,
    gatewayKey: id.publicKey,
    gatewaySignature: id.signFor({
      nonce: NONCE,
      serverOrigin,
      devicePublicKey: over.device ?? DEVICE,
    }),
  };
}

function strict(pinned: string | undefined, onPin: (k: string) => void = () => undefined) {
  let pin = pinned;
  return createGatewayVerifier({
    dialedOrigin: REMOTE,
    mode: "strict",
    pinnedKey: () => pin,
    pin: (k) => {
      pin = k;
      onPin(k);
    },
  });
}

describe("originMatchesDialed", () => {
  it("needs the same scheme, host and port", () => {
    expect(originMatchesDialed(REMOTE, REMOTE)).toBe(true);
    expect(originMatchesDialed(`${REMOTE}/`, REMOTE)).toBe(true);
    expect(originMatchesDialed(REMOTE, "https://other.tail1234.ts.net")).toBe(false);
    expect(originMatchesDialed(REMOTE, "http://studio-mac.tail1234.ts.net")).toBe(false);
    expect(originMatchesDialed(REMOTE, "https://studio-mac.tail1234.ts.net:8443")).toBe(false);
    expect(originMatchesDialed(REMOTE, "not a url")).toBe(false);
  });

  it("lets an SSH tunnel dial another loopback port, and nothing else", () => {
    expect(originMatchesDialed("http://127.0.0.1:8000", "http://127.0.0.1:7979")).toBe(true);
    expect(originMatchesDialed("http://localhost:8000", "http://127.0.0.1:7979")).toBe(true);
    // A loopback dial may not be answered with a public name, nor the other way round.
    expect(originMatchesDialed("http://127.0.0.1:8000", REMOTE)).toBe(false);
    expect(originMatchesDialed(REMOTE, "http://127.0.0.1:7979")).toBe(false);
  });
});

describe("the identity pin (strict mode, a saved remote Gateway)", () => {
  it("pins the key on first use, once its signature verified", () => {
    const id = newIdentity();
    const pinned: string[] = [];
    const verdict = strict(undefined, (k) => pinned.push(k))(challenge(id), DEVICE);
    expect(verdict).toEqual({ ok: true, fingerprint: fingerprintOf(id.publicKey) });
    expect(pinned).toEqual([id.publicKey]);
  });

  it("accepts the pinned key again without pinning twice", async () => {
    const id = newIdentity();
    const pinned: string[] = [];
    const verify = strict(id.publicKey, (k) => pinned.push(k));
    expect(await verify(challenge(id), DEVICE)).toMatchObject({ ok: true });
    expect(pinned).toEqual([]);
  });

  it("refuses a different key: the identity changed", () => {
    const real = newIdentity();
    const impostor = newIdentity();
    expect(strict(real.publicKey)(challenge(impostor), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_changed",
    });
  });

  it("never pins a key that did not sign", () => {
    const id = newIdentity();
    const pinned: string[] = [];
    const forged = { ...challenge(id), gatewaySignature: "A".repeat(86) };
    expect(strict(undefined, (k) => pinned.push(k))(forged, DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_invalid",
    });
    expect(pinned).toEqual([]);
  });

  it("refuses a signature made for another device (a relayed challenge)", () => {
    const id = newIdentity();
    const other = Buffer.alloc(32, 8).toString("base64url");
    expect(strict(id.publicKey)(challenge(id, { device: other }), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_invalid",
    });
  });

  it("refuses a challenge that names another origin, even with the pinned key", () => {
    const id = newIdentity();
    const c = challenge(id, { serverOrigin: "https://elsewhere.tail1234.ts.net" });
    expect(strict(id.publicKey)(c, DEVICE)).toEqual({
      ok: false,
      code: "gateway_origin_mismatch",
    });
  });

  it("refuses a Gateway that presents no key, pinned or not", async () => {
    const id = newIdentity();
    const bare = { nonce: NONCE, serverOrigin: REMOTE };
    expect(strict(id.publicKey)(bare, DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_missing",
    });
    expect(strict(undefined)(bare, DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_missing",
    });
    // A key without a signature is no better.
    const half = { ...bare, gatewayKey: id.publicKey };
    expect(await strict(id.publicKey)(half, DEVICE)).toMatchObject({ ok: false });
  });
});

describe("local mode (This Mac and the dev environment path)", () => {
  const local = (onPin: (k: string) => void = () => undefined) =>
    createGatewayVerifier({
      dialedOrigin: "http://127.0.0.1:7979",
      mode: "local",
      pinnedKey: () => undefined,
      pin: onPin,
    });

  it("keeps no pin and tolerates a Gateway that signs nothing", () => {
    const pinned: string[] = [];
    expect(
      local((k) => pinned.push(k))({ nonce: NONCE, serverOrigin: "http://0.0.0.0:7979" }, DEVICE),
    ).toEqual({
      ok: true,
    });
    expect(pinned).toEqual([]);
  });

  it("still refuses a key whose signature does not verify", () => {
    const id = newIdentity();
    const c = {
      ...challenge(id, { serverOrigin: "http://127.0.0.1:7979" }),
      gatewaySignature: "B".repeat(86),
    };
    expect(local()(c, DEVICE)).toEqual({ ok: false, code: "gateway_identity_invalid" });
  });
});

describe("the identity check in the handshake and the connection", () => {
  const params = {
    protocolVersion: { min: 1, max: 1 },
    deviceId: "dev_test",
    publicKey: DEVICE,
    role: "client" as const,
    platform: "macos",
    deviceFamily: "desktop",
    name: "test",
  };
  const frame = (c: ReturnType<typeof challenge>) =>
    ({
      type: "res" as const,
      id: "connect",
      ok: true as const,
      payload: {
        phase: "challenge",
        protocolVersion: 1,
        expiresAt: new Date().toISOString(),
        ...c,
      },
    }) as const;

  it("signs nothing for a Gateway that failed the check", async () => {
    const real = newIdentity();
    let signed = 0;
    const hs = new Handshake(
      params,
      () => {
        signed++;
        return "sig";
      },
      strict(real.publicKey),
    );
    const step = await hs.onFrame(frame(challenge(newIdentity())));
    expect(step.status).toEqual({ type: "error", code: "gateway_identity_changed" });
    expect(step.send).toBeUndefined();
    expect(step.done).toBe(true);
    expect(signed).toBe(0);
  });

  it("reports the fingerprint it verified with the challenge", async () => {
    const id = newIdentity();
    const hs = new Handshake(params, () => "sig", strict(id.publicKey));
    const step = await hs.onFrame(frame(challenge(id)));
    expect(step.status).toEqual({
      type: "challenge",
      protocolVersion: 1,
      gatewayFingerprint: fingerprintOf(id.publicKey),
    });
    expect(step.send?.method).toBe("connect.verify");
  });

  it("stops the reconnect loop on an identity failure and keeps offering nothing", async () => {
    const real = newIdentity();
    const sockets: FakeSocket[] = [];
    class FakeSocket implements WebSocketLike {
      readyState = 0;
      readonly sent: string[] = [];
      closed = false;
      #listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
      addEventListener(type: string, cb: (ev: { data?: unknown }) => void) {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
        this.readyState = 3;
        for (const cb of this.#listeners.get("close") ?? []) cb({});
      }
      emit(type: string, data?: unknown) {
        for (const cb of this.#listeners.get(type) ?? []) cb({ data });
      }
    }
    const statuses: string[] = [];
    const conn = new GatewayConnection({
      wsUrl: "wss://studio-mac.tail1234.ts.net/ws",
      connectParams: () => params,
      sign: () => "sig",
      verifyGateway: strict(real.publicKey),
      createWebSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatus: (s) => statuses.push(`${s.phase}:${s.lastError ?? ""}`),
      random: () => 0,
    });
    conn.start();
    await new Promise((r) => setTimeout(r, 0));
    const socket = sockets[0] as FakeSocket;
    socket.emit("open");
    socket.emit("message", JSON.stringify(frame(challenge(newIdentity()))));
    await new Promise((r) => setTimeout(r, 20));
    // Only the `connect` request left this client: no connect.verify, so nothing was signed.
    expect(socket.sent.map((s) => (JSON.parse(s) as { method: string }).method)).toEqual([
      "connect",
    ]);
    expect(socket.closed).toBe(true);
    expect(conn.getStatus()).toMatchObject({
      phase: "error",
      lastError: "gateway_identity_changed",
    });
    // No reconnect is scheduled: the status stays put and no second socket opens.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sockets).toHaveLength(1);
    expect(conn.getStatus().phase).toBe("error");
    conn.stop();
  });
});
