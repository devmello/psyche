import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATEWAY_PORT, PROTOCOL_VERSION } from "@psyche/protocol";
import { GatewayConnection, type GatewayConnectionOptions } from "@psyche/web/client";
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
}

export function defaultPsycheHome(): string {
  return process.env.PSYCHE_HOME ?? join(homedir(), ".psyche");
}

export function defaultGatewayOrigin(): string {
  return process.env.PSYCHE_GATEWAY_ORIGIN ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
}

export async function readHandshakeSecret(home: string): Promise<string | undefined> {
  try {
    const secret = (await readFile(join(home, "run", "handshake.secret"), "utf8")).trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
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
    connectParams: async () => {
      const handshakeSecret = await readHandshakeSecret(home);
      return {
        protocolVersion: { min: 1, max: PROTOCOL_VERSION },
        deviceId: key.deviceId,
        publicKey: key.publicKey,
        role: "client",
        platform: platformFromNode(process.platform),
        deviceFamily: "desktop",
        name: `Psyche Desktop (${hostname()})`.slice(0, 64),
        ...(handshakeSecret ? { handshakeSecret } : {}),
      };
    },
    sign: (payload) => signWithDeviceKey(key, payload),
    onStatus: opts.onStatus,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onResync ? { onResync: opts.onResync } : {}),
  });
}
