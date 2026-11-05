import { getDevice } from "@psyche/db";
import {
  type ConnectParams,
  type ConnectVerifyParams,
  type DeviceScope,
  type EventName,
  type EventPayload,
  errRes,
  isMethodName,
  methodSpec,
  okRes,
  PsycheError,
  parseFrame,
  type ReqFrame,
  type ResFrame,
  validateParams,
} from "@psyche/protocol";
import {
  issueChallenge,
  type PairedIdentity,
  type PeerInfo,
  type PendingChallenge,
  verifyChallenge,
} from "./auth.ts";
import { serverBuild } from "./build-info.ts";
import type { Call, GatewayContext, HandlerDef, LiveConnection } from "./context.ts";
import type { EventFilter, FrameSink } from "./event-bus.ts";
import { HANDLERS } from "./handlers/index.ts";
import { paramsHash } from "./idempotency.ts";
import { readerOf } from "./message-scrub.ts";
import { methodPresence, requireFreshPresence } from "./presence-gate.ts";

export interface Transport {
  send(frame: string): void;
  close(reason: string): void;
  /** Bytes queued on the socket (WebSockets); absent when the transport cannot tell. */
  bufferedAmount?(): number;
}

/** Reply id used when a malformed request carried no usable id. */
export const UNKNOWN_FRAME_ID = "_unknown";

/**
 * Keystrokes, resizes and output acks of an open Host terminal arrive faster than a per-minute
 * budget allows. They need `operator.admin` and an owned session, and the terminal part meters
 * input bytes per session itself.
 */
/**
 * Methods whose result holds what the owner recorded: the idempotency record keeps only this
 * projection, never the text (a replay inside the retry window still gets the draft's id and name).
 */
export const REPLAY_KEEPS: Record<string, (result: unknown) => unknown> = {
  "skills.drafts.fromRecording": (result) => keepIdentity(result, true),
  // The other draft methods return the draft's text too; for a draft made from a recording that
  // text can hold values the owner kept, so only its identity and status are stored.
  "skills.drafts.update": (result) => keepIdentity(result, false),
  "skills.drafts.accept": (result) => keepIdentity(result, false),
  "skills.drafts.dismiss": (result) => keepIdentity(result, false),
};

/** The result of a draft method without the text, the steps and the proposal's files and diff. */
function keepIdentity(result: unknown, always: boolean): unknown {
  const r = result as {
    draft?: Record<string, unknown>;
    proposal?: Record<string, unknown>;
  } | null;
  const d = r?.draft;
  if (d === undefined || (!always && d.origin !== "recording")) return result;
  const out: Record<string, unknown> = { ...r, draft: { ...d, text: "", steps: [] } };
  const p = r?.proposal;
  if (p !== undefined) {
    const { update: _update, ...rest } = p;
    out.proposal = { ...rest, text: "", files: [] };
  }
  return out;
}

/** Calls that only take access away: allowed on stored scopes while the seal is untrusted. */
const NARROWING_METHODS: ReadonlySet<string> = new Set([
  "devices.revoke",
  "devices.deny",
  "devices.presenceKey.remove",
  "security.state.get",
  "security.recoveries.cancel",
]);

const STREAM_METHODS: ReadonlySet<string> = new Set([
  "terminal.session.write",
  "terminal.session.resize",
  "terminal.session.ack",
]);

/** Default wait for a peer's `res` to a Gateway → peer request. */
const PEER_REQUEST_TIMEOUT_MS = 30_000;

/** Frames a connection may send before it is paired or pending (the handshake is two). */
const MAX_HANDSHAKE_FRAMES = 8;

/**
 * `spent`: the challenge was answered once and the connection did not end up paired or pending
 * (an error, or denied). It accepts neither `connect` nor `connect.verify` again and is closed.
 */
type Phase = "new" | "challenged" | "spent" | "paired" | "pending" | "closed";

interface Outbound {
  resolve(payload: unknown): void;
  reject(err: PsycheError): void;
  timer: NodeJS.Timeout;
}

/** One client or node connection: handshake state machine + method dispatch. */
export class Connection implements LiveConnection {
  readonly id: string;
  readonly peer: PeerInfo;
  #phase: Phase = "new";
  #handshakeFrames = 0;
  #loggedBeforePairing = false;
  #challenge: PendingChallenge | null = null;
  #identity: PairedIdentity | null = null;
  #pendingDeviceId: string | null = null;
  /** The device row's own scopes, before the seal narrowed them (see `#refreshIdentity`). */
  #storedScopes: DeviceScope[] = [];
  #connectParams: ConnectParams | null = null;
  #unsubscribe: (() => void) | null = null;
  #sink: FrameSink | null = null;
  #pendingTimer: NodeJS.Timeout | null = null;
  /** Set by a handshake that ends in `denied`: close once the reply is out. */
  #closeAfterReply: string | null = null;
  #outSeq = 0;
  readonly #outbound = new Map<string, Outbound>();
  readonly #transport: Transport;
  readonly #ctx: GatewayContext;

  constructor(id: string, peer: PeerInfo, transport: Transport, ctx: GatewayContext) {
    this.id = id;
    this.peer = peer;
    this.#transport = transport;
    this.#ctx = ctx;
  }

  get open(): boolean {
    return this.#phase === "paired";
  }

  get phase(): Phase {
    return this.#phase;
  }

  get identity(): PairedIdentity | null {
    return this.#identity;
  }

  get pendingDeviceId(): string | null {
    return this.#pendingDeviceId;
  }

  /** Handles one inbound frame. Resolves once the response (if any) was sent. */
  async handleRaw(raw: string): Promise<void> {
    let id = "";
    let method: string | undefined;
    // Before the handshake finishes a connection gets a handful of frames (connect, connect.verify
    // and a few retries of a malformed one), not an unbounded stream of them to parse and log.
    if (
      this.#phase === "new" ||
      this.#phase === "challenged" ||
      this.#phase === "spent" ||
      this.#phase === "pending"
    ) {
      if (++this.#handshakeFrames > MAX_HANDSHAKE_FRAMES) {
        this.close("too many handshake frames");
        return;
      }
    }
    try {
      const frame = parseFrame(raw);
      if (frame.type === "res") {
        this.#onResponse(frame);
        return;
      }
      if (frame.type !== "req") {
        this.#ctx.log.log("debug", "ignored frame", { conn: this.id, type: frame.type });
        return;
      }
      id = frame.id;
      method = frame.method;
      const payload = await this.#dispatch(frame);
      this.#send(JSON.stringify(okRes(frame.id, payload)));
      if (this.#closeAfterReply !== null) this.close(this.#closeAfterReply);
    } catch (err) {
      const e = PsycheError.from(err);
      // A frame that failed to parse may still have carried an id (parseFrame puts it in details).
      if (id === "") {
        const details = e.details as { id?: unknown } | undefined;
        id =
          typeof details?.id === "string" && details.id.length > 0 ? details.id : UNKNOWN_FRAME_ID;
      }
      // Which call failed and for whom; never its params (they can carry owner data).
      const deviceId = this.#identity?.deviceId ?? this.#pendingDeviceId ?? undefined;
      // A connection that is not paired and keeps calling gets one log line for it, not one per
      // frame (the frame cap ends it soon after).
      const before = e.code === "not_paired" || e.code === "pairing_pending";
      if (before && this.#loggedBeforePairing) {
        this.#send(JSON.stringify(errRes(id, e.toPayload())));
        return;
      }
      if (before) this.#loggedBeforePairing = true;
      this.#ctx.log.log(e.code === "internal" ? "error" : "info", "request failed", {
        conn: this.id,
        ...(method === undefined ? {} : { method: method.slice(0, 128) }),
        ...(deviceId === undefined ? {} : { deviceId }),
        code: e.code,
        ...(e.code === "internal" ? { message: e.message } : {}),
      });
      this.#send(JSON.stringify(errRes(id, e.toPayload())));
      if (
        e.code === "unauthorized" ||
        e.code === "protocol_version_mismatch" ||
        // Any error out of the answer to the challenge (the rate limit included) ends the
        // connection: no second try.
        this.#phase === "spent" ||
        (e.code === "forbidden" && this.#phase === "new")
      ) {
        this.close("handshake failed");
      }
    }
  }

  bufferedAmount(): number {
    return this.#transport.bufferedAmount?.() ?? 0;
  }

  closeAfterReply(reason: string): void {
    this.#closeAfterReply = reason;
  }

  close(reason: string): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer);
    for (const [, out] of this.#outbound) {
      clearTimeout(out.timer);
      out.reject(new PsycheError("unavailable", `connection closed: ${reason}`));
    }
    this.#outbound.clear();
    if (this.#identity?.role === "node") this.#ctx.nodes.detach(this);
    this.#transport.close(reason);
    const deviceId = this.#identity?.deviceId;
    if (deviceId !== undefined) {
      const stillThere = [...this.#ctx.connections()].some(
        (c) => c !== this && c.identity?.deviceId === deviceId && c.open,
      );
      if (!stillThere) {
        for (const listener of this.#ctx.deviceDisconnected) {
          try {
            listener(deviceId);
          } catch (err) {
            this.#ctx.log.log("warn", "disconnect listener failed", {
              code: PsycheError.from(err).code,
            });
          }
        }
      }
    }
  }

  setEventFilter(filter: EventFilter | null): void {
    if (this.#sink) this.#ctx.bus.setFilter(this.#sink, filter);
  }

  /** Gateway → peer request (node protocol). */
  request(method: string, params: unknown, timeoutMs = PEER_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.#phase !== "paired") {
      return Promise.reject(new PsycheError("unavailable", "connection is not paired"));
    }
    const id = `gw-${++this.#outSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#outbound.delete(id);
        reject(new PsycheError("timeout", `${method} timed out`, { retryable: true }));
      }, timeoutMs);
      timer.unref();
      this.#outbound.set(id, { resolve, reject, timer });
      this.#send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  #send(frame: string): void {
    if (this.#phase !== "closed") this.#transport.send(frame);
  }

  #onResponse(frame: ResFrame): void {
    const out = this.#outbound.get(frame.id);
    if (!out) return;
    this.#outbound.delete(frame.id);
    clearTimeout(out.timer);
    if (frame.ok) out.resolve(frame.payload);
    else
      out.reject(
        new PsycheError(frame.error.code, frame.error.message, { details: frame.error.details }),
      );
  }

  async #dispatch(frame: ReqFrame): Promise<unknown> {
    const { method } = frame;
    if (!isMethodName(method)) throw new PsycheError("unknown_method", `Unknown method ${method}`);
    const params = validateParams(method, frame.params ?? {});
    if (method === "connect") return this.#connect(params as ConnectParams);
    if (method === "connect.verify") return this.#verify(params as ConnectVerifyParams);

    const identity = this.#identity;
    if (this.#phase !== "paired" || identity === null) {
      throw new PsycheError(
        this.#phase === "pending" ? "pairing_pending" : "not_paired",
        "Complete connect and connect.verify first",
      );
    }
    // Security state changed outside the Gateway is undone before this call reads any of it.
    this.#ctx.securityState?.ensure();
    this.#refreshIdentity(identity);
    const spec = methodSpec(method);
    const scope = spec.scope as DeviceScope | "none";
    // Untrusted: the calls that only narrow (revoke, deny, cancel) keep the device's stored scopes,
    // so the owner can still lock things down; everything else uses what the seal trusts.
    const have =
      NARROWING_METHODS.has(method) && this.#ctx.securityState?.untrusted() != null
        ? this.#storedScopes
        : identity.scopes;
    if (scope !== "none" && !have.includes(scope)) {
      throw new PsycheError("forbidden", `${method} requires scope ${scope}`);
    }
    this.#rateLimit(identity.deviceId, method, spec.sideEffecting, params);
    const def: HandlerDef | undefined = HANDLERS[method] ?? this.#ctx.extraHandlers[method];
    if (def === undefined) {
      throw new PsycheError("not_implemented", `${method} is not implemented yet`);
    }
    // Admin calls first refresh the sticky presence state, so revoking the owner's last
    // verifier cannot switch the gate off before it was ever observed.
    if (scope === "operator.admin") this.#ctx.presenceState();
    const gate = methodPresence(method, params);
    if (!spec.sideEffecting) {
      if (gate !== undefined)
        await requireFreshPresence({ ctx: this.#ctx, identity }, gate.action, gate.approvalId);
      return this.#execute(def, method, params, identity, null);
    }

    if (!frame.idempotencyKey) {
      throw new PsycheError(
        "invalid_params",
        `${method} is side-effecting and needs an idempotencyKey`,
      );
    }
    const ref = { deviceId: identity.deviceId, method, key: frame.idempotencyKey };
    const hash = paramsHash(frame.params ?? null);
    return this.#ctx.idempotency.run(
      ref,
      hash,
      async () => {
        // Inside the idempotency run: a replayed request returns its stored result without
        // consuming a second approval.
        if (gate !== undefined) {
          await requireFreshPresence({ ctx: this.#ctx, identity }, gate.action, gate.approvalId);
        }
        return this.#execute(def, method, params, identity, { ref, hash });
      },
      def.transactional !== true,
      REPLAY_KEEPS[method],
    );
  }

  /**
   * Per-device budgets (security §10 "rate limits per device token"). Node-protocol frames are
   * exempt: a node streams `node.event`s for invocations the Gateway itself started.
   */
  #rateLimit(deviceId: string, method: string, sideEffecting: boolean, params: unknown): void {
    if (method.startsWith("node.")) return;
    // Only calls that name a session this device owns; a guess at an id is charged like any call.
    if (STREAM_METHODS.has(method)) {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
      if (
        typeof sessionId === "string" &&
        this.#ctx.terminalSessions.owns?.(deviceId, sessionId) === true
      ) {
        return;
      }
    }
    const { deviceRequests, deviceSideEffects } = this.#ctx;
    if (
      !deviceRequests.allowed(deviceId) ||
      (sideEffecting && !deviceSideEffects.allowed(deviceId))
    ) {
      throw new PsycheError("rate_limited", "Too many requests from this device; slow down", {
        retryable: true,
        details: { scope: sideEffecting ? "side_effects" : "requests", windowMs: 60_000 },
      });
    }
    deviceRequests.record(deviceId);
    if (sideEffecting) deviceSideEffects.record(deviceId);
  }

  /**
   * Scopes are read from the device row on every request, so a revocation or a downgrade (for
   * example `psyched devices grant` on the machine) applies to live connections too.
   */
  #refreshIdentity(identity: PairedIdentity): void {
    const device = getDevice(this.#ctx.db, identity.deviceId);
    if (!device || device.revokedAt || !device.pairedAt) {
      // `unauthorized` closes the connection once the error is sent (handleRaw).
      throw new PsycheError("unauthorized", "This device is no longer paired");
    }
    // While the security records are untrusted, a device has only what the seal still trusts.
    const authz = this.#ctx.securityState?.authorizeDevice(device) ?? {
      ok: true as const,
      scopes: device.scopes,
    };
    if (!authz.ok) {
      throw new PsycheError(
        "unauthorized",
        "Psyche's security records are untrusted and this device is not one it knows; pair it again after a re-seal",
      );
    }
    this.#storedScopes = [...device.scopes];
    const same =
      authz.scopes.length === identity.scopes.length &&
      authz.scopes.every((s) => identity.scopes.includes(s));
    if (!same) {
      identity.scopes = [...authz.scopes];
      if (this.#sink) this.#ctx.bus.setScopes(this.#sink, identity.scopes);
    }
  }

  /** Runs a handler; transactional ones commit with their idempotency record, then emit. */
  async #execute(
    def: HandlerDef,
    method: string,
    params: unknown,
    identity: PairedIdentity,
    idem: { ref: { deviceId: string; method: string; key: string }; hash: string } | null,
  ): Promise<unknown> {
    const ctx = this.#ctx;
    const events: Array<() => void> = [];
    const after: Array<() => void> = [];
    let inTx = false;
    const call: Call = {
      ctx,
      conn: this,
      identity,
      method,
      emit: <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => {
        const publish = () => ctx.bus.publish(event, payload, threadId);
        if (inTx) events.push(publish);
        else publish();
      },
      afterCommit: (fn) => {
        if (inTx) after.push(fn);
        else fn();
      },
    };
    if (!def.transactional) {
      const out = await def.run(call, params as never);
      this.#healAnswers(method);
      return out;
    }

    const result = ctx.db.sqlite.transaction(() => {
      inTx = true;
      try {
        const out = def.run(call, params as never);
        if (out instanceof Promise) throw new PsycheError("internal", `${method} handler is async`);
        if (idem) ctx.idempotency.store(idem.ref, idem.hash, out);
        return out;
      } finally {
        inTx = false;
      }
    })();
    for (const publish of events) publish();
    for (const fn of after) fn();
    this.#healAnswers(method);
    return result;
  }

  /** A memory call that removes something: the answers kept in chats lose the words it supported. */
  #healAnswers(method: string): void {
    if (!/^memory\..*(forget|retract|delete|decide|reject)/i.test(method)) return;
    try {
      this.#ctx.messageScrub.heal?.();
    } catch {
      // A failed sweep never fails the call; the next read still narrows the answer per reader.
    }
  }

  #connect(params: ConnectParams): unknown {
    if (this.#phase !== "new") {
      throw new PsycheError("conflict", "connect was already sent on this connection");
    }
    const { pending, challenge } = issueChallenge(
      params,
      this.peer,
      this.#ctx.challengeOrigin(this.peer),
      this.#ctx.now().getTime(),
      this.#ctx.identity,
      this.peer.lan === true ? this.#ctx.lan.certSpki() : null,
      // Only to the Host's own app: a remote client, a browser page or a LAN peer is not told
      // which build runs here (it would only help someone choose an exploit).
      this.peer.remoteLoopback && this.peer.origin === null && this.peer.lan !== true
        ? serverBuild()
        : undefined,
    );
    this.#challenge = pending;
    this.#connectParams = params;
    this.#phase = "challenged";
    this.#ctx.log.log("info", "challenge issued", {
      conn: this.id,
      role: params.role,
      family: params.deviceFamily,
      transport: this.peer.transport,
    });
    return challenge;
  }

  #verify(params: ConnectVerifyParams): unknown {
    const pending = this.#challenge;
    if (this.#phase !== "challenged" || pending === null) {
      throw new PsycheError("conflict", "connect.verify needs a pending challenge");
    }
    const ctx = this.#ctx;
    // The challenge is single-use: it is spent before any work is done on the answer, so a
    // second `connect.verify` on this connection (pipelined, or after a refusal) finds none and
    // costs nothing. A refused handshake closes the connection (see `handleRaw`).
    this.#challenge = null;
    this.#phase = "spent";
    // The device row decides this connect: undo any change made to it outside the Gateway first.
    ctx.securityState?.ensure();
    const outcome = verifyChallenge(pending, params, this.peer, {
      db: ctx.db,
      handshakeSecret: ctx.handshakeSecret,
      serverOrigin: ctx.challengeOrigin(this.peer),
      gatewayKey: ctx.identity.publicKey,
      now: ctx.now,
      limits: ctx.limits,
      failedChallenges: ctx.failedChallenges,
      failedChallengesPrefix: ctx.failedChallengesPrefix,
      lanPairings: ctx.lanPairings,
    });
    const { result, identity } = outcome;
    ctx.log.log("info", "handshake finished", { conn: this.id, phase: result.phase });
    if (outcome.createdRequest) {
      ctx.bus.publish("pairing.requested", { pairingRequest: outcome.createdRequest });
    }
    if (outcome.pairedBySetupToken) {
      // A computer paired itself with a setup token the owner made: tell the Host's screens (the
      // device list) and the audit trail, since no approval card was involved.
      const { deviceId } = outcome.pairedBySetupToken;
      const device = getDevice(ctx.db, deviceId);
      ctx.bus.bumpStateVersion();
      if (device) ctx.bus.publish("device.updated", { device });
      ctx.onSetupTokenUsed?.(outcome.pairedBySetupToken);
    }
    if (result.phase === "paired" && identity) {
      this.#phase = "paired";
      this.#identity = identity;
      const sink: FrameSink = (frame) => this.#send(frame);
      this.#sink = sink;
      this.#unsubscribe = ctx.bus.subscribe(
        identity.scopes,
        sink,
        identity.deviceId,
        readerOf(identity),
      );
      let nodeId: string | undefined;
      if (identity.role === "node" && this.#connectParams) {
        nodeId = ctx.nodes.attach(this, identity, this.#connectParams).id;
      }
      return { ...result, stateVersion: ctx.bus.stateVersion, ...(nodeId ? { nodeId } : {}) };
    }
    if (result.phase === "pending") {
      this.#phase = "pending";
      this.#pendingDeviceId = outcome.pendingDeviceId;
      // One live connection per pending request: a newer one for the same device replaces the
      // older, so repeating connect with one device id and key cannot pile up pending sockets.
      for (const other of [...ctx.connections()]) {
        if (
          other !== this &&
          other.identity === null &&
          outcome.pendingDeviceId !== null &&
          other.pendingDeviceId === outcome.pendingDeviceId
        ) {
          other.close("replaced by a newer connection for the same pairing request");
        }
      }
      // A pending connection is closed once its pairing request has expired.
      this.#pendingTimer = setTimeout(
        () => this.close("pairing request expired"),
        ctx.limits.pairingTtlMs,
      );
      this.#pendingTimer.unref();
      return result;
    }
    // denied: answer, then close.
    this.#closeAfterReply = "denied";
    return result;
  }
}
