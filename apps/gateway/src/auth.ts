import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  consumeSetupToken,
  countPairingsFromAddress,
  countPendingPairings,
  createPairingRequest,
  expirePendingPairingsForDevice,
  findPendingPairingForDevice,
  getDevice,
  getDeviceFamily,
  insertDevice,
  type PsycheDb,
  peekSetupToken,
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
  gatewaySigningPayload,
  isHostHelperFamily,
  lanCertSigningPayload,
  type PairingRequest,
  type PeerCheck,
  PROTOCOL_VERSION,
  PsycheError,
  type ServerBuild,
} from "@psyche/protocol";
import type { GatewayLimits } from "./context.ts";
import type { GatewayIdentity } from "./identity.ts";
import { recordPeerRefusal } from "./nodes/registry.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { stateSealFor } from "./security/state-seal.ts";

export const CHALLENGE_TTL_MS = 60_000;

/** App families that may pair with a setup token: the desktop app and the iOS app. */
const SETUP_TOKEN_FAMILIES: ReadonlySet<string> = new Set(["desktop", "ios"]);

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
  /**
   * `ws`: the HTTP/WebSocket listener. `unix`: the local node transport, where the Host's own
   * helper and psyche-node dial: the node socket (`run/node.sock`, 0600) on macOS and Linux, the
   * named pipe `\\.\pipe\psyche-node-<hash>` on Windows (`socket-path.ts`). `vm-relay`: the guest socket (`run/guest.sock`), where
   * the Host helper copies each sandbox guest's vsock stream; whatever the guest says, it is never
   * the Host's helper and never auto-pairs. `container-guest`: the per-container socket of a
   * separate desktop (`nodes/guest-sockets.ts`, `PeerInfo.guest`): a node that proves the
   * single-use token minted for that container, and nothing else, ever.
   */
  transport: "ws" | "unix" | "vm-relay" | "container-guest";
  remoteLoopback: boolean;
  /** Peer IP for WebSockets, `"unix"` / `"vm-relay"` for the sockets. Rate limits key on it. */
  remoteAddress: string;
  /**
   * What the pre-authentication rate limits key on when it is not the address itself: a LAN peer
   * on IPv6 is keyed by its /64 (`lan/listener.ts` `peerLimitKey`), because a neighbour can
   * choose any address in its own /64 and would otherwise get a fresh budget for each. The
   * address in `remoteAddress` stays exact for the pairing card.
   */
  limitKey?: string;
  /** WebSocket `Origin` header; `null` for native clients and Unix-socket nodes. */
  origin: string | null;
  /**
   * Set only by the listener of a separate desktop's own socket (`nodes/guest-sockets.ts`), never
   * from anything the peer sends: which container this socket belongs to, and the one check that
   * can pair a node on it (the container's single-use pairing token).
   */
  guest?: GuestPeer;
  /**
   * What the accept-time peer check found for a process on the Linux node socket (design §4.3):
   * set only by the transport that owns that socket, after it looked at the connecting process,
   * and never from anything the peer sends. Absent off Linux and on every other transport. A
   * `mismatch` is never a Host helper.
   */
  peerCheck?: PeerCheck;
  /** The machine reason behind `peerCheck` (logs and `devices.hostHelper.status`). */
  peerCheckReason?: string;
  /**
   * The packaged helper is installed, so the peer check is strict here: only `root_owned` can be
   * the Host helper. Set with `peerCheck`, by the transport.
   */
  peerCheckRequired?: true;
  /** The platform of this Gateway, set by the node transport (the family rule needs it). */
  hostPlatform?: NodeJS.Platform;
  /** Identity a trusted proxy claims for the client; shown on the pairing card, never trusted. */
  claimedIdentity?: string | null;
  /**
   * The connection came in on the LAN listener (`lan/listener.ts`). Such a peer is remote by
   * construction: `remoteLoopback` is false whatever its address, so it is never the desktop
   * shell, never auto-paired, and the v2 key binding applies. Set only by the listener the
   * transport owns, never from anything the peer sends.
   */
  lan?: true;
  /** The `Host` header of a LAN connection (names the origin it dialed); `null` otherwise. */
  host?: string | null;
}

/** A separate desktop's socket, as `verifyChallenge` sees it. */
export interface GuestPeer {
  /** The container this socket was made for. */
  container: string;
  /**
   * Spends the container's pairing token. True once, for the token minted for this container at
   * its start and presented before it expires; false for anything else, always.
   */
  redeem(presented: string | undefined, deviceId: string): boolean;
}

/** The /64 a LAN IPv6 peer is also counted under, or `undefined` (IPv4, loopback, sockets). */
const prefixKey = (peer: PeerInfo): string | undefined =>
  peer.limitKey !== undefined && peer.limitKey !== peer.remoteAddress ? peer.limitKey : undefined;

export interface PendingChallenge {
  params: ConnectParams;
  nonce: string;
  protocolVersion: number;
  expiresAtMs: number;
  /** The origin the challenge named and signed; verification checks against this one. */
  serverOrigin: string;
}

export interface PairedIdentity {
  deviceId: string;
  scopes: DeviceScope[];
  role: "client" | "node";
  /**
   * This connection is the Psyche desktop shell itself: loopback, `deviceFamily: desktop` over
   * WS, with the per-launch handshake secret (checked at every connect, not only at pairing).
   * A self-declared platform never makes a device the desktop (#278).
   */
  desktopShell?: true;
  /**
   * This connection is the Host's own helper: a `mac-helper` or `win-helper` node on the local
   * node transport that presented the per-launch handshake secret at this connect. The secret lives in
   * `$PSYCHE_HOME/run`, which the sandbox guest and any other machine cannot read, so neither a
   * guest that copied its identity file nor a Mac paired over the network can have it. The family
   * a node declares proves nothing by itself (#278, remote-gateway design §4.1).
   */
  hostHelper?: true;
  /**
   * This connection is the helper inside a separate desktop, paired on that container's own
   * socket with its single-use token. Whatever family it declares, it is a `guest` node bound to
   * this container, never the Host's helper.
   */
  guestContainer?: string;
}

/**
 * The Host helper's connection proof: the local node transport (Unix socket, or the named pipe on
 * Windows) plus the per-launch handshake secret. Every helper family qualifies, the same way. On
 * Linux the accept-time peer check must also not have found another program (`mismatch`); the
 * other outcomes are recorded and shown, not refused.
 */
export function isHostHelper(
  params: ConnectParams,
  peer: PeerInfo,
  handshakeSecret: string,
): boolean {
  return (
    peer.transport === "unix" &&
    peer.remoteLoopback &&
    peer.origin === null &&
    params.role === "node" &&
    isHostHelperFamily(params.deviceFamily) &&
    hostHelperRefusal(params, peer) === undefined &&
    secretMatches(handshakeSecret, params.handshakeSecret)
  );
}

/**
 * Why this node is refused as the Host helper on the node transport, or `undefined` when nothing
 * stands in the way (the secret is checked separately).
 * - A Linux helper exists only on Linux: on another OS a node declaring it is not the helper.
 * - Where the Linux peer check ran, only the `linux-helper` family is possible (a Mac or Windows
 *   helper cannot exist on this computer), and the connecting process must not be another
 *   program (`mismatch`). With the packaged helper installed (`peerCheckRequired`) it must also be
 *   that helper, root-owned (`root_owned`): `user_owned` and `unverified` are refused, because
 *   any file named `psyche-helper`, or any peer the Gateway could not identify, would otherwise
 *   pass. Without a packaged helper (AppImage, a dev build) `user_owned` and `unverified` are
 *   accepted, and recorded.
 */
export function hostHelperRefusal(params: ConnectParams, peer: PeerInfo): string | undefined {
  if (
    params.deviceFamily === "linux-helper" &&
    (peer.hostPlatform ?? process.platform) !== "linux"
  ) {
    return "a Linux helper pairs only on a Linux computer";
  }
  if (peer.peerCheck === undefined) return undefined;
  if (params.deviceFamily !== "linux-helper" || peer.peerCheck === "mismatch") {
    return "this process is not the Linux helper of this computer";
  }
  if (peer.peerCheckRequired === true && peer.peerCheck !== "root_owned") {
    return `the installed Linux helper could not be verified (${peer.peerCheck}: ${peer.peerCheckReason ?? "unknown"}); restart it from the Psyche app`;
  }
  return undefined;
}

/** The desktop shell's connection proof, the same one its auto-pairing needs. */
export function isDesktopShell(
  params: ConnectParams,
  peer: PeerInfo,
  handshakeSecret: string,
): boolean {
  return (
    peer.remoteLoopback &&
    peer.origin === null &&
    peer.transport === "ws" &&
    params.role === "client" &&
    params.deviceFamily === "desktop" &&
    secretMatches(handshakeSecret, params.handshakeSecret)
  );
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
  identity?: GatewayIdentity,
  /** The SPKI pin of the certificate this LAN connection was served with; LAN peers only. */
  lanCertSpki?: string | null,
  /** Which build is answering (`build-info.ts`); omitted, the challenge names none. */
  server?: ServerBuild,
): { pending: PendingChallenge; challenge: ConnectChallenge } {
  // Clients use the WebSocket; the node socket is for nodes only (S23 review PR-1-A).
  if (peer.transport !== "ws" && params.role !== "node") {
    throw new PsycheError("forbidden", "The node sockets accept only role: node");
  }
  const protocolVersion = negotiateVersion(params.protocolVersion);
  rawEd25519PublicKey(params.publicKey); // validate early
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + CHALLENGE_TTL_MS;
  return {
    pending: { params, nonce, protocolVersion, expiresAtMs, serverOrigin },
    challenge: {
      phase: "challenge",
      nonce,
      serverOrigin,
      protocolVersion,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(server === undefined ? {} : { server }),
      // Signed over this nonce, the origin and this device's key (design §3.3): it proves the
      // Gateway holds the key a client pinned, and cannot be replayed to another device.
      ...(identity
        ? {
            gatewayKey: identity.publicKey,
            gatewaySignature: identity.sign(
              gatewaySigningPayload({ nonce, serverOrigin, devicePublicKey: params.publicKey }),
            ),
            // On the LAN the certificate is self-signed: the identity key also vouches for the
            // one this connection was served with, so a relay with its own certificate fails.
            ...(peer.lan === true && lanCertSpki
              ? {
                  lanCertSpki,
                  lanCertSignature: identity.sign(
                    lanCertSigningPayload({
                      nonce,
                      serverOrigin,
                      devicePublicKey: params.publicKey,
                      spki: lanCertSpki,
                    }),
                  ),
                }
              : {}),
          }
        : {}),
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
  if (peer.transport === "container-guest" || peer.guest !== undefined) return null;
  if (!peer.remoteLoopback || peer.origin !== null || peer.transport === "vm-relay") return null;
  if (!secretMatches(handshakeSecret, params.handshakeSecret)) return null;
  if (params.role === "client" && params.deviceFamily === "desktop" && peer.transport === "ws") {
    return [...DESKTOP_AUTO_SCOPES];
  }
  if (params.role === "node" && isHostHelperFamily(params.deviceFamily)) return ["node"];
  return null;
}

export interface VerifyDeps {
  db: PsycheDb;
  handshakeSecret: string;
  serverOrigin: string;
  /** This Gateway's identity public key: a v2 connect must name it. */
  gatewayKey?: string;
  now: () => Date;
  limits: GatewayLimits;
  failedChallenges: RateLimiter;
  /** Failed challenges per IPv6 /64 on the LAN: a looser cap over the per-address one. */
  failedChallengesPrefix?: RateLimiter;
  /** New pairing requests from the LAN listener: their own, smaller budgets (address, /64, all). */
  lanPairings?: { perIp: RateLimiter; perPrefix?: RateLimiter; total: RateLimiter };
}

export interface VerifyOutcome {
  result: ConnectResult;
  identity: PairedIdentity | null;
  /** Set when this handshake created a new pairing request (emit `pairing.requested`). */
  createdRequest: PairingRequest | null;
  /** The pending device, for `pending` results. */
  pendingDeviceId: string | null;
  /** Set when a setup token paired this device (the connection reports it to the Host). */
  pairedBySetupToken?: { tokenId: string; deviceId: string; scopes: DeviceScope[] };
}

function denied(reason: string, code?: "setup_token_invalid" | "device_revoked"): VerifyOutcome {
  return {
    result: { phase: "denied", reason, ...(code === undefined ? {} : { code }) },
    identity: null,
    createdRequest: null,
    pendingDeviceId: null,
  };
}

/** The sentence a computer shows for a setup token that cannot be used. */
export const SETUP_TOKEN_REFUSED =
  "This pairing link was already used, has expired or was revoked. Make a new one on the Host.";

/** Completes the signed challenge and decides paired / pending / denied. */
export function verifyChallenge(
  pending: PendingChallenge,
  input: ConnectVerifyParams,
  peer: PeerInfo,
  deps: VerifyDeps,
): VerifyOutcome {
  const now = deps.now();
  // Security §10: failed challenges 10/minute/IP. On the LAN there are two levels: the peer's own
  // address, and (IPv6) its /64 at a looser cap, which a neighbour can fill. A peer over a limit
  // there is not refused up front: a connect that carries a setup token that is valid and unused
  // (checked by its hash, before any signature work) or, once the signature is checked, one that
  // proves a paired device's key, goes on. Neither can be locked out by someone else's failures.
  const prefix = prefixKey(peer);
  const overLimit =
    !deps.failedChallenges.allowed(peer.remoteAddress) ||
    (prefix !== undefined && deps.failedChallengesPrefix?.allowed(prefix) === false);
  const limited = () =>
    new PsycheError("rate_limited", "Too many failed challenges; try again later", {
      retryable: true,
    });
  const tokenOk =
    overLimit &&
    peer.lan === true &&
    input.setupToken !== undefined &&
    peekSetupToken(deps.db, input.setupToken, now.toISOString());
  const gated = overLimit && !tokenOk;
  if (gated && peer.lan !== true) throw limited();
  const record = () => {
    deps.failedChallenges.record(peer.remoteAddress);
    if (prefix !== undefined) deps.failedChallengesPrefix?.record(prefix);
  };
  const fail = (message: string): never => {
    if (gated) throw limited();
    record();
    throw new PsycheError("unauthorized", message);
  };
  if (input.nonce !== pending.nonce) fail("Nonce does not match the challenge");
  if (now.getTime() > pending.expiresAtMs) fail("Challenge expired");
  const { params } = pending;
  // A client that verified a Gateway key signs it into the connect (v2). It must be this
  // Gateway's own: a connect made for another key is a connect through something else. Without
  // the field only the v1 payload verifies, so a relay cannot strip it from a v2 signature.
  // The Psyche desktop app is the one client that verifies the Gateway key; coming from the
  // network (a Tailscale Serve connection, not loopback) it must bind its connect to the key, so
  // a remotely paired desktop is never on the unbound v1 payload. Browsers (family web), the CLI
  // and nodes never verify a key and connect as before.
  if (
    input.gatewayKey === undefined &&
    deps.gatewayKey !== undefined &&
    peer.transport === "ws" &&
    !peer.remoteLoopback &&
    params.role === "client" &&
    (params.deviceFamily === "desktop" || peer.lan === true)
  ) {
    // Every client on the LAN listener (not only the desktop app) must bind to the key: a LAN
    // client has to check `lanCertSignature` too, and a v1 connect has nothing to bind.
    fail("A client connecting over the network must name the Gateway key it verified");
  }
  if (
    input.gatewayKey !== undefined &&
    deps.gatewayKey !== undefined &&
    input.gatewayKey !== deps.gatewayKey
  ) {
    fail("The connect was made for a different Gateway key");
  }
  const payload = connectSigningPayload({
    ...(input.gatewayKey === undefined ? {} : { gatewayKey: input.gatewayKey }),
    nonce: pending.nonce,
    platform: params.platform,
    deviceFamily: params.deviceFamily,
    protocolVersion: pending.protocolVersion,
    // The origin this challenge named and signed, not one worked out again now.
    serverOrigin: pending.serverOrigin,
  });
  const signature = Buffer.from(input.signature, "base64url");
  if (!verify(null, payload, rawEd25519PublicKey(params.publicKey), signature)) {
    fail("Bad challenge signature");
  }

  const { db } = deps;
  const nowIso = now.toISOString();
  const existing = getDevice(db, params.deviceId);
  // Over the limit: only a device that proved a paired key (signature checked above) goes on.
  if (gated && !(existing?.pairedAt && existing.publicKey === params.publicKey)) {
    throw limited();
  }
  if (existing?.revokedAt) return denied("device revoked", "device_revoked");
  // A separate desktop's socket pairs one way only: its container's single-use token.
  if (peer.transport === "container-guest" || peer.guest !== undefined) {
    return verifyGuest(params, peer, existing !== undefined, deps, record);
  }
  // A Host helper (Mac or Windows) on the node transport either proves this launch's handshake
  // secret or is refused: accepted as an ordinary node it would stay connected (the helper only
  // retries after a denial) and Host features would stay off until it restarted. A stale or
  // missing secret happens around a Gateway restart; the helper re-reads the file and reconnects.
  if (
    params.role === "node" &&
    isHostHelperFamily(params.deviceFamily) &&
    peer.transport === "unix" &&
    !isHostHelper(params, peer, deps.handshakeSecret)
  ) {
    const refusal = hostHelperRefusal(params, peer);
    // The owner can see why the helper was turned away (`devices.hostHelper.status`), but only
    // for a process that held this launch's secret: anyone else is just a failed connection.
    if (
      refusal !== undefined &&
      peer.peerCheck !== undefined &&
      secretMatches(deps.handshakeSecret, params.handshakeSecret)
    ) {
      recordPeerRefusal(db, {
        peerCheck: peer.peerCheck,
        reason: peer.peerCheckReason ?? "unknown",
        required: peer.peerCheckRequired === true,
        message: refusal,
      });
    }
    return denied(refusal ?? "stale or missing handshake secret; reconnect with the current one");
  }
  if (existing?.pairedAt) {
    // A paired device must present its pairing key, and keeps the role it was paired with.
    if (existing.publicKey !== params.publicKey) return denied("device key mismatch");
    if (existing.role !== "both" && existing.role !== params.role) {
      return denied("device role mismatch");
    }
    // The family is pinned when the device pairs: a paired device cannot become a Mac helper (or
    // anything else) by declaring another family later. Devices paired before the column existed
    // record the family they declare now, once.
    // While the security records are untrusted, only what the seal still trusts (H4).
    const authz = stateSealFor(db)?.authorizeDevice(existing) ?? {
      ok: true as const,
      scopes: existing.scopes,
    };
    if (!authz.ok)
      return denied("device not trusted while Psyche's security records are untrusted");
    const pinned = getDeviceFamily(db, existing.id);
    // A device row the seal cannot vouch for is never written over (H1: the write would make it
    // look like the Gateway's own); it stays read-only and unpinned until a re-seal.
    if (pinned === null) {
      if (stateSealFor(db)?.genuine("devices", existing.id) ?? true) {
        updateDevice(db, existing.id, { deviceFamily: params.deviceFamily });
      }
    } else if (pinned !== params.deviceFamily) return denied("device family mismatch");
    touchLastSeen(db, existing.id, nowIso);
    // A token presented by a device that is already paired is spent anyway (the link was used,
    // by someone who did not need it), and grants nothing: the device keeps its own scopes.
    if (input.setupToken !== undefined)
      consumeSetupToken(db, input.setupToken, existing.id, nowIso);
    return {
      result: pairedResult(existing.id, authz.scopes, nowIso),
      identity: {
        deviceId: existing.id,
        scopes: authz.scopes,
        role: params.role,
        ...(isDesktopShell(params, peer, deps.handshakeSecret) ? { desktopShell: true } : {}),
        ...(isHostHelper(params, peer, deps.handshakeSecret) ? { hostHelper: true } : {}),
      },
      createdRequest: null,
      pendingDeviceId: null,
    };
  }

  let scopes = autoPairScopes(params, peer, deps.handshakeSecret);
  // A setup token (remote-gateway design §3.4) pairs a computer's app that came over the network,
  // never a node or a browser page, and never on the sockets the Host's own helper uses. It is
  // presented in `connect.verify`, after the client verified this Gateway's identity, and spent
  // below in the same transaction that writes the device.
  const presentedToken = scopes === null ? input.setupToken : undefined;
  // H-B: while the security records are untrusted no pairing link works (a planted one could
  // name any scopes), whatever the token row says.
  if (presentedToken !== undefined && stateSealFor(db)?.untrusted() != null) {
    return denied(SETUP_TOKEN_REFUSED, "setup_token_invalid");
  }
  // The token is a bearer secret, so only a client that verified this Gateway's key (and bound the
  // connect to it, the v2 payload) may present it: an impostor that does not hold the key never
  // gets a client to send one. The check is unconditional. The desktop app and the iPhone/iPad app
  // pair this way; both verify the key and bind the connect to it (mobile companion §2.2).
  if (
    presentedToken !== undefined &&
    !(
      peer.transport === "ws" &&
      peer.origin === null &&
      params.role === "client" &&
      SETUP_TOKEN_FAMILIES.has(params.deviceFamily) &&
      deps.gatewayKey !== undefined &&
      input.gatewayKey === deps.gatewayKey
    )
  ) {
    record();
    return denied(SETUP_TOKEN_REFUSED, "setup_token_invalid");
  }
  // A Host helper pairs only by the per-launch handshake secret on the machine. An owner-approved
  // pairing (a pending request anyone who can reach a transport may open) never makes a Host
  // helper: it would be offered the Host's computer use, keychain and approval cards.
  if (scopes === null && params.role === "node" && isHostHelperFamily(params.deviceFamily)) {
    return denied(
      params.deviceFamily === "win-helper"
        ? "a Windows helper pairs only with the handshake secret on its own PC"
        : params.deviceFamily === "linux-helper"
          ? "a Linux helper pairs only with the handshake secret on its own computer"
          : "a Mac helper pairs only with the handshake secret on its own Mac",
    );
  }
  const keyChanged = existing !== undefined && existing.publicKey !== params.publicKey;
  if (keyChanged && scopes === null && findPendingPairingForDevice(db, existing.id, nowIso)) {
    // Another key is waiting for approval under this id; re-keying it would let a second
    // process take over the request the owner is about to approve (S23 review PR-1-B).
    return denied("device id in use by another key");
  }

  return db.sqlite.transaction((): VerifyOutcome => {
    const role = params.role === "node" ? "node" : "client";
    let spentToken: { id: string; scopes: DeviceScope[] } | undefined;
    if (presentedToken !== undefined) {
      // One conditional UPDATE: a token that is unused, unrevoked and unexpired is spent here, so
      // two connections racing on it cannot both pair, and nothing below runs for a refused one.
      spentToken = consumeSetupToken(db, presentedToken, params.deviceId, nowIso);
      if (spentToken === undefined) {
        record();
        return denied(SETUP_TOKEN_REFUSED, "setup_token_invalid");
      }
      scopes = spentToken.scopes;
      // Whatever was waiting for the owner under this id is moot now: a stale pending card must
      // not later approve wider scopes than the owner chose when making the link.
      expirePendingPairingsForDevice(db, params.deviceId);
    }
    if (existing === undefined) {
      insertDevice(db, {
        id: params.deviceId,
        name: params.name,
        platform: params.platform,
        role,
        publicKey: params.publicKey,
        scopes: scopes ?? [],
        pairedAt: scopes ? nowIso : null,
        deviceFamily: params.deviceFamily,
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
        deviceFamily: params.deviceFamily,
      });
    }
    touchLastSeen(db, params.deviceId, nowIso);
    if (scopes) {
      return {
        result: pairedResult(params.deviceId, scopes, nowIso),
        identity: {
          deviceId: params.deviceId,
          scopes,
          role: params.role,
          ...(isDesktopShell(params, peer, deps.handshakeSecret) ? { desktopShell: true } : {}),
          ...(isHostHelper(params, peer, deps.handshakeSecret) ? { hostHelper: true } : {}),
        },
        createdRequest: null,
        pendingDeviceId: null,
        ...(spentToken === undefined
          ? {}
          : {
              pairedBySetupToken: { tokenId: spentToken.id, deviceId: params.deviceId, scopes },
            }),
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
    if (peer.lan === true && deps.lanPairings) {
      // A neighbour on the network gets a smaller budget than the global one, so a few of them
      // cannot fill the queue of pending requests the owner has to read.
      if (
        !deps.lanPairings.perIp.allowed(peer.remoteAddress) ||
        (prefix !== undefined && deps.lanPairings.perPrefix?.allowed(prefix) === false) ||
        !deps.lanPairings.total.allowed("all")
      ) {
        throw new PsycheError("rate_limited", "Too many pairing requests from this network", {
          retryable: true,
        });
      }
      deps.lanPairings.perIp.record(peer.remoteAddress);
      if (prefix !== undefined) deps.lanPairings.perPrefix?.record(prefix);
      deps.lanPairings.total.record("all");
    }
    const request = createPairingRequest(db, {
      kind: "device",
      code: pairingCode(),
      deviceId: params.deviceId,
      display: `${params.name} (${params.platform}, ${params.deviceFamily}; claimed by the device)${
        peer.transport === "vm-relay" ? "; relayed from a sandbox guest" : ""
      }${peer.lan === true ? `; on the local network, dialed ${peer.host ?? "an address"}` : ""}${
        peer.claimedIdentity ? `; proxy says ${peer.claimedIdentity}` : ""
      }`,
      expiresAt: new Date(now.getTime() + deps.limits.pairingTtlMs).toISOString(),
      publicKeyFingerprint: keyFingerprint(params.publicKey),
      // The pairing record only knows the two transports; the card says when it was relayed.
      transport: peer.transport === "ws" ? "ws" : "unix",
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

/** What a separate desktop is told when its token is missing, spent, expired or not its own. */
export const GUEST_TOKEN_REFUSED =
  "this separate desktop's pairing token is missing, was already used, has expired or is not for this desktop";

/**
 * Pairing on a separate desktop's own socket. Fail closed on everything: no owner approval, no
 * handshake secret, no loopback trust and no Host-helper family can pair here. The helper inside
 * presents the container's single-use token as its `handshakeSecret`; the token is spent here,
 * once, and the device is created fresh, named by the Gateway (not by what the guest claims),
 * with scope `node` only, bound to the container by `PairedIdentity.guestContainer`. A device id
 * that already exists is refused: each start brings a new identity, and a spent token cannot
 * be replayed by an old one.
 */
function verifyGuest(
  params: ConnectParams,
  peer: PeerInfo,
  deviceExists: boolean,
  deps: VerifyDeps,
  record: () => void,
): VerifyOutcome {
  const guest = peer.transport === "container-guest" ? peer.guest : undefined;
  if (guest === undefined) return denied("not a separate desktop socket");
  if (params.role !== "node") return denied("a separate desktop pairs as a node only");
  if (deviceExists) {
    record();
    return denied("a separate desktop pairs with a new identity every time it starts");
  }
  if (!guest.redeem(params.handshakeSecret, params.deviceId)) {
    record();
    return denied(GUEST_TOKEN_REFUSED);
  }
  const nowIso = deps.now().toISOString();
  insertDevice(deps.db, {
    id: params.deviceId,
    name: `Separate desktop (${guest.container})`,
    platform: params.platform,
    role: "node",
    publicKey: params.publicKey,
    scopes: ["node"],
    pairedAt: nowIso,
    deviceFamily: "separate-desktop",
  });
  touchLastSeen(deps.db, params.deviceId, nowIso);
  return {
    result: pairedResult(params.deviceId, ["node"], nowIso),
    identity: {
      deviceId: params.deviceId,
      scopes: ["node"],
      role: "node",
      guestContainer: guest.container,
    },
    createdRequest: null,
    pendingDeviceId: null,
  };
}

function pairedResult(deviceId: string, scopes: DeviceScope[], serverTime: string): ConnectResult {
  // stateVersion (and nodeId) are filled in by the connection, which owns the event bus.
  return { phase: "paired", deviceId, scopes, stateVersion: 0, serverTime };
}
