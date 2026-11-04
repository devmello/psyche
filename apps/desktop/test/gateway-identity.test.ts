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

function strict(pinned: string | undefined) {
  return createGatewayVerifier({
    dialedOrigin: REMOTE,
    mode: "strict",
    pinnedKey: () => pinned,
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

  it("treats the loopback names as one host, but never lets another local port answer", () => {
    expect(originMatchesDialed("http://localhost:7979", "http://127.0.0.1:7979")).toBe(true);
    // A saved tunnel Gateway on 8000 is not answered by a Gateway (This Mac's own, or a
    // squatter) that names port 7979.
    expect(originMatchesDialed("http://127.0.0.1:8000", "http://127.0.0.1:7979")).toBe(false);
    // A loopback dial may not be answered with a public name, nor the other way round.
    expect(originMatchesDialed("http://127.0.0.1:8000", REMOTE)).toBe(false);
    expect(originMatchesDialed(REMOTE, "http://127.0.0.1:7979")).toBe(false);
  });
});

describe("the identity pin (strict mode, a saved remote Gateway)", () => {
  it("holds the first key in memory once its signature verified, and pins nothing itself", () => {
    const id = newIdentity();
    const verify = strict(undefined);
    expect(verify.candidateKey()).toBeUndefined();
    expect(verify(challenge(id), DEVICE)).toEqual({
      ok: true,
      fingerprint: fingerprintOf(id.publicKey),
    });
    expect(verify.candidateKey()).toBe(id.publicKey);
  });

  it("holds the same key for every attempt until it is stored: a second key is a change", () => {
    const first = newIdentity();
    const verify = strict(undefined);
    verify(challenge(first), DEVICE);
    expect(verify(challenge(newIdentity()), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_changed",
    });
    expect(verify(challenge(first), DEVICE)).toMatchObject({ ok: true });
  });

  it("accepts the pinned key again and holds no candidate", async () => {
    const id = newIdentity();
    const verify = strict(id.publicKey);
    expect(await verify(challenge(id), DEVICE)).toMatchObject({ ok: true });
    expect(verify.candidateKey()).toBeUndefined();
  });

  it("fails closed when the saved Gateways cannot be read", () => {
    const id = newIdentity();
    const verify = createGatewayVerifier({
      dialedOrigin: REMOTE,
      mode: "strict",
      pinnedKey: () => {
        throw new Error("gateways.json unreadable");
      },
    });
    expect(verify(challenge(id), DEVICE)).toEqual({
      ok: false,
      code: "gateway_pins_unreadable",
    });
    expect(verify.candidateKey()).toBeUndefined();
  });

  it("refuses a different key: the identity changed", () => {
    const real = newIdentity();
    const impostor = newIdentity();
    expect(strict(real.publicKey)(challenge(impostor), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_changed",
    });
  });

  it("never takes a key that did not sign", () => {
    const id = newIdentity();
    const verify = strict(undefined);
    const forged = { ...challenge(id), gatewaySignature: "A".repeat(86) };
    expect(verify(forged, DEVICE)).toEqual({ ok: false, code: "gateway_identity_invalid" });
    expect(verify.candidateKey()).toBeUndefined();
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
  const local = (localKey?: string) =>
    createGatewayVerifier({
      dialedOrigin: "http://127.0.0.1:7979",
      mode: "local",
      pinnedKey: () => undefined,
      ...(localKey === undefined ? {} : { localKey: () => localKey }),
    });

  it("keeps no pin and tolerates a Gateway that signs nothing", () => {
    const verify = local();
    expect(verify({ nonce: NONCE, serverOrigin: "http://0.0.0.0:7979" }, DEVICE)).toEqual({
      ok: true,
    });
    expect(verify.candidateKey()).toBeUndefined();
  });

  it("still refuses a key whose signature does not verify", () => {
    const id = newIdentity();
    const c = {
      ...challenge(id, { serverOrigin: "http://127.0.0.1:7979" }),
      gatewaySignature: "B".repeat(86),
    };
    expect(local()(c, DEVICE)).toEqual({ ok: false, code: "gateway_identity_invalid" });
  });

  it("holds This Mac's Gateway to the key in its own identity file", () => {
    const own = newIdentity();
    const squatter = newIdentity();
    const at = (id: Identity) => challenge(id, { serverOrigin: "http://127.0.0.1:7979" });
    expect(local(own.publicKey)(at(own), DEVICE)).toMatchObject({ ok: true });
    // A stale `ssh -L 7979` tunnel, or anything else on the port, is not This Mac's Gateway.
    expect(local(own.publicKey)(at(squatter), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_changed",
    });
    expect(
      local(own.publicKey)({ nonce: NONCE, serverOrigin: "http://127.0.0.1:7979" }, DEVICE),
    ).toEqual({ ok: false, code: "gateway_identity_missing" });
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
    hs.start();
    const step = await hs.onFrame(frame(challenge(newIdentity())));
    expect(step.status).toEqual({ type: "error", code: "gateway_identity_changed" });
    expect(step.send).toBeUndefined();
    expect(step.done).toBe(true);
    expect(signed).toBe(0);
  });

  it("reports the fingerprint it verified with the challenge", async () => {
    const id = newIdentity();
    const hs = new Handshake(params, () => "sig", strict(id.publicKey));
    hs.start();
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

describe("a server that skips or replays the challenge", () => {
  const params = {
    protocolVersion: { min: 1, max: 1 },
    deviceId: "dev_test",
    publicKey: DEVICE,
    role: "client" as const,
    platform: "macos",
    deviceFamily: "desktop",
    name: "test",
  };
  const paired = {
    type: "res" as const,
    id: "connect.verify",
    ok: true as const,
    payload: { phase: "paired", scopes: ["operator.admin"] },
  };
  const challengeFrame = (id: Identity) => ({
    type: "res" as const,
    id: "connect",
    ok: true as const,
    payload: {
      phase: "challenge",
      protocolVersion: 1,
      expiresAt: new Date().toISOString(),
      ...challenge(id),
    },
  });
  const refused = { status: { type: "error", code: "invalid_frame" }, done: true };

  it("is refused when it answers connect with a ready-made result, whatever the pin", async () => {
    const id = newIdentity();
    for (const verifier of [strict(id.publicKey), strict(undefined), undefined]) {
      const hs = new Handshake(params, () => "sig", verifier);
      hs.start();
      expect(await hs.onFrame(paired)).toEqual(refused);
      expect(await hs.onFrame({ ...paired, id: "connect" } as never)).toEqual(refused);
    }
  });

  it("is refused when the result arrives before this client sent connect.verify", async () => {
    const id = newIdentity();
    const hs = new Handshake(params, () => "sig", strict(id.publicKey));
    // Not even started: no connect was sent on this socket.
    expect(await hs.onFrame(paired)).toEqual(refused);
    hs.start();
    expect(await hs.onFrame(paired)).toEqual(refused);
  });

  it("is refused when a result follows a challenge that failed the check", async () => {
    const hs = new Handshake(params, () => "sig", strict(newIdentity().publicKey));
    hs.start();
    const failed = await hs.onFrame(challengeFrame(newIdentity()));
    expect(failed.status).toEqual({ type: "error", code: "gateway_identity_changed" });
    expect(failed.send).toBeUndefined();
    expect(await hs.onFrame(paired)).toEqual(refused);
  });

  it("accepts one result after its own connect.verify, and refuses a second challenge or result", async () => {
    const id = newIdentity();
    const hs = new Handshake(params, () => "sig", strict(id.publicKey));
    hs.start();
    const step = await hs.onFrame(challengeFrame(id));
    expect(step.send?.method).toBe("connect.verify");
    const ok = await hs.onFrame(paired);
    expect(ok.status).toEqual({ type: "paired", scopes: ["operator.admin"] });
    // A repeated result is not accepted again, nor is a second challenge.
    expect(await hs.onFrame(paired)).toEqual(refused);
    expect(await hs.onFrame(challengeFrame(id))).toEqual(refused);
  });

  it("refuses a second challenge on the same socket, and nothing after it is accepted", async () => {
    const id = newIdentity();
    const hs = new Handshake(params, () => "sig", strict(id.publicKey));
    hs.start();
    await hs.onFrame(challengeFrame(id));
    expect(await hs.onFrame(challengeFrame(id))).toEqual(refused);
    expect(await hs.onFrame(paired)).toEqual(refused);
  });

  it("never marks a connection paired when the server skips the challenge", async () => {
    const real = newIdentity();
    const sockets: { sent: string[]; emit: (t: string, d?: unknown) => void }[] = [];
    class Fake implements WebSocketLike {
      readyState = 1;
      sent: string[] = [];
      #l = new Map<string, ((ev: { data?: unknown }) => void)[]>();
      addEventListener(t: string, cb: (ev: { data?: unknown }) => void) {
        this.#l.set(t, [...(this.#l.get(t) ?? []), cb]);
      }
      send(d: string) {
        this.sent.push(d);
      }
      close() {
        this.readyState = 3;
        for (const cb of this.#l.get("close") ?? []) cb({});
      }
      emit(t: string, d?: unknown) {
        for (const cb of this.#l.get(t) ?? []) cb({ data: d });
      }
    }
    const conn = new GatewayConnection({
      wsUrl: "wss://studio-mac.tail1234.ts.net/ws",
      connectParams: () => params,
      sign: () => "sig",
      verifyGateway: strict(real.publicKey),
      createWebSocket: () => {
        const s = new Fake();
        sockets.push(s);
        return s;
      },
      onStatus: () => {},
    });
    conn.start();
    await new Promise((r) => setTimeout(r, 0));
    const s = sockets[0] as Fake;
    s.emit("open");
    s.emit("message", JSON.stringify(paired));
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.isPaired()).toBe(false);
    expect(conn.getStatus().phase).not.toBe("paired");
    conn.stop();
  });
});
