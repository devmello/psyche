import { describe, expect, it } from "vitest";
import { createGatewayVerifier } from "../src/lib/gateway-identity.ts";

/**
 * The handshake's `server` field reaches the desktop supervisor (updates design §2.10): only for
 * This Mac's own Gateway, which the desktop supervises. A remote Gateway's claim restarts nothing.
 */

const NONCE = Buffer.alloc(32, 9).toString("base64url");
const DEVICE = Buffer.alloc(32, 3).toString("base64url");
const LOCAL = "http://127.0.0.1:7979";

describe("onServer", () => {
  it("is told only once the Gateway has proved to be this Mac's own", async () => {
    const seen: unknown[] = [];
    const verifier = createGatewayVerifier({
      dialedOrigin: LOCAL,
      mode: "local",
      pinnedKey: () => undefined,
      // This Mac's identity file names a key; the impostor on the port presents another.
      localKey: () => "A".repeat(43),
      onServer: (s) => seen.push(s),
    });
    const verdict = await verifier(
      {
        nonce: NONCE,
        serverOrigin: LOCAL,
        gatewayKey: "B".repeat(43),
        gatewaySignature: "C".repeat(86),
        server: { version: "9.9.9", build: "evil" },
      },
      DEVICE,
    );
    expect(verdict.ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("is told the build of This Mac's Gateway, and none for one that predates it", async () => {
    const seen: unknown[] = [];
    const verifier = createGatewayVerifier({
      dialedOrigin: LOCAL,
      mode: "local",
      pinnedKey: () => undefined,
      onServer: (s) => seen.push(s),
    });
    // An older Gateway signs nothing and names no build: still accepted, the supervisor decides.
    const bare = { nonce: NONCE, serverOrigin: LOCAL };
    expect(await verifier(bare, DEVICE)).toEqual({ ok: true });
    expect(await verifier({ ...bare, server: { version: "0.5.0", build: "abc" } }, DEVICE)).toEqual(
      { ok: true },
    );
    expect(seen).toEqual([undefined, { version: "0.5.0", build: "abc" }]);
  });

  it("is not called for a saved remote Gateway", async () => {
    const seen: unknown[] = [];
    const remote = "https://studio-mac.tail1234.ts.net";
    const verifier = createGatewayVerifier({
      dialedOrigin: remote,
      mode: "strict",
      pinnedKey: () => undefined,
      onServer: (s) => seen.push(s),
    });
    await verifier(
      { nonce: NONCE, serverOrigin: remote, server: { version: "0.5.0", build: "abc" } },
      DEVICE,
    );
    expect(seen).toEqual([]);
  });
});
