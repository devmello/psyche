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

export interface ConnectSigningInput {
  nonce: string;
  platform: string;
  deviceFamily: string;
  protocolVersion: number;
  serverOrigin: string;
}

/**
 * Bytes the device signs with its Ed25519 key for `connect.verify`: the UTF-8 encoding of
 * `"psyche-connect-v1\n" + nonce + "\n" + platform + "\n" + deviceFamily + "\n" + protocolVersion + "\n" + serverOrigin`.
 * Fields are newline-delimited, so a field containing a newline is rejected (it would make the
 * payload ambiguous).
 */
export function connectSigningPayload(input: ConnectSigningInput): Uint8Array {
  const { nonce, platform, deviceFamily, protocolVersion, serverOrigin } = input;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new PsycheError("invalid_params", "protocolVersion must be a positive integer");
  }
  for (const [key, value] of Object.entries({ nonce, platform, deviceFamily, serverOrigin })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new PsycheError("invalid_params", `${key} must be a non-empty single-line string`);
    }
  }
  return new TextEncoder().encode(
    [
      CONNECT_SIGNING_PREFIX,
      nonce,
      platform,
      deviceFamily,
      String(protocolVersion),
      serverOrigin,
    ].join("\n"),
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
