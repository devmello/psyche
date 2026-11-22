import { Type } from "@sinclair/typebox";
import { DeviceScope, Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { DevicePlatform } from "../schemas/identity.ts";
import { defineMethod } from "./define.ts";

/** `gateway.*`: facts about the Gateway a client is connected to (remote-gateway design §3.1, §3.3). */

export const GatewayInfo = Type.Object(
  {
    identity: Type.Object({
      publicKey: Type.String({ description: "base64url raw Ed25519 identity public key" }),
      fingerprint: Type.String({ description: "sha256:<hex> of the raw key, as clients show it" }),
    }),
    hostName: Type.String({ description: "The Host machine's name" }),
    hostOs: Type.Optional(
      StringEnum(["macos", "windows", "linux"], {
        description:
          "The Host's operating system, so a Client names it and its features in the Host's words (a Linux Host has no Apple connectors and offers computer use only on its private screen). Absent from older Gateways",
      }),
    ),
    publicOrigin: Type.Union([Type.String(), Type.Null()], {
      description: "gateway.publicOrigin, the https address other computers reach it at",
    }),
    trustedProxy: Type.Boolean({ description: "gateway.trustedProxy is on" }),
    configWarnings: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), {
        maxItems: 50,
        description:
          "Keys in config.json that this version does not know: kept and ignored. Admins only; the Settings screen shows them so a misspelt setting is noticed",
      }),
    ),
    lan: Type.Optional(
      Type.Object({
        enabled: Type.Boolean({ description: "The `gateway.lan` setting is on" }),
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        interfaces: Type.Array(Type.String(), {
          description: "The interface names or addresses the owner chose; empty = the default one",
        }),
        ipv6: Type.Optional(
          Type.Boolean({
            description:
              "Also listen on the chosen interface's IPv6 unique-local (fc00::/7) addresses. Never global or link-local ones",
          }),
        ),
        listening: Type.Array(Type.Object({ address: Type.String(), port: Type.Integer() }), {
          description: "What is bound right now; empty when off or when nothing could bind",
        }),
        candidates: Type.Array(
          Type.Object({ name: Type.String(), address: Type.String(), isDefault: Type.Boolean() }),
          {
            description:
              "Interfaces the owner can pick: private IPv4 and IPv6 unique-local addresses only",
          },
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
    claim: Type.Optional(
      Type.Object(
        {
          lanChoicePending: Type.Boolean({
            description:
              "The server was claimed from the app and the owner has not yet said whether it stays reachable on this network (`gateway.claim.finish`). Until then LAN listening stays on the interface the claim came in on",
          }),
        },
        {
          description:
            "Present only on a server set up with a setup code whose onboarding has not finished (remote-gateway design §3.6)",
        },
      ),
    ),
  },
  { $id: "GatewayInfo" },
);

/** base64url of 32 bytes (a nonce, an HMAC-SHA256, a raw Ed25519 key, an SPKI hash). */
const B64_32 = (description: string) =>
  Type.String({ pattern: "^[A-Za-z0-9_-]{43}$", description });

/** `gateway.claim.hello`: the first frame of a claim, on the LAN listener of an unclaimed server. */
export const ClaimHelloParams = Type.Object(
  {
    clientNonce: B64_32("base64url, 32 random bytes from the client"),
    deviceId: Id,
    publicKey: B64_32(
      "The claiming device's raw Ed25519 public key: the key that becomes the first admin",
    ),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    platform: DevicePlatform,
  },
  { $id: "ClaimHelloParams" },
);

export const ClaimHelloResult = Type.Object(
  {
    serverNonce: B64_32("base64url, 32 random bytes, fresh for this connection"),
    salt: Type.String({
      pattern: "^[A-Za-z0-9_-]{22}$",
      description: "base64url, the 16-byte salt stored with the setup code",
    }),
    gatewayKey: B64_32("The server's identity public key. Not trusted until its proof checks"),
    certSpki: B64_32(
      "SHA-256 of the SPKI of the LAN certificate the server serves; the client checks it is the one this connection presented",
    ),
    hostName: Type.String({ minLength: 1, maxLength: 64 }),
    expiresAt: IsoDateTime,
  },
  { $id: "ClaimHelloResult" },
);

export const ClaimProveParams = Type.Object(
  {
    proof: B64_32(
      "claimProof(scrypt(code, salt), client, claimTranscript(...)): HMAC-SHA256, base64url",
    ),
  },
  { $id: "ClaimProveParams" },
);

export const ClaimProveResult = Type.Object(
  {
    proof: B64_32("The server's proof over the same transcript, role server"),
    deviceId: Id,
    scopes: Type.Array(DeviceScope),
  },
  { $id: "ClaimProveResult" },
);

/**
 * What an update would interrupt (`gateway.prepareUpdate`, updates design §2.6). Counts are
 * exact; the lists name at most 20 items each so the UI can say what it is waiting for.
 */
export const UpdateBusy = Type.Object(
  {
    runningTasks: Type.Integer({ minimum: 0, description: "Tasks with a turn running right now" }),
    activeChats: Type.Integer({
      minimum: 0,
      description: "Chat (and automation) turns running right now",
    }),
    pendingApprovals: Type.Integer({
      minimum: 0,
      description:
        "Approvals waiting for the owner; the runs parked on them resume after a restart",
    }),
    recordings: Type.Integer({
      minimum: 0,
      description: "Recordings in progress that the Gateway knows of (a Mac app being recorded)",
    }),
    tasks: Type.Array(Type.Object({ id: Id, title: Type.String({ maxLength: 200 }) }), {
      maxItems: 20,
    }),
    chats: Type.Array(Type.Object({ threadId: Id, runId: Id }), { maxItems: 20 }),
  },
  { $id: "UpdateBusy" },
);

export const UpdateGateState = StringEnum(["open", "draining", "ready"], {
  $id: "UpdateGateState",
});

export const PrepareUpdateResult = Type.Object(
  {
    state: UpdateGateState,
    ready: Type.Boolean({
      description:
        "True when the Gateway has stopped taking new work and the wait is over: it can be stopped now",
    }),
    deadline: Nullable(IsoDateTime),
    busy: UpdateBusy,
    checkpointed: Type.Object(
      {
        tasks: Type.Integer({ minimum: 0 }),
        chats: Type.Integer({ minimum: 0 }),
      },
      {
        description:
          "Turns still running when the wait ended. Not stopped here: a task's steps are checkpointed as they run and the task resumes after the restart; a chat turn is cancelled by the shutdown and recovered at the next start",
      },
    ),
  },
  { $id: "PrepareUpdateResult" },
);

export const GatewayMethods = {
  "gateway.info": defineMethod({
    params: Type.Object({}),
    result: GatewayInfo,
    scope: "operator.read",
    description:
      "The Gateway's identity key and fingerprint, the Host's name and whether it is set up to be reached from other computers (publicOrigin, trusted proxy). The Host's Settings shows the fingerprint next to a pairing request so the owner can compare it with the one the new computer shows.",
  }),
  "gateway.prepareUpdate": defineMethod({
    params: Type.Object({
      mode: Type.Optional(
        StringEnum(["prepare", "check", "cancel"], {
          description:
            "`prepare` (default) stops new work and waits; `check` only reports what is busy; `cancel` resumes normal service now",
        }),
      ),
      waitMs: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 120_000,
          description:
            "How long `prepare` waits for running turns and tasks to finish (default 30000). Then it answers ready anyway, naming what it left running",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 5_000,
          maximum: 600_000,
          description:
            "How long the Gateway stays closed to new work if no update follows (default 120000). It then resumes by itself",
        }),
      ),
    }),
    result: PrepareUpdateResult,
    scope: "operator.admin",
    description:
      "Desktop shell on the Host only (loopback, no Origin, the per-launch handshake secret): the same gate as `devices.setupToken.create`, so a paired remote device is refused. Stops the Gateway taking new chat turns and tasks (they answer `unavailable` with details.reason `updating`; messages to a busy chat still queue), waits up to waitMs for running turns and tasks, flushes the database and returns `ready`, together with a report of what is busy (running tasks, active chats, pending approvals, recordings). If no update follows within timeoutMs, service resumes by itself. Not side-effecting: calling it again is safe and moves the deadline.",
  }),
  "gateway.claim.hello": defineMethod({
    params: ClaimHelloParams,
    result: ClaimHelloResult,
    scope: "none",
    description:
      "Unclaimed psyche-server only, on its LAN listener, as the first frame of a connection (remote-gateway design §3.6). Returns the nonce, the code's salt, the identity key and the certificate pin the client proves its knowledge of the code over. forbidden with details.reason not_claimable or code_expired otherwise. Nothing is trusted yet on either side.",
  }),
  "gateway.claim.prove": defineMethod({
    params: ClaimProveParams,
    result: ClaimProveResult,
    scope: "none",
    description:
      "The client's proof that it knows the setup code. Right: the device from gateway.claim.hello becomes the first admin (operator.read, operator.write, operator.approvals, operator.admin), the code is spent, claim mode ends, and the server answers with its own proof, which the client checks before it pins anything. Wrong: forbidden with details.reason wrong_code and details.attemptsLeft; rate_limited with details.reason too_many_attempts past the per-address limit. The connection closes after either answer.",
  }),
  "gateway.claim.finish": defineMethod({
    params: Type.Object({
      keepLan: Type.Boolean({
        description:
          "Keep the server reachable on this network (gateway.lan stays on the claim's interface); false turns LAN listening off once the answer is sent",
      }),
    }),
    result: Type.Object({ lan: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "The last step of onboarding a claimed server: the owner's answer to Keep this server reachable on my network. conflict when no such answer is waiting. Side-effecting: false turns the network listener off.",
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
