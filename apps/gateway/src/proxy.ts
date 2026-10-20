import { BlockList, isIP } from "node:net";
import { PsycheError } from "@psyche/protocol";

/**
 * Trusted-proxy mode (security §10, architecture §11). Tailscale Serve and `cloudflared` reach the
 * Gateway from loopback and say who the client is in forwarding and identity headers. Those
 * headers never authorize anything: every device still pairs and signs the challenge. They only
 * decide (1) that a forwarded connection is NOT loopback, so it can never be auto-paired, and
 * (2) which client address rate limits and pairing cards use.
 */

export interface TrustedProxyConfig {
  enabled: boolean;
  /** CIDRs (or single addresses) of the proxies whose forwarding headers are believed. */
  trustedProxies: string[];
}

export interface ResolvedPeer {
  /** The client address: the peer itself, or the first untrusted hop of `X-Forwarded-For`. */
  remoteAddress: string;
  /** `true` only for a direct loopback connection with no forwarding headers. */
  remoteLoopback: boolean;
  /** The request carried forwarding headers (it came through some proxy). */
  forwarded: boolean;
  /**
   * Identity the proxy claims (`Tailscale-User-Login`), shown on pairing cards as a claim only.
   * Set only in trusted-proxy mode from a trusted peer. Never used to authorize.
   */
  claimedIdentity: string | null;
}

const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;

function normalize(addr: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return v4?.[1] ?? addr;
}

function family(addr: string): "ipv4" | "ipv6" | null {
  const v = isIP(addr);
  return v === 4 ? "ipv4" : v === 6 ? "ipv6" : null;
}

/** Parses `trustedProxies` into a matcher; a malformed entry fails fast at startup. */
export function trustedProxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const [addr, bits, extra] = raw.trim().split("/");
    const f = addr === undefined ? null : family(addr);
    if (addr === undefined || f === null || extra !== undefined) {
      throw new PsycheError(
        "invalid_params",
        `gateway.trustedProxy.trustedProxies: bad entry ${JSON.stringify(raw)}`,
      );
    }
    if (bits === undefined) {
      list.addAddress(addr, f);
      continue;
    }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (f === "ipv4" ? 32 : 128)) {
      throw new PsycheError(
        "invalid_params",
        `gateway.trustedProxy.trustedProxies: bad prefix in ${JSON.stringify(raw)}`,
      );
    }
    list.addSubnet(addr, prefix, f);
  }
  return list;
}

function isTrusted(list: BlockList, addr: string): boolean {
  const a = normalize(addr);
  const f = family(a);
  return f !== null && list.check(a, f);
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v.join(",") : v;
}

/**
 * Who is on the other end of an HTTP upgrade. Without trusted-proxy mode, forwarding headers are
 * not believed for the address, but their presence still makes the connection non-loopback.
 */
export function resolvePeer(
  socketAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  config: TrustedProxyConfig,
  list: BlockList,
): ResolvedPeer {
  const direct = normalize(socketAddress ?? "unknown");
  const forwarded = FORWARDING_HEADERS.some((h) => headerValue(headers, h) !== undefined);
  const base: ResolvedPeer = {
    remoteAddress: direct,
    remoteLoopback: LOOPBACK.has(direct) && !forwarded,
    forwarded,
    claimedIdentity: null,
  };
  if (!config.enabled || !forwarded || !isTrusted(list, direct)) return base;

  // Walk X-Forwarded-For from the right, skipping trusted proxies: the first untrusted hop is
  // the client. A client can prepend anything, so the left side is never believed.
  const hops = (headerValue(headers, "x-forwarded-for") ?? "")
    .split(",")
    .map((h) => normalize(h.trim()))
    .filter((h) => h.length > 0);
  let client = direct;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (family(hop) === null) break;
    client = hop;
    if (!isTrusted(list, hop)) break;
  }
  const login = headerValue(headers, "tailscale-user-login");
  return {
    remoteAddress: client,
    remoteLoopback: false,
    forwarded: true,
    claimedIdentity: login !== undefined && login.length > 0 && login.length <= 256 ? login : null,
  };
}
