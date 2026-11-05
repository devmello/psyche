import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
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
  },
  { $id: "GatewayInfo" },
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
