import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  countPairingsFromAddress,
  countPendingPairings,
  createPairingRequest,
  expirePendingPairingsForDevice,
  findPendingPairingForDevice,
  getDevice,
  insertDevice,
  type PsycheDb,
  touchLastSeen,
  updateDevice,
} from "@psyche/db";
import {
  type ConnectChallenge,
  type ConnectParams,
  type ConnectResult,
  type ConnectVerifyParams,
  connectSigningPayload,
  type DeviceScope,
  type PairingRequest,
  PROTOCOL_VERSION,
  PsycheError,
} from "@psyche/protocol";
import type { GatewayLimits } from "./context.ts";
import type { RateLimiter } from "./rate-limit.ts";

export const CHALLENGE_TTL_MS = 60_000;

/**
 * Scopes the per-launch handshake secret can buy. Never `operator.admin`: the secret is a
 * bearer token any same-user process can read (S23 review PR-1-A, design-19), so admin needs
 * the owner's approval (`devices.approve`, or `psyched devices approve` on the machine).
 */
export const DESKTOP_AUTO_SCOPES: DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
];

/** What the transport knows about the peer (security §10). */
export interface PeerInfo {
  transport: "ws" | "unix";
  remoteLoopback: boolean;
  /** Peer IP for WebSockets, `"unix"` for the node socket. Rate limits key on it. */
  remoteAddress: string;
  /** WebSocket `Origin` header; `null` for native clients and Unix-socket nodes. */
  origin: string | null;
  /** Identity a trusted proxy claims for the client; shown on the pairing card, never trusted. */
  claimedIdentity?: string | null;
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

/** `sha256:<hex>` of the raw public key: what the owner compares on the pairing card. */
export function keyFingerprint(publicKeyB64url: string): string {
  const raw = Buffer.from(publicKeyB64url, "base64url");
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** Pairing codes avoid look-alike characters (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function pairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function issueChallenge(
  params: ConnectParams,
  peer: PeerInfo,
  serverOrigin: string,
  nowMs: number,
): { pending: PendingChallenge; challenge: ConnectChallenge } {
  // Clients use the WebSocket; the node socket is for nodes only (S23 review PR-1-A).
  if (peer.transport === "unix" && params.role !== "node") {
    throw new PsycheError("forbidden", "The node socket accepts only role: node");
  }
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
 * Identity headers from a proxy play no part here.
 */
export function autoPairScopes(
  params: ConnectParams,
  peer: PeerInfo,
  handshakeSecret: string,
): DeviceScope[] | null {
  if (!peer.remoteLoopback || peer.origin !== null) return null;
  if (!secretMatches(handshakeSecret, params.handshakeSecret)) return null;
  if (params.role === "client" && params.deviceFamily === "desktop" && peer.transport === "ws") {
    return [...DESKTOP_AUTO_SCOPES];
  }
  if (params.role === "node" && params.deviceFamily === "mac-helper") return ["node"];
  return null;
}

export interface VerifyDeps {
  db: PsycheDb;
  handshakeSecret: string;
  serverOrigin: string;
  now: () => Date;
  limits: GatewayLimits;
  failedChallenges: RateLimiter;
}

export interface VerifyOutcome {
  result: ConnectResult;
  identity: PairedIdentity | null;
  /** Set when this handshake created a new pairing request (emit `pairing.requested`). */
  createdRequest: PairingRequest | null;
  /** The pending device, for `pending` results. */
  pendingDeviceId: string | null;
}

function denied(reason: string): VerifyOutcome {
  return {
    result: { phase: "denied", reason },
    identity: null,
    createdRequest: null,
    pendingDeviceId: null,
  };
}

/** Completes the signed challenge and decides paired / pending / denied. */
export function verifyChallenge(
  pending: PendingChallenge,
  input: ConnectVerifyParams,
  peer: PeerInfo,
  deps: VerifyDeps,
): VerifyOutcome {
  const now = deps.now();
  // Security §10: failed challenges 10/minute/IP.
  if (!deps.failedChallenges.allowed(peer.remoteAddress)) {
    throw new PsycheError("rate_limited", "Too many failed challenges; try again later", {
      retryable: true,
    });
  }
  const fail = (message: string): never => {
    deps.failedChallenges.record(peer.remoteAddress);
    throw new PsycheError("unauthorized", message);
  };
  if (input.nonce !== pending.nonce) fail("Nonce does not match the challenge");
  if (now.getTime() > pending.expiresAtMs) fail("Challenge expired");
  const { params } = pending;
  const payload = connectSigningPayload({
    nonce: pending.nonce,
    platform: params.platform,
    deviceFamily: params.deviceFamily,
    protocolVersion: pending.protocolVersion,
    serverOrigin: deps.serverOrigin,
  });
  const signature = Buffer.from(input.signature, "base64url");
  if (!verify(null, payload, rawEd25519PublicKey(params.publicKey), signature)) {
    fail("Bad challenge signature");
  }

  const { db } = deps;
  const nowIso = now.toISOString();
  const existing = getDevice(db, params.deviceId);
  if (existing?.revokedAt) return denied("device revoked");
  if (existing?.pairedAt) {
    // A paired device must present its pairing key, and keeps the role it was paired with.
    if (existing.publicKey !== params.publicKey) return denied("device key mismatch");
    if (existing.role !== "both" && existing.role !== params.role) {
      return denied("device role mismatch");
    }
    touchLastSeen(db, existing.id, nowIso);
    return {
      result: pairedResult(existing.id, existing.scopes, nowIso),
      identity: { deviceId: existing.id, scopes: existing.scopes, role: params.role },
      createdRequest: null,
      pendingDeviceId: null,
    };
  }

  const scopes = autoPairScopes(params, peer, deps.handshakeSecret);
  const keyChanged = existing !== undefined && existing.publicKey !== params.publicKey;
  if (keyChanged && scopes === null && findPendingPairingForDevice(db, existing.id, nowIso)) {
    // Another key is waiting for approval under this id; re-keying it would let a second
    // process take over the request the owner is about to approve (S23 review PR-1-B).
    return denied("device id in use by another key");
  }

  return db.sqlite.transaction((): VerifyOutcome => {
    const role = params.role === "node" ? "node" : "client";
    if (existing === undefined) {
      insertDevice(db, {
        id: params.deviceId,
        name: params.name,
        platform: params.platform,
        role,
        publicKey: params.publicKey,
        scopes: scopes ?? [],
        pairedAt: scopes ? nowIso : null,
      });
    } else {
      // Unpaired rows carry no authority. The holder of the handshake secret replaces a squatter.
      if (keyChanged) expirePendingPairingsForDevice(db, existing.id);
      updateDevice(db, existing.id, {
        name: params.name,
        publicKey: params.publicKey,
        role,
        scopes: scopes ?? [],
        pairedAt: scopes ? nowIso : null,
      });
    }
    touchLastSeen(db, params.deviceId, nowIso);
    if (scopes) {
      return {
        result: pairedResult(params.deviceId, scopes, nowIso),
        identity: { deviceId: params.deviceId, scopes, role: params.role },
        createdRequest: null,
        pendingDeviceId: null,
      };
    }

    // Not eligible for auto-approval: the owner approves via devices.approve.
    const live = findPendingPairingForDevice(db, params.deviceId, nowIso);
    if (live) {
      return {
        result: { phase: "pending", pairingRequestId: live.id, code: live.code },
        identity: null,
        createdRequest: null,
        pendingDeviceId: params.deviceId,
      };
    }
    if (countPendingPairings(db, nowIso) >= deps.limits.maxPendingPairings) {
      throw new PsycheError(
        "rate_limited",
        "Too many pending pairing requests; approve or deny some first",
        { retryable: true },
      );
    }
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    if (countPairingsFromAddress(db, peer.remoteAddress, hourAgo) >= deps.limits.pairingsPerHour) {
      throw new PsycheError("rate_limited", "Too many pairing requests from this address", {
        retryable: true,
      });
    }
    const request = createPairingRequest(db, {
      kind: "device",
      code: pairingCode(),
      deviceId: params.deviceId,
      display: `${params.name} (${params.platform}, ${params.deviceFamily}; claimed by the device)${
        peer.claimedIdentity ? `; proxy says ${peer.claimedIdentity}` : ""
      }`,
      expiresAt: new Date(now.getTime() + deps.limits.pairingTtlMs).toISOString(),
      publicKeyFingerprint: keyFingerprint(params.publicKey),
      transport: peer.transport,
      remoteAddress: peer.remoteAddress,
    });
    return {
      result: { phase: "pending", pairingRequestId: request.id, code: request.code },
      identity: null,
      createdRequest: request,
      pendingDeviceId: params.deviceId,
    };
  })();
}

function pairedResult(deviceId: string, scopes: DeviceScope[], serverTime: string): ConnectResult {
  // stateVersion (and nodeId) are filled in by the connection, which owns the event bus.
  return { phase: "paired", deviceId, scopes, stateVersion: 0, serverTime };
}
