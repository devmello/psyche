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
    lan: Type.Optional(
      Type.Object({
        enabled: Type.Boolean({ description: "The `gateway.lan` setting is on" }),
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        interfaces: Type.Array(Type.String(), {
          description: "The interface names or addresses the owner chose; empty = the default one",
        }),
        listening: Type.Array(Type.Object({ address: Type.String(), port: Type.Integer() }), {
          description: "What is bound right now; empty when off or when nothing could bind",
        }),
        candidates: Type.Array(
          Type.Object({ name: Type.String(), address: Type.String(), isDefault: Type.Boolean() }),
          { description: "Interfaces the owner can pick" },
        ),
        origin: Type.Union([Type.String(), Type.Null()], {
          description: "https://<host>.local:<port> while listening",
        }),
        certSpki: Type.Union([Type.String(), Type.Null()], {
          description: "SHA-256 (base64url) of the LAN certificate's SPKI: the cert pin",
        }),
        advertising: Type.Boolean({ description: "Bonjour `_psyche._tcp` is being advertised" }),
        problems: Type.Array(Type.String(), {
          description:
            "Why something the owner asked for is not happening: unknown_interface:<name>, no_interface, bind_failed:<address>:<code>, container_bind, advertise_failed",
        }),
      }),
    ),
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
  "gateway.lan.rotateCert": defineMethod({
    params: Type.Object({
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Type.String()),
    }),
    result: Type.Object({ certSpki: Type.String() }),
    scope: "operator.admin",
    description:
      "Replaces the LAN TLS certificate and its key. Every client that pinned the old certificate must pair again. Needs fresh presence once a verifier is enrolled.",
  }),
} as const;
