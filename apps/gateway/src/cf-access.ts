import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";
import { PsycheError } from "@psyche/protocol";

/**
 * Cloudflare Access in front of the Gateway (security §10, issue #79). `cloudflared` forwards a
 * `Cf-Access-Jwt-Assertion` header; it is verified against the team's JWKS (RS256 signature,
 * `aud` = the Access application's AUD tag, `iss` = the team domain, `exp` / `nbf`), never just
 * checked for presence. A verified identity is shown on pairing cards; it never authorizes the
 * API by itself: every device still pairs.
 */

export interface CloudflareAccessConfig {
  /** e.g. `myteam.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
}

export interface VerifiedAccess {
  email: string | null;
  subject: string;
}

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Accepted clock skew. */
const SKEW_S = 60;
/** At most one JWKS refresh per this interval when an unknown `kid` shows up. */
const REFRESH_MIN_MS = 5 * 60_000;
const MAX_TOKEN_BYTES = 16 * 1024;

function b64urlJson(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

function reject(reason: string): never {
  throw new PsycheError("unauthorized", `Cloudflare Access assertion rejected: ${reason}`);
}

export class CloudflareAccessVerifier {
  readonly #config: CloudflareAccessConfig;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #certsUrl: string;
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #pending: Promise<void> | null = null;

  constructor(
    config: CloudflareAccessConfig,
    options: { fetch?: Fetch; now?: () => number; certsUrl?: string } = {},
  ) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(config.teamDomain)) {
      throw new PsycheError(
        "invalid_params",
        "gateway.cloudflareAccess.teamDomain must be a host name",
      );
    }
    if (config.audience.trim() === "") {
      throw new PsycheError("invalid_params", "gateway.cloudflareAccess.audience is required");
    }
    this.#config = config;
    this.#fetch = options.fetch ?? ((url) => fetch(url));
    this.#now = options.now ?? Date.now;
    this.#certsUrl = options.certsUrl ?? `https://${config.teamDomain}/cdn-cgi/access/certs`;
  }

  async #refresh(): Promise<void> {
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      try {
        const res = await this.#fetch(this.#certsUrl);
        if (!res.ok) throw new Error("JWKS fetch failed");
        const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
        const keys = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
          keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
        }
        this.#keys = keys;
        this.#fetchedAt = this.#now();
      } finally {
        this.#pending = null;
      }
    })();
    return this.#pending;
  }

  async #key(kid: string): Promise<KeyObject | undefined> {
    const have = this.#keys.get(kid);
    if (have) return have;
    if (this.#fetchedAt === 0 || this.#now() - this.#fetchedAt >= REFRESH_MIN_MS) {
      await this.#refresh().catch(() => undefined);
    }
    return this.#keys.get(kid);
  }

  /** Verifies one assertion; throws `unauthorized` with a reason that never quotes the token. */
  async verify(token: string | undefined): Promise<VerifiedAccess> {
    if (token === undefined || token === "") reject("missing");
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) reject("too large");
    const parts = token.split(".");
    if (parts.length !== 3) reject("malformed");
    const [h, p, s] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = b64urlJson(h);
      claims = b64urlJson(p);
    } catch {
      reject("malformed");
    }
    if (header.alg !== "RS256") reject("unsupported algorithm");
    if (typeof header.kid !== "string") reject("no key id");
    const key = await this.#key(header.kid);
    if (!key) reject("unknown key");
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
    if (!ok) reject("bad signature");

    const nowS = Math.floor(this.#now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < nowS) reject("expired");
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > nowS) reject("not yet valid");
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.#config.audience)) reject("wrong audience");
    const iss = `https://${this.#config.teamDomain}`;
    if (claims.iss !== iss) reject("wrong issuer");
    if (typeof claims.sub !== "string") reject("no subject");
    return {
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
    };
  }
}

export function cfAccessHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const v = headers["cf-access-jwt-assertion"];
  return Array.isArray(v) ? v[0] : v;
}
