import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { PsycheError } from "@psyche/protocol";
import { type CloudflareAccessVerifier, cfAccessHeader } from "./cf-access.ts";
import type { ResolvedPeer } from "./proxy.ts";

/**
 * Who may open a transport to the Gateway (security §10 "Docker defaults", issue #79). This only
 * gates the HTTP / WebSocket transport: device pairing and scopes still apply on every path.
 *
 * - `loopback` (default): direct loopback connections pass; with Cloudflare Access configured, a
 *   forwarded or remote upgrade needs a verified `Cf-Access-Jwt-Assertion`.
 * - `container` (`PSYCHE_BIND=container`): the Gateway listens on the container interface. A peer
 *   passes with the bearer token from `PSYCHE_GATEWAY_TOKEN_FILE`, or, when it is a trusted proxy,
 *   with a verified identity: a valid Cloudflare Access assertion, or the Tailscale identity
 *   headers from a peer in `trustedProxy.tailscaleProxies`. A trusted-proxy peer with neither, and
 *   any other peer without the token, is refused.
 */

export type BindMode = "loopback" | "container";

/** A token shorter than this is refused at startup. */
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

/**
 * Reads the shared transport token. The file must be a regular file owned by this user with no
 * group or other permission bits (0600 / 0400), or the Gateway refuses to start.
 */
export function readGatewayToken(path: string | undefined): string {
  if (path === undefined || path === "") {
    throw new PsycheError(
      "invalid_params",
      "PSYCHE_BIND=container requires PSYCHE_GATEWAY_TOKEN_FILE",
    );
  }
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    throw new PsycheError("invalid_params", `PSYCHE_GATEWAY_TOKEN_FILE ${path} cannot be read`);
  }
  if (!info.isFile()) {
    throw new PsycheError(
      "invalid_params",
      "PSYCHE_GATEWAY_TOKEN_FILE must be a regular file (not a symlink)",
    );
  }
  if ((info.mode & 0o077) !== 0) {
    throw new PsycheError(
      "forbidden",
      `PSYCHE_GATEWAY_TOKEN_FILE is mode ${(info.mode & 0o777).toString(8)}; it must be 0600 (no group or other access)`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  if (info.uid !== uid) {
    throw new PsycheError(
      "forbidden",
      "PSYCHE_GATEWAY_TOKEN_FILE must be owned by the Gateway's user",
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < MIN_GATEWAY_TOKEN_LENGTH) {
    throw new PsycheError(
      "invalid_params",
      `the gateway token must be at least ${MIN_GATEWAY_TOKEN_LENGTH} characters`,
    );
  }
  return token;
}

/** The container's own non-loopback IPv4 address (the bridge interface). */
export function containerAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === "IPv4") return a.address;
    }
  }
  throw new PsycheError(
    "unavailable",
    "PSYCHE_BIND=container: no non-loopback IPv4 interface found",
  );
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1];
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function inList(list: BlockList, addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
  const f = isIP(a);
  return f !== 0 && list.check(a, f === 4 ? "ipv4" : "ipv6");
}

export interface TransportGateOptions {
  mode: BindMode;
  token: string | null;
  trustedProxies: BlockList;
  tailscaleProxies: BlockList;
  cfAccess: CloudflareAccessVerifier | null;
}

export type Admission = { peer: ResolvedPeer } | { refused: string };

export class TransportGate {
  readonly #o: TransportGateOptions;

  constructor(options: TransportGateOptions) {
    if (options.mode === "container" && options.token === null) {
      throw new PsycheError(
        "invalid_params",
        "PSYCHE_BIND=container requires PSYCHE_GATEWAY_TOKEN_FILE",
      );
    }
    this.#o = options;
  }

  get mode(): BindMode {
    return this.#o.mode;
  }

  /** Decides one HTTP request or WebSocket upgrade. Reasons are for logs; they quote nothing. */
  async admit(req: IncomingMessage, resolved: ResolvedPeer): Promise<Admission> {
    const { mode, token, cfAccess } = this.#o;
    if (mode === "loopback") {
      if (cfAccess === null || (!resolved.forwarded && resolved.remoteLoopback))
        return { peer: resolved };
      return this.#viaAccess(req, resolved);
    }
    // container
    if (token !== null && tokenMatches(token, bearer(req))) return { peer: resolved };
    const direct = req.socket.remoteAddress;
    if (!inList(this.#o.trustedProxies, direct)) return { refused: "token_required" };
    if (cfAccess !== null && cfAccessHeader(req.headers) !== undefined)
      return this.#viaAccess(req, resolved);
    const login = req.headers["tailscale-user-login"];
    if (inList(this.#o.tailscaleProxies, direct) && typeof login === "string" && login.length > 0) {
      return { peer: { ...resolved, claimedIdentity: `Tailscale ${login.slice(0, 256)}` } };
    }
    return { refused: "proxy_identity_required" };
  }

  async #viaAccess(req: IncomingMessage, resolved: ResolvedPeer): Promise<Admission> {
    try {
      const v = await (this.#o.cfAccess as CloudflareAccessVerifier).verify(
        cfAccessHeader(req.headers),
      );
      return {
        peer: { ...resolved, claimedIdentity: `Cloudflare Access ${v.email ?? v.subject}` },
      };
    } catch {
      return { refused: "cloudflare_access" };
    }
  }
}
