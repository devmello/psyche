import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import {
  type ConnectChallenge,
  type ConnectParams,
  type ConnectResult,
  type ConnectVerifyParams,
  connectSigningPayload,
  type Device,
  type DeviceScope,
  PROTOCOL_VERSION,
  PsycheError,
} from "@psyche/protocol";
import { type GatewayStore, OPERATOR_SCOPES } from "./store.ts";

export const CHALLENGE_TTL_MS = 60_000;
export const PAIRING_TTL_MS = 5 * 60_000;

/** What the transport knows about the peer (security §10). */
export interface PeerInfo {
  transport: "ws" | "unix";
  remoteLoopback: boolean;
  /** WebSocket `Origin` header; `null` for native clients and Unix-socket nodes. */
  origin: string | null;
}

export interface PendingChallenge {
  params: ConnectParams;
  nonce: string;
  protocolVersion: number;
  expiresAtMs: number;
}

export interface PairedIdentity {
  deviceId: string;
  scopes: DeviceScope[];
  role: "client" | "node";
}

export function negotiateVersion(range: { min: number; max: number }): number {
  if (range.min > PROTOCOL_VERSION || range.max < PROTOCOL_VERSION) {
    throw new PsycheError(
      "protocol_version_mismatch",
      `Gateway speaks protocol ${PROTOCOL_VERSION}; client offered ${range.min}-${range.max}`,
      { details: { server: PROTOCOL_VERSION } },
    );
  }
  return PROTOCOL_VERSION;
}

function rawEd25519PublicKey(b64url: string) {
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length !== 32) {
    throw new PsycheError(
      "invalid_params",
      "publicKey must be a base64url raw 32-byte Ed25519 key",
    );
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function issueChallenge(
  params: ConnectParams,
  serverOrigin: string,
  nowMs: number,
): { pending: PendingChallenge; challenge: ConnectChallenge } {
  const protocolVersion = negotiateVersion(params.protocolVersion);
  rawEd25519PublicKey(params.publicKey); // validate early
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + CHALLENGE_TTL_MS;
  return {
    pending: { params, nonce, protocolVersion, expiresAtMs },
    challenge: {
      phase: "challenge",
      nonce,
      serverOrigin,
      protocolVersion,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
}

function secretMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Loopback auto-approval applies only to the desktop shell and the mac helper presenting the
 * per-launch handshake secret, over loopback, without a browser `Origin` (architecture §11).
 */
export function autoPairScopes(
  params: ConnectParams,
  peer: PeerInfo,
  handshakeSecret: string,
): DeviceScope[] | null {
  if (!peer.remoteLoopback || peer.origin !== null) return null;
  if (!secretMatches(handshakeSecret, params.handshakeSecret)) return null;
  if (params.role === "client" && params.deviceFamily === "desktop") return [...OPERATOR_SCOPES];
  if (params.role === "node" && params.deviceFamily === "mac-helper") return ["node"];
  return null;
}

export interface VerifyDeps {
  store: GatewayStore;
  handshakeSecret: string;
  serverOrigin: string;
  now: () => Date;
}

/** Completes the signed challenge and decides paired / pending / denied. */
export function verifyChallenge(
  pending: PendingChallenge,
  input: ConnectVerifyParams,
  peer: PeerInfo,
  deps: VerifyDeps,
): { result: ConnectResult; identity: PairedIdentity | null } {
  const now = deps.now();
  if (input.nonce !== pending.nonce)
    throw new PsycheError("unauthorized", "Nonce does not match the challenge");
  if (now.getTime() > pending.expiresAtMs)
    throw new PsycheError("unauthorized", "Challenge expired");
  const { params } = pending;
  const payload = connectSigningPayload({
    nonce: pending.nonce,
    platform: params.platform,
    deviceFamily: params.deviceFamily,
    protocolVersion: pending.protocolVersion,
    serverOrigin: deps.serverOrigin,
  });
  const signature = Buffer.from(input.signature, "base64url");
  const ok = verify(null, payload, rawEd25519PublicKey(params.publicKey), signature);
  if (!ok) throw new PsycheError("unauthorized", "Bad challenge signature");

  const nowIso = now.toISOString();
  const role = params.role === "node" ? "node" : "client";
  const existing = deps.store.getDevice(params.deviceId);
  if (existing) {
    if (existing.revokedAt)
      return { result: { phase: "denied", reason: "device revoked" }, identity: null };
    if (existing.publicKey !== params.publicKey) {
      return { result: { phase: "denied", reason: "device key mismatch" }, identity: null };
    }
    if (existing.pairedAt) {
      deps.store.touchDevice(existing.id, nowIso);
      return {
        result: pairedResult(existing.id, existing.scopes, nowIso),
        identity: { deviceId: existing.id, scopes: existing.scopes, role },
      };
    }
  }

  const scopes = autoPairScopes(params, peer, deps.handshakeSecret);
  const device: Device = {
    id: params.deviceId,
    name: params.name,
    platform: params.platform,
    role: params.role === "node" ? "node" : "client",
    publicKey: params.publicKey,
    scopes: scopes ?? [],
    pairedAt: scopes ? nowIso : null,
    lastSeenAt: nowIso,
    revokedAt: null,
  };
  if (scopes) {
    deps.store.upsertDevice(device);
    return {
      result: pairedResult(device.id, scopes, nowIso),
      identity: { deviceId: device.id, scopes, role },
    };
  }

  // Not eligible for auto-approval: the owner approves via devices.approve (S01).
  const request = deps.store.transaction(() => {
    if (!existing) deps.store.upsertDevice(device);
    return (
      deps.store.findPendingPairingForDevice(device.id, nowIso) ??
      deps.store.createPairingRequest({
        deviceId: device.id,
        display: `${params.name} (${params.platform}, ${params.deviceFamily})`,
        expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
      })
    );
  });
  return {
    result: { phase: "pending", pairingRequestId: request.id, code: request.code },
    identity: null,
  };
}

function pairedResult(deviceId: string, scopes: DeviceScope[], serverTime: string): ConnectResult {
  // stateVersion is filled in by the connection, which owns the event bus.
  return { phase: "paired", deviceId, scopes, stateVersion: 0, serverTime };
}
