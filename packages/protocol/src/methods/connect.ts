import { type Static, Type } from "@sinclair/typebox";
import { DeviceScope, Id, IsoDateTime, StringEnum } from "../common.ts";
import { PsycheError } from "../errors.ts";
import { DevicePlatform, NodeCapability } from "../schemas/identity.ts";
import { defineMethod } from "./define.ts";

/**
 * Handshake and pairing (wire spec v1; architecture §7, §11; security §10). The first frame on
 * every connection is `req connect`; anything else before pairing gets `not_paired`.
 */

/** Challenge nonce: base64url (no padding) of 32 random bytes. */
const Nonce = Type.String({
  pattern: "^[A-Za-z0-9_-]{43}$",
  description: "base64url, 32 random bytes",
});

export const ConnectRole = StringEnum(["client", "node"], { $id: "ConnectRole" });
export type ConnectRole = Static<typeof ConnectRole>;

export const ProtocolVersionRange = Type.Object(
  { min: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }) },
  { $id: "ProtocolVersionRange" },
);
export type ProtocolVersionRange = Static<typeof ProtocolVersionRange>;

/** Device family string; also part of the signed payload, so no newlines (pattern). */
export const DeviceFamily = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
  description: '"desktop" | "web" | "mac-helper" | "cli" | …',
  $id: "DeviceFamily",
});

export const ConnectParams = Type.Object(
  {
    protocolVersion: ProtocolVersionRange,
    deviceId: Id,
    publicKey: Type.String({
      pattern: "^[A-Za-z0-9_-]{43}$",
      description: "base64url raw Ed25519 public key (32 bytes)",
    }),
    role: ConnectRole,
    platform: DevicePlatform,
    deviceFamily: DeviceFamily,
    name: Type.String({ minLength: 1, maxLength: 128 }),
    capabilities: Type.Optional(Type.Array(NodeCapability)),
    handshakeSecret: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "Per-launch secret from $PSYCHE_HOME/run/handshake.secret; enables loopback auto-pairing only without an Origin header",
      }),
    ),
  },
  { $id: "ConnectParams" },
);
export type ConnectParams = Static<typeof ConnectParams>;

export const ConnectChallenge = Type.Object(
  {
    phase: Type.Literal("challenge"),
    nonce: Nonce,
    serverOrigin: Type.String({ minLength: 1 }),
    protocolVersion: Type.Integer({ minimum: 1, description: "Negotiated version" }),
    expiresAt: IsoDateTime,
    gatewayKey: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{43}$",
        description:
          "The Gateway's long-lived identity public key (base64url raw Ed25519). Clients pin it at first pair and refuse a different one (remote-gateway design §3.3)",
      }),
    ),
    gatewaySignature: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{86}$",
        description:
          "base64url Ed25519 signature by the Gateway identity key over gatewaySigningPayload(nonce, serverOrigin, the connecting device's public key)",
      }),
    ),
    lanCertSpki: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{43}$",
        description:
          "LAN listener only: the SHA-256 (base64url) of the SPKI of the TLS certificate this connection was served with. The client compares it with the certificate it actually saw, so a relay with its own certificate is caught",
      }),
    ),
    lanCertSignature: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{86}$",
        description:
          "base64url Ed25519 signature by the Gateway identity key over lanCertSigningPayload(nonce, serverOrigin, device key, lanCertSpki)",
      }),
    ),
  },
  { $id: "ConnectChallenge" },
);
export type ConnectChallenge = Static<typeof ConnectChallenge>;

export const ConnectVerifyParams = Type.Object(
  {
    nonce: Nonce,
    signature: Type.String({
      pattern: "^[A-Za-z0-9_-]{86}$",
      description: "base64url Ed25519 signature (64 bytes) over connectSigningPayload(...)",
    }),
    gatewayKey: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{43}$",
        description:
          "The Gateway identity key this client verified and pinned (base64url). When present the signature is over the v2 payload, which includes it, and the Gateway refuses the connect unless it is its own key. A client of a remote Gateway always sends it",
      }),
    ),
  },
  { $id: "ConnectVerifyParams" },
);
export type ConnectVerifyParams = Static<typeof ConnectVerifyParams>;

export const ConnectPaired = Type.Object(
  {
    phase: Type.Literal("paired"),
    deviceId: Id,
    scopes: Type.Array(DeviceScope),
    nodeId: Type.Optional(Id),
    stateVersion: Type.Integer({ minimum: 0 }),
    serverTime: IsoDateTime,
  },
  { $id: "ConnectPaired" },
);
export const ConnectPending = Type.Object(
  { phase: Type.Literal("pending"), pairingRequestId: Id, code: Type.String({ minLength: 1 }) },
  { $id: "ConnectPending" },
);
export const ConnectDenied = Type.Object(
  { phase: Type.Literal("denied"), reason: Type.String() },
  { $id: "ConnectDenied" },
);
export const ConnectResult = Type.Union([ConnectPaired, ConnectPending, ConnectDenied], {
  $id: "ConnectResult",
});
export type ConnectResult = Static<typeof ConnectResult>;

export const CONNECT_SIGNING_PREFIX = "psyche-connect-v1";

export const CONNECT_SIGNING_PREFIX_V2 = "psyche-connect-v2";

export interface ConnectSigningInput {
  nonce: string;
  platform: string;
  deviceFamily: string;
  protocolVersion: number;
  serverOrigin: string;
  /**
   * The Gateway identity key the device verified (v2 payload). Without it the payload is v1, as
   * before. A v2 signature cannot be passed off as v1 (the prefix differs), so a relay cannot
   * strip the key.
   */
  gatewayKey?: string;
}

/**
 * Bytes the device signs with its Ed25519 key for `connect.verify`: the UTF-8 encoding of
 * `"psyche-connect-v1\n" + nonce + "\n" + platform + "\n" + deviceFamily + "\n" + protocolVersion + "\n" + serverOrigin`.
 * Fields are newline-delimited, so a field containing a newline is rejected (it would make the
 * payload ambiguous).
 */
export function connectSigningPayload(input: ConnectSigningInput): Uint8Array {
  const { nonce, platform, deviceFamily, protocolVersion, serverOrigin, gatewayKey } = input;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new PsycheError("invalid_params", "protocolVersion must be a positive integer");
  }
  for (const [key, value] of Object.entries({
    nonce,
    platform,
    deviceFamily,
    serverOrigin,
    ...(gatewayKey === undefined ? {} : { gatewayKey }),
  })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new PsycheError("invalid_params", `${key} must be a non-empty single-line string`);
    }
  }
  return new TextEncoder().encode(
    [
      gatewayKey === undefined ? CONNECT_SIGNING_PREFIX : CONNECT_SIGNING_PREFIX_V2,
      nonce,
      platform,
      deviceFamily,
      String(protocolVersion),
      serverOrigin,
      ...(gatewayKey === undefined ? [] : [gatewayKey]),
    ].join("\n"),
  );
}

export const GATEWAY_SIGNING_PREFIX = "psyche-gateway-v1";

export interface GatewaySigningInput {
  nonce: string;
  serverOrigin: string;
  /** The connecting device's public key (base64url), as sent in `connect`. */
  devicePublicKey: string;
}

/**
 * Bytes the Gateway signs with its identity key in a challenge: the UTF-8 encoding of
 * `"psyche-gateway-v1\n" + nonce + "\n" + serverOrigin + "\n" + devicePublicKey`. The nonce makes
 * it fresh, the origin binds it to the address the client dials, and the device key binds it to
 * this one connection, so a signature relayed to another device or origin verifies for nobody.
 * Shared by the Gateway (signs), the desktop client and the phone (verify).
 */
export function gatewaySigningPayload(input: GatewaySigningInput): Uint8Array {
  const { nonce, serverOrigin, devicePublicKey } = input;
  for (const [key, value] of Object.entries({ nonce, serverOrigin, devicePublicKey })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new PsycheError("invalid_params", `${key} must be a non-empty single-line string`);
    }
  }
  return new TextEncoder().encode(
    [GATEWAY_SIGNING_PREFIX, nonce, serverOrigin, devicePublicKey].join("\n"),
  );
}

export const LAN_CERT_SIGNING_PREFIX = "psyche-lan-cert-v1";

export interface LanCertSigningInput extends GatewaySigningInput {
  /** SHA-256 of the served certificate's SPKI, base64url. */
  spki: string;
}

/**
 * Bytes the Gateway signs to vouch for the TLS certificate of a LAN connection: the UTF-8
 * encoding of `"psyche-lan-cert-v1\n" + nonce + "\n" + serverOrigin + "\n" + devicePublicKey +
 * "\n" + spki`. A LAN certificate is self-signed, so nothing else ties the encrypted channel to
 * the Gateway: a machine that answers with its own certificate and relays the Gateway's frames
 * would otherwise pass the identity check. The client refuses unless `spki` is the certificate
 * it actually received (and, once pinned, the pinned one).
 */
export function lanCertSigningPayload(input: LanCertSigningInput): Uint8Array {
  const { nonce, serverOrigin, devicePublicKey, spki } = input;
  for (const [key, value] of Object.entries({ nonce, serverOrigin, devicePublicKey, spki })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new PsycheError("invalid_params", `${key} must be a non-empty single-line string`);
    }
  }
  return new TextEncoder().encode(
    [LAN_CERT_SIGNING_PREFIX, nonce, serverOrigin, devicePublicKey, spki].join("\n"),
  );
}

export const ConnectMethods = {
  connect: defineMethod({
    params: ConnectParams,
    result: ConnectChallenge,
    scope: "none",
    description:
      "First frame on every connection. Negotiates the protocol version and returns a 60 s challenge nonce.",
  }),
  "connect.verify": defineMethod({
    params: ConnectVerifyParams,
    result: ConnectResult,
    scope: "none",
    description:
      "Proves possession of the device key by signing connectSigningPayload(...). Returns paired (with owner-chosen scopes), pending (a pairing request awaiting approval) or denied.",
  }),
} as const;
