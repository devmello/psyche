import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The public key of this Mac's own Gateway from `$PSYCHE_HOME/identity/gateway.key`, when that
 * file can be read (the app and the Gateway run as the same user); undefined otherwise.
 */
export function readLocalGatewayKey(home: string): string | undefined {
  try {
    const file = JSON.parse(readFileSync(join(home, "identity", "gateway.key"), "utf8")) as {
      jwk?: { x?: unknown };
    };
    const x = file.jwk?.x;
    return typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x) ? x : undefined;
  } catch {
    return undefined;
  }
}

function parseOrigin(origin: string): URL | null {
  try {
    const url = new URL(origin);
    // An origin and nothing else: no path, query, fragment or credentials, whatever the server
    // names. (`new URL` adds the "/" of an origin's empty path.)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      origin.replace(/\/$/, "") !== url.origin.replace(/\/$/, "")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * Whether the origin a challenge names is the one this client dialed: the same scheme, host and
 * port. The one allowance is that `localhost`, `127.0.0.1` and `::1` are the same host. The port
 * must match even for a tunnel, so a saved tunnel Gateway cannot be answered by This Mac's own
 * Gateway or by a squatter on another local port; a tunnel is made with the same port on both
 * ends (`ssh -L 7979:127.0.0.1:7979 host` with no local Gateway on 7979).
 */
export function originMatchesDialed(dialed: string, named: string): boolean {
  const a = parseOrigin(dialed);
  const b = parseOrigin(named);
  if (a === null || b === null) return false;
  if (a.origin === b.origin) return true;
  return a.protocol === b.protocol && a.port === b.port && isLoopbackUrl(a) && isLoopbackUrl(b);
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
   * The fingerprint a pairing link named (`sha256:<hex>`), if the key is not pinned yet. Until the
   * first connect pins the key, a Gateway must prove a key with this fingerprint, so a link makes
   * the first connect verified rather than trust-on-first-use. Read per attempt.
   */
  pinnedFingerprint?: () => string | undefined;
  /**
   * Local mode only: the public key of this Mac's own Gateway (`identity/gateway.key`), when it
   * can be read. A Gateway that answers with another key is not This Mac's (a stale
   * `ssh -L 7979` tunnel, a squatter on the port), and one that presents none while this file
   * exists is not either.
   */
  localKey?: () => string | undefined;
}

/** A verifier, and the key it saw first when nothing was pinned yet (see `candidateKey`). */
export type PinningVerifier = GatewayVerifier & {
  /**
   * Trust on first use, held in memory: the key a Gateway proved while nothing was pinned. The
   * caller stores it only once that connection reaches paired, so an abandoned or interrupted
   * attempt pins nothing. Until then every attempt must present this same key.
   */
  candidateKey(): string | undefined;
};

export function createGatewayVerifier(opts: GatewayVerifierOptions): PinningVerifier {
  let candidate: string | undefined;
  const verifier: GatewayVerifier = (challenge, devicePublicKey) => {
    const { gatewayKey, gatewaySignature } = challenge;
    if (opts.mode === "strict" && !originMatchesDialed(opts.dialedOrigin, challenge.serverOrigin)) {
      return { ok: false, code: "gateway_origin_mismatch" };
    }
    if (gatewayKey === undefined || gatewaySignature === undefined) {
      // An older Gateway signs nothing. That is fine for the one this app supervises, never for
      // a remote one: a pinned Gateway that stops presenting its key is not the one we pinned.
      return opts.mode === "strict" || opts.localKey?.() !== undefined
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
      let pinned: string | undefined;
      let linkFingerprint: string | undefined;
      try {
        pinned = opts.pinnedKey();
        if (pinned === undefined) linkFingerprint = opts.pinnedFingerprint?.();
      } catch {
        // The saved Gateways file cannot be read, or this Gateway is no longer in it: running
        // without the pin is running without the check.
        return { ok: false, code: "gateway_pins_unreadable" };
      }
      if (pinned !== undefined) {
        if (pinned !== gatewayKey) return { ok: false, code: "gateway_identity_changed" };
      } else if (linkFingerprint !== undefined && fingerprintOf(gatewayKey) !== linkFingerprint) {
        // The link said which Gateway this is, and this is not it.
        return { ok: false, code: "gateway_identity_changed" };
      } else if (candidate !== undefined && candidate !== gatewayKey) {
        return { ok: false, code: "gateway_identity_changed" };
      } else {
        candidate = gatewayKey;
      }
    } else {
      const own = opts.localKey?.();
      if (own !== undefined && own !== gatewayKey) {
        return { ok: false, code: "gateway_identity_changed" };
      }
    }
    return {
      ok: true,
      fingerprint: fingerprintOf(gatewayKey),
      // A remote Gateway's connect is bound to the key just verified (the v2 payload).
      ...(opts.mode === "strict" ? { gatewayKey } : {}),
    };
  };
  return Object.assign(verifier, { candidateKey: () => candidate });
}
