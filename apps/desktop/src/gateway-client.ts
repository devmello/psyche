import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATEWAY_PORT, PROTOCOL_VERSION } from "@psyche/protocol";
import {
  type ConnectParams,
  GatewayConnection,
  type GatewayConnectionOptions,
  type GatewayVerifier,
} from "@psyche/web/client";
import { type DeviceKey, platformFromNode, signWithDeviceKey } from "./lib/device-key.ts";

/**
 * Main-process Gateway connection (wire spec v1, docs/archive/plans/s00.md). The renderer never sees the
 * handshake secret, the device key or any token: it gets `GatewayStatus`, events, and RPC
 * results through the preload bridge.
 *
 * The desktop connects only to its configured Gateway (security §10): loopback by default, never
 * a URL from a deep link or the renderer.
 */

export interface DesktopGatewayOptions
  extends Pick<GatewayConnectionOptions, "onStatus" | "onEvent" | "onResync"> {
  deviceKey: DeviceKey;
  /** Defaults to http://127.0.0.1:7979 (PSYCHE_GATEWAY_ORIGIN in dev and tests). */
  httpOrigin?: string;
  psycheHome?: string;
  /**
   * A saved remote Gateway: this Mac's handshake secret is never sent, even when the address is
   * loopback (an SSH tunnel reaches another machine's Gateway through 127.0.0.1).
   */
  remote?: boolean;
  /** The Gateway identity check (the pin of a saved remote Gateway); see `createGatewayVerifier`. */
  verifyGateway?: GatewayVerifier;
  /** The pairing link's setup token for the next connect, if one is saved and still live. */
  setupToken?: () => string | undefined;
}

export function defaultPsycheHome(): string {
  return process.env.PSYCHE_HOME ?? join(homedir(), ".psyche");
}

export function defaultGatewayOrigin(): string {
  return process.env.PSYCHE_GATEWAY_ORIGIN ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Whether `origin` is a loopback address, which is where a Gateway on this Mac listens (same set
 * the Gateway treats as loopback, `isLoopbackHost`). It is not proof the Gateway runs on this Mac:
 * a local SSH forward (`ssh -L 7979:127.0.0.1:7979 host`) is also `127.0.0.1` and reaches a Gateway
 * on another machine. The per-launch handshake secret is read from this Mac's own
 * `$PSYCHE_HOME/run`, so through such a forward the app sends this Mac's secret (a Gateway
 * elsewhere cannot use it and it names no secret of that Gateway); binding the secret to the
 * Gateway instance is a follow-up. Things that are only true of a Gateway on this Mac gate on
 * this check: sending the secret, launching and asking this Mac's own helper, and the first-admin
 * bootstrap (remote-gateway design §4.1 R0, §5.2). An unparsable origin counts as not local.
 */
export function isLocalGatewayOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

export async function readHandshakeSecret(home: string): Promise<string | undefined> {
  try {
    const secret = (await readFile(join(home, "run", "handshake.secret"), "utf8")).trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What this app sends at `connect`. The per-launch handshake secret is the local Gateway's bearer
 * for auto-pairing this app; it goes only to a Gateway on this Mac, never to one on another
 * machine, which has no use for it and must not learn it.
 */
export async function desktopConnectParams(opts: {
  key: DeviceKey;
  home: string;
  origin: string;
  /** A saved remote Gateway: never send the secret, whatever the address looks like. */
  remote?: boolean;
  /**
   * The single-use token from a pairing link, for a saved remote Gateway only. It marks the
   * pending request as expected; the owner still approves this computer.
   */
  setupToken?: string;
}): Promise<ConnectParams> {
  const handshakeSecret =
    opts.remote !== true && isLocalGatewayOrigin(opts.origin)
      ? await readHandshakeSecret(opts.home)
      : undefined;
  return {
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: opts.key.deviceId,
    publicKey: opts.key.publicKey,
    role: "client",
    platform: platformFromNode(process.platform),
    deviceFamily: "desktop",
    name: `Psyche Desktop (${hostname()})`.slice(0, 64),
    ...(handshakeSecret ? { handshakeSecret } : {}),
    ...(opts.remote === true && opts.setupToken !== undefined
      ? { setupToken: opts.setupToken }
      : {}),
  };
}

export function createDesktopGateway(opts: DesktopGatewayOptions): GatewayConnection {
  const origin = opts.httpOrigin ?? defaultGatewayOrigin();
  const ws = new URL("/ws", origin);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  const home = opts.psycheHome ?? defaultPsycheHome();
  const key = opts.deviceKey;
  return new GatewayConnection({
    wsUrl: ws.toString(),
    healthUrl: new URL("/healthz", origin).toString(),
    // Re-read per attempt: the secret changes on every Gateway launch.
    connectParams: () => {
      const setupToken = opts.setupToken?.();
      return desktopConnectParams({
        key,
        home,
        origin,
        ...(opts.remote ? { remote: true } : {}),
        ...(setupToken === undefined ? {} : { setupToken }),
      });
    },
    sign: (payload) => signWithDeviceKey(key, payload),
    ...(opts.verifyGateway ? { verifyGateway: opts.verifyGateway } : {}),
    onStatus: opts.onStatus,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onResync ? { onResync: opts.onResync } : {}),
  });
}
