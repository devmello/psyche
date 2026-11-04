import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server,
} from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewaySigningPayload, lanCertSigningPayload } from "@psyche/protocol";
import { GatewayConnection, type GatewayStatus } from "@psyche/web/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
// Test-only: the Gateway's own certificate maker, so this talks to a certificate shaped exactly
// like the one a real Host serves (ECDSA P-256, SAN for the host name and its address).
import { ensureLanCert, spkiPin } from "../../gateway/src/lan/cert.ts";
import { createGatewayVerifier } from "../src/lib/gateway-identity.ts";
import { createPinnedFetch, createPinnedWebSocket, PinnedChannel } from "../src/lib/lan-tls.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Id {
  publicKey: string;
  sign(payload: Uint8Array): string;
}
function newId(): Id {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return { publicKey: x, sign: (p) => sign(null, p, privateKey).toString("base64url") };
}

interface FakeOptions {
  identity?: Id;
  /** The SPKI the Gateway says it served (default: the real one). */
  attestSpki?: string;
  /** Leave the attestation out entirely. */
  noAttestation?: boolean;
  /** Sign the attestation with a key that is not the Gateway's. */
  badAttestation?: boolean;
}

/** A LAN Gateway stand-in: HTTPS + WebSocket on loopback with a real self-signed certificate. */
async function fakeLanGateway(opts: FakeOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "psyche-lan-client-"));
  const cert = await ensureLanCert(home, ["studio-mac.local", "127.0.0.1"]);
  const identity = opts.identity ?? newId();
  const server: Server = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/healthz" ? '{"ok":true}' : "{}");
  });
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  let frames = 0;
  server.on("upgrade", (req, socket, head) => {
    upgrades += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        frames += 1;
        const frame = JSON.parse(raw.toString()) as {
          id: string;
          method: string;
          params: { publicKey: string };
        };
        if (frame.method === "connect") {
          const nonce = randomBytes(32).toString("base64url");
          const serverOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
          const devicePublicKey = frame.params.publicKey;
          const spki = opts.attestSpki ?? cert.spki;
          const attester = opts.badAttestation ? newId() : identity;
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                phase: "challenge",
                nonce,
                serverOrigin,
                protocolVersion: 1,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                gatewayKey: identity.publicKey,
                gatewaySignature: identity.sign(
                  gatewaySigningPayload({ nonce, serverOrigin, devicePublicKey }),
                ),
                ...(opts.noAttestation
                  ? {}
                  : {
                      lanCertSpki: spki,
                      lanCertSignature: attester.sign(
                        lanCertSigningPayload({ nonce, serverOrigin, devicePublicKey, spki }),
                      ),
                    }),
              },
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { phase: "pending", pairingRequestId: "pr1", code: "ABCD-EFGH" },
            }),
          );
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    spki: cert.spki,
    certPem: cert.certPem,
    identity,
    counts: () => ({ upgrades, frames }),
  };
}

const DEVICE = newId();

/** Runs a connection until it ends in a state the caller names. */
async function connectOnce(
  g: Awaited<ReturnType<typeof fakeLanGateway>>,
  setup: {
    pinnedCert?: string;
    pinnedKey?: string;
    expectedFingerprint?: string;
  } = {},
) {
  const channel = new PinnedChannel({
    host: "127.0.0.1",
    port: g.port,
    pinned: () => setup.pinnedCert,
  });
  const verifier = createGatewayVerifier({
    dialedOrigin: g.origin,
    mode: "strict",
    pinnedKey: () => setup.pinnedKey,
    ...(setup.expectedFingerprint === undefined
      ? {}
      : { expectedFingerprint: () => setup.expectedFingerprint }),
    lan: { observedSpki: () => channel.observedSpki(), pinnedSpki: () => setup.pinnedCert },
  });
  const statuses: GatewayStatus[] = [];
  const done = new Promise<GatewayStatus>((resolve) => {
    const conn = new GatewayConnection({
      wsUrl: `wss://127.0.0.1:${g.port}/ws`,
      connectParams: () => ({
        protocolVersion: { min: 1, max: 1 },
        deviceId: "dev_test",
        publicKey: DEVICE.publicKey,
        role: "client",
        platform: "macos",
        deviceFamily: "desktop",
        name: "test",
      }),
      sign: (payload) => DEVICE.sign(payload),
      verifyGateway: verifier,
      createWebSocket: (url) => createPinnedWebSocket(channel, url),
      fetch: createPinnedFetch(channel),
      pendingRecheckMs: 0,
      onStatus: (s) => {
        statuses.push(s);
        if (s.phase === "pending" || s.phase === "paired" || s.lastError?.startsWith("gateway_")) {
          conn.stop();
          resolve(s);
        }
      },
    });
    cleanups.push(() => conn.stop());
    conn.start();
  });
  const final = await Promise.race([
    done,
    new Promise<GatewayStatus>((_, rej) => setTimeout(() => rej(new Error("timed out")), 5_000)),
  ]);
  return { final, verifier, channel, statuses };
}

describe("a LAN Gateway is reached only through its pinned certificate", () => {
  it("connects when the certificate is the pinned one and the identity is the pinned one", async () => {
    const g = await fakeLanGateway();
    const { final } = await connectOnce(g, { pinnedCert: g.spki, pinnedKey: g.identity.publicKey });
    expect(final.phase).toBe("pending");
  });

  it("first use: takes the certificate the identity key vouched for, held until paired", async () => {
    const g = await fakeLanGateway();
    const { final, verifier } = await connectOnce(g);
    expect(final.phase).toBe("pending");
    expect(verifier.candidateCertSpki()).toBe(g.spki);
    expect(verifier.candidateKey()).toBe(g.identity.publicKey);
  });

  it("refuses a certificate whose SPKI is not the pinned one, even with a valid identity signature", async () => {
    const g = await fakeLanGateway();
    const other = Buffer.alloc(32, 7).toString("base64url");
    const { final } = await connectOnce(g, { pinnedCert: other, pinnedKey: g.identity.publicKey });
    expect(final.phase).toBe("error");
    expect(final.lastError).toBe("gateway_cert_changed");
    // The TLS socket was dropped before the WebSocket upgrade: not one frame was sent.
    expect(g.counts()).toEqual({ upgrades: 0, frames: 0 });
  });

  it("refuses a valid pinned certificate when the identity key is not the pinned one", async () => {
    const g = await fakeLanGateway();
    const { final } = await connectOnce(g, {
      pinnedCert: g.spki,
      pinnedKey: newId().publicKey,
    });
    expect(final.lastError).toBe("gateway_identity_changed");
    // Nothing was signed for it: the only frame it got is the `connect` that asks for a challenge.
    expect(g.counts().frames).toBe(1);
  });

  it("refuses a relay: a certificate the identity key did not vouch for, with no pin yet", async () => {
    const g = await fakeLanGateway({ attestSpki: Buffer.alloc(32, 5).toString("base64url") });
    const { final } = await connectOnce(g);
    expect(final.lastError).toBe("gateway_cert_changed");
    expect(g.counts().frames).toBe(1);
  });

  it("refuses a Gateway that does not vouch for its certificate", async () => {
    const g = await fakeLanGateway({ noAttestation: true });
    const { final } = await connectOnce(g, { pinnedCert: g.spki, pinnedKey: g.identity.publicKey });
    expect(final.lastError).toBe("gateway_cert_missing");
  });

  it("refuses an attestation that the identity key did not sign", async () => {
    const g = await fakeLanGateway({ badAttestation: true });
    const { final } = await connectOnce(g, { pinnedCert: g.spki, pinnedKey: g.identity.publicKey });
    expect(final.lastError).toBe("gateway_cert_invalid");
  });

  it("refuses the key a listing did not announce while nothing is pinned", async () => {
    const g = await fakeLanGateway();
    const { final } = await connectOnce(g, { expectedFingerprint: `sha256:${"ab".repeat(32)}` });
    expect(final.lastError).toBe("gateway_identity_changed");
  });

  it("accepts the key a listing announced", async () => {
    const g = await fakeLanGateway();
    const { fingerprintOf } = await import("../src/lib/gateway-identity.ts");
    const { final } = await connectOnce(g, {
      expectedFingerprint: fingerprintOf(g.identity.publicKey),
    });
    expect(final.phase).toBe("pending");
  });

  it("does not turn off certificate checking for anything else in the process", async () => {
    const g = await fakeLanGateway();
    // A pinned connection works, and a plain request to the same server still fails validation.
    await connectOnce(g, { pinnedCert: g.spki, pinnedKey: g.identity.publicKey });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const req = httpsRequest({ host: "127.0.0.1", port: g.port, path: "/healthz" }, () =>
        resolve(new Error("accepted") as NodeJS.ErrnoException),
      );
      req.on("error", (e) => resolve(e as NodeJS.ErrnoException));
      req.end();
    });
    expect(err.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
  });

  it("the health check goes through the pin too", async () => {
    const g = await fakeLanGateway();
    const ok = createPinnedFetch(
      new PinnedChannel({ host: "127.0.0.1", port: g.port, pinned: () => g.spki }),
    );
    const res = await ok(`${g.origin}/healthz`, { cache: "no-store" });
    expect(await res.json()).toEqual({ ok: true });
    const bad = createPinnedFetch(
      new PinnedChannel({
        host: "127.0.0.1",
        port: g.port,
        pinned: () => Buffer.alloc(32, 1).toString("base64url"),
      }),
    );
    await expect(bad(`${g.origin}/healthz`)).rejects.toMatchObject({
      code: "gateway_cert_changed",
    });
  });

  it("agrees with the Gateway on what the pin is", async () => {
    const g = await fakeLanGateway();
    expect(spkiPin(g.certPem)).toBe(g.spki);
  });
});
