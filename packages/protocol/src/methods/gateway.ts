import { Type } from "@sinclair/typebox";
import { defineMethod } from "./define.ts";

/** `gateway.*`: facts about the Gateway a client is connected to (remote-gateway design §3.1, §3.3). */

export const GatewayInfo = Type.Object(
  {
    identity: Type.Object({
      publicKey: Type.String({ description: "base64url raw Ed25519 identity public key" }),
      fingerprint: Type.String({ description: "sha256:<hex> of the raw key, as clients show it" }),
    }),
    hostName: Type.String({ description: "The Host machine's name" }),
    publicOrigin: Type.Union([Type.String(), Type.Null()], {
      description: "gateway.publicOrigin, the https address other computers reach it at",
    }),
    trustedProxy: Type.Boolean({ description: "gateway.trustedProxy is on" }),
  },
  { $id: "GatewayInfo" },
);

export const GatewayMethods = {
  "gateway.info": defineMethod({
    params: Type.Object({}),
    result: GatewayInfo,
    scope: "operator.read",
    description:
      "The Gateway's identity key and fingerprint, the Host's name and whether it is set up to be reached from other computers (publicOrigin, trusted proxy). The Host's Settings shows the fingerprint next to a pairing request so the owner can compare it with the one the new computer shows.",
  }),
} as const;
