import { createHash, createPublicKey, verify } from "node:crypto";
import { gatewaySigningPayload } from "@psyche/protocol";
import type { GatewayVerifier } from "@psyche/web/client";

/**
 * The client half of the Gateway identity pin (remote-gateway design §3.3). A saved remote
 * Gateway has a pinned identity key; before the app signs anything for a connection it checks
 * that the challenge names the address it dialed, carries a key, proves it holds that key for
 * this nonce and this device, and that the key is the pinned one. Every check fails closed with
 * a code the splash turns into a full-window explanation. There is no "continue anyway".
 */

/** `sha256:<hex>` of a raw public key given as base64url: what the owner compares. */
export function fingerprintOf(publicKeyB64url: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("hex")}`;
}

function parseOrigin(origin: string): URL | null {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * Whether the origin a challenge names is the one this client dialed. Exact (scheme, host, port)
 * match, with one allowance: two loopback origins of the same scheme match whatever the port,
 * because an SSH tunnel (`ssh -L 8000:127.0.0.1:7979 host`) legitimately dials another port than
 * the Gateway's own. The pin, not the address, is what identifies a tunnelled Gateway.
 */
export function originMatchesDialed(dialed: string, named: string): boolean {
  const a = parseOrigin(dialed);
  const b = parseOrigin(named);
  if (a === null || b === null) return false;
  if (a.origin === b.origin) return true;
  return a.protocol === b.protocol && isLoopbackUrl(a) && isLoopbackUrl(b);
}

function verifySignature(
  gatewayKey: string,
  payload: Uint8Array,
  signatureB64url: string,
): boolean {
  try {
    const raw = Buffer.from(gatewayKey, "base64url");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    const signature = Buffer.from(signatureB64url, "base64url");
    return signature.length === 64 && verify(null, payload, key, signature);
  } catch {
    return false;
  }
}

export interface GatewayVerifierOptions {
  /** The address this client dials (a saved Gateway's origin). */
  dialedOrigin: string;
  /**
   * `strict` for a saved remote Gateway: identity required, origin checked, key pinned.
   * `local` for This Mac and the dev environment path: this app supervises the Gateway and the
   * per-launch handshake secret is the trust anchor, so no pin is kept; a key that is present
   * must still carry a valid signature.
   */
  mode: "strict" | "local";
  /** The pinned key (base64url), if any. Read per attempt. */
  pinnedKey: () => string | undefined;
  /**
   * First sight of a key with nothing pinned (trust on first use): the caller stores it. Called
   * only after the signature verified, so a pin can only ever be a key whose holder answered.
   */
  pin: (gatewayKey: string) => void;
}

export function createGatewayVerifier(opts: GatewayVerifierOptions): GatewayVerifier {
  return (challenge, devicePublicKey) => {
    const { gatewayKey, gatewaySignature } = challenge;
    if (opts.mode === "strict" && !originMatchesDialed(opts.dialedOrigin, challenge.serverOrigin)) {
      return { ok: false, code: "gateway_origin_mismatch" };
    }
    if (gatewayKey === undefined || gatewaySignature === undefined) {
      // An older Gateway signs nothing. That is fine for the one this app supervises, never for
      // a remote one: a pinned Gateway that stops presenting its key is not the one we pinned.
      return opts.mode === "strict"
        ? { ok: false, code: "gateway_identity_missing" }
        : { ok: true };
    }
    const payload = gatewaySigningPayload({
      nonce: challenge.nonce,
      serverOrigin: challenge.serverOrigin,
      devicePublicKey,
    });
    if (!verifySignature(gatewayKey, payload, gatewaySignature)) {
      return { ok: false, code: "gateway_identity_invalid" };
    }
    if (opts.mode === "strict") {
      const pinned = opts.pinnedKey();
      if (pinned === undefined) opts.pin(gatewayKey);
      else if (pinned !== gatewayKey) return { ok: false, code: "gateway_identity_changed" };
    }
    return { ok: true, fingerprint: fingerprintOf(gatewayKey) };
  };
}
