import { randomBytes } from "node:crypto";
import type { BotAuthKey } from "@psyche/protocol";
import { canonicalizeUrl, matchesPattern, parseOriginPattern } from "../origin/canonical.ts";
import type { TabPartition } from "../origin/partition.ts";

/**
 * Web Bot Auth (feature I14; security §6; draft-meunier-web-bot-auth-architecture over RFC 9421
 * HTTP Message Signatures). Psyche signs its browser's top-level document requests with the
 * vault's Ed25519 key, so a site (Cloudflare's verified bots, for one) can tell a signed agent
 * from an anonymous bot. The signature covers the request's `@authority` and `Signature-Agent`,
 * the URL of the key directory the owner publishes; it expires after a minute and carries a
 * fresh nonce. Honest UA always; nothing is spoofed.
 *
 * When it signs (all of these):
 * - the owner switched it on (`browser.botAuth.enabled`), created a key and set the directory
 *   URL (`signatureAgent`): opt-in, as I14 says;
 * - the tab runs in the owner's `profile` partition, never a logged-out (`clean`) one;
 * - the origin asked for signatures (an `Accept-Signature` response, RFC 9421 §5.1, remembered
 *   for the Gateway's lifetime) or is on the owner's `origins` list.
 */
export const BOT_AUTH_TAG = "web-bot-auth";
export const BOT_AUTH_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const BOT_AUTH_DIRECTORY_TYPE = "application/http-message-signatures-directory+json";
export const SIGNATURE_HEADERS = ["signature", "signature-input", "signature-agent"] as const;

export interface BotAuthConfig {
  enabled: boolean;
  /** The key directory URL sites fetch (https; http only for loopback test hosts). */
  signatureAgent?: string;
  /** Origin patterns always signed (`https://example.com`, `https://*.example.com`). */
  origins?: string[];
}

export interface SignedHeader {
  name: string;
  value: string;
}

export interface BotAuthSigner {
  /** Headers to add to a document request to `url` from a tab in `partition`, or undefined. */
  sign(url: string, partition: TabPartition): Promise<SignedHeader[] | undefined>;
  /** A response from `origin` carried `Accept-Signature`. */
  noteAcceptSignature(origin: string): void;
  advertised(): string[];
  config(): BotAuthConfig;
}

export interface BotAuthSignerOptions {
  key(): Promise<BotAuthKey | undefined>;
  config(): BotAuthConfig;
  now?(): number;
  nonce?(): string;
  /** Signature lifetime (default 60 s, security §6). */
  ttlSeconds?: number;
}

/** RFC 8941 sf-string: quoted, with `\` and `"` escaped; refuses what it cannot represent. */
function sfString(s: string): string {
  if (/[^\x20-\x7e]/.test(s)) throw new Error("not representable as an sf-string");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A usable directory URL: https, or http on a loopback host (tests, a local directory). */
export function validSignatureAgent(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback =
    u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  return u.href;
}

/** RFC 9421 `@authority`: lowercased host, with the port only when it is not the default. */
export function authorityOf(url: string): string {
  const u = new URL(url);
  return u.host.toLowerCase();
}

/** The signature base RFC 9421 §2.5 builds for the two covered components. */
export function signatureBase(authority: string, signatureAgent: string, params: string): string {
  return [
    `"@authority": ${authority}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join("\n");
}

export function createBotAuthSigner(o: BotAuthSignerOptions): BotAuthSigner {
  const advertised = new Set<string>();
  const now = () => o.now?.() ?? Date.now();
  const nonce = () => o.nonce?.() ?? randomBytes(32).toString("base64");
  const ttl = o.ttlSeconds ?? 60;

  const wanted = (origin: string, cfg: BotAuthConfig): boolean => {
    if (advertised.has(origin)) return true;
    let url: ReturnType<typeof canonicalizeUrl>;
    try {
      url = canonicalizeUrl(origin);
    } catch {
      return false;
    }
    for (const raw of cfg.origins ?? []) {
      try {
        if (matchesPattern(url, parseOriginPattern(raw))) return true;
      } catch {
        // an unparsable pattern matches nothing
      }
    }
    return false;
  };

  return {
    config: () => o.config(),
    advertised: () => [...advertised].sort(),
    noteAcceptSignature(origin) {
      try {
        advertised.add(canonicalizeUrl(origin).origin);
      } catch {
        // not an http(s) origin
      }
    },
    async sign(url, partition) {
      if (partition !== "profile") return undefined;
      const cfg = o.config();
      const agent = validSignatureAgent(cfg.signatureAgent);
      if (!cfg.enabled || agent === undefined) return undefined;
      let origin: string;
      try {
        origin = canonicalizeUrl(url).origin;
      } catch {
        return undefined;
      }
      if (!wanted(origin, cfg)) return undefined;
      const key = await o.key().catch(() => undefined);
      if (key === undefined) return undefined;
      const created = Math.floor(now() / 1000);
      const agentValue = sfString(agent);
      const params =
        `("@authority" "signature-agent");created=${created};keyid=${sfString(key.keyId)};` +
        `alg="ed25519";expires=${created + ttl};nonce=${sfString(nonce())};tag="${BOT_AUTH_TAG}"`;
      const base = signatureBase(authorityOf(url), agentValue, params);
      const signature = await key.sign(new TextEncoder().encode(base)).catch(() => undefined);
      if (signature === undefined) return undefined;
      return [
        { name: "Signature-Agent", value: agentValue },
        { name: "Signature-Input", value: `sig1=${params}` },
        { name: "Signature", value: `sig1=:${Buffer.from(signature).toString("base64")}:` },
      ];
    },
  };
}

/** The JWKS a key directory serves (`BOT_AUTH_DIRECTORY_PATH`). */
export function botAuthDirectory(key: BotAuthKey | undefined): { keys: BotAuthKey["publicJwk"][] } {
  return { keys: key === undefined ? [] : [{ ...key.publicJwk }] };
}
