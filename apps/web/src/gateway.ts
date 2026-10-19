import { PROTOCOL_VERSION } from "@psyche/protocol";
import { GatewayConnection, type GatewayConnectionOptions } from "./client/connection.ts";
import { createEphemeralDeviceKey, type WebDeviceKey } from "./lib/device-key.ts";
import { gatewayWsUrl, healthzUrl } from "./lib/ws-url.ts";

/**
 * Browser Gateway connection. Connects only to `location.origin` (security §10) and never sends a
 * handshake secret: browser connections are never auto-approved, so a new browser shows "pending
 * pairing" until the owner approves it from a paired device.
 */
export function createWebGatewayConnection(
  handlers: Pick<GatewayConnectionOptions, "onStatus" | "onEvent" | "onResync">,
  loc: Pick<Location, "origin"> = window.location,
): GatewayConnection {
  let key: WebDeviceKey | undefined;
  const keyReady = async () => {
    key ??= await createEphemeralDeviceKey();
    return key;
  };
  return new GatewayConnection({
    wsUrl: gatewayWsUrl(loc),
    healthUrl: healthzUrl(loc),
    connectParams: async () => {
      const k = await keyReady();
      return {
        protocolVersion: { min: 1, max: PROTOCOL_VERSION },
        deviceId: k.deviceId,
        publicKey: k.publicKey,
        role: "client",
        platform: "web",
        deviceFamily: "web",
        name: "Psyche Web",
      };
    },
    sign: async (payload) => (await keyReady()).sign(payload),
    ...handlers,
  });
}
