import { sign } from "node:crypto";
import { connectSigningPayload, PROTOCOL_VERSION } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

const gateways: TestGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.cleanup();
});

/** Connects as a new device, signing the v1 or v2 payload and sending (or not) the field. */
async function connectWith(
  g: TestGateway,
  opts: {
    gatewayKey?: string;
    signAs: "v1" | "v2";
    signedKey?: string;
    headers?: Record<string, string>;
    family?: string;
  },
) {
  const key = newDeviceKey();
  const client = await TestClient.open(wsUrlOf(g.gateway), opts.headers);
  const res = await client.request("connect", {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: `dev-${Math.random().toString(36).slice(2)}`,
    publicKey: key.publicKey,
    role: "client",
    platform: "macos",
    deviceFamily: opts.family ?? "desktop",
    name: "test device",
  });
  const c = res.payload as { nonce: string; serverOrigin: string; protocolVersion: number };
  const payload = connectSigningPayload({
    nonce: c.nonce,
    platform: "macos",
    deviceFamily: opts.family ?? "desktop",
    protocolVersion: c.protocolVersion,
    serverOrigin: c.serverOrigin,
    ...(opts.signAs === "v2" ? { gatewayKey: opts.signedKey ?? opts.gatewayKey ?? "" } : {}),
  });
  const verify = await client.request("connect.verify", {
    nonce: c.nonce,
    signature: sign(null, payload, key.privateKey).toString("base64url"),
    ...(opts.gatewayKey === undefined ? {} : { gatewayKey: opts.gatewayKey }),
  });
  client.close();
  return verify;
}

const phase = (r: { payload?: unknown }) => (r.payload as { phase?: string } | undefined)?.phase;

describe("the connect is bound to the Gateway key the device verified (v2 payload)", () => {
  it("accepts a v2 connect that names this Gateway's key", async () => {
    const g = await startTestGateway();
    gateways.push(g);
    const own = g.gateway.context.identity.publicKey;
    expect(phase(await connectWith(g, { gatewayKey: own, signAs: "v2" }))).toBe("pending");
  });

  it("refuses a v2 connect made for another Gateway's key", async () => {
    const g = await startTestGateway();
    gateways.push(g);
    const res = await connectWith(g, { gatewayKey: newDeviceKey().publicKey, signAs: "v2" });
    expect(res.ok).toBe(false);
  });

  it("accepts no field only with the v1 payload, so a relay cannot strip the key", async () => {
    const g = await startTestGateway();
    gateways.push(g);
    const own = g.gateway.context.identity.publicKey;
    // The old client: v1 payload, no field.
    expect(phase(await connectWith(g, { signAs: "v1" }))).toBe("pending");
    // A v2 signature with the field stripped does not verify as v1.
    expect((await connectWith(g, { signAs: "v2", signedKey: own })).ok).toBe(false);
    // A field the signature did not cover does not verify either.
    expect((await connectWith(g, { gatewayKey: own, signAs: "v1" })).ok).toBe(false);
  });
});

describe("a desktop app connecting over the network must bind its connect", () => {
  const publicOrigin = "https://studio-mac.tail1234.ts.net";
  const forwarded = { "x-forwarded-for": "100.64.0.9" };
  const start = () =>
    startTestGateway({ config: { publicOrigin, allowedOrigins: [publicOrigin] } });

  it("refuses the unbound v1 connect from a desktop over a proxy, and accepts the v2 one", async () => {
    const g = await start();
    gateways.push(g);
    const own = g.gateway.context.identity.publicKey;
    expect((await connectWith(g, { signAs: "v1", headers: forwarded })).ok).toBe(false);
    expect(phase(await connectWith(g, { gatewayKey: own, signAs: "v2", headers: forwarded }))).toBe(
      "pending",
    );
  });

  it("leaves browsers, the CLI and loopback clients on v1", async () => {
    const g = await start();
    gateways.push(g);
    for (const family of ["web", "cli"]) {
      expect(phase(await connectWith(g, { signAs: "v1", headers: forwarded, family }))).toBe(
        "pending",
      );
    }
    // A desktop on loopback (this Mac, or a tunnel) keeps v1 too.
    expect(phase(await connectWith(g, { signAs: "v1" }))).toBe("pending");
  });
});
