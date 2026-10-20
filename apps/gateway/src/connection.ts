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
import type { Call, GatewayContext, HandlerDef, LiveConnection } from "./context.ts";
import type { EventFilter, FrameSink } from "./event-bus.ts";
import { HANDLERS } from "./handlers/index.ts";
import { paramsHash } from "./idempotency.ts";

export interface Transport {
  send(frame: string): void;
  close(reason: string): void;
}

/** Reply id used when a malformed request carried no usable id. */
export const UNKNOWN_FRAME_ID = "_unknown";

/** Default wait for a peer's `res` to a Gateway → peer request. */
const PEER_REQUEST_TIMEOUT_MS = 30_000;

type Phase = "new" | "challenged" | "paired" | "pending" | "closed";

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
  #challenge: PendingChallenge | null = null;
  #identity: PairedIdentity | null = null;
  #pendingDeviceId: string | null = null;
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
      this.#ctx.log.log(e.code === "internal" ? "error" : "info", "request failed", {
        conn: this.id,
        code: e.code,
        ...(e.code === "internal" ? { message: e.message } : {}),
      });
      this.#send(JSON.stringify(errRes(id, e.toPayload())));
      if (
        e.code === "unauthorized" ||
        e.code === "protocol_version_mismatch" ||
        (e.code === "forbidden" && this.#phase === "new")
      ) {
        this.close("handshake failed");
      }
    }
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
    this.#refreshIdentity(identity);
    const spec = methodSpec(method);
    const scope = spec.scope as DeviceScope | "none";
    if (scope !== "none" && !identity.scopes.includes(scope)) {
      throw new PsycheError("forbidden", `${method} requires scope ${scope}`);
    }
    this.#rateLimit(identity.deviceId, method, spec.sideEffecting);
    const def: HandlerDef | undefined = HANDLERS[method] ?? this.#ctx.extraHandlers[method];
    if (def === undefined) {
      throw new PsycheError("not_implemented", `${method} is not implemented yet`);
    }
    if (!spec.sideEffecting) return this.#execute(def, method, params, identity, null);

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
      () => this.#execute(def, method, params, identity, { ref, hash }),
      def.transactional !== true,
    );
  }

  /**
   * Per-device budgets (security §10 "rate limits per device token"). Node-protocol frames are
   * exempt: a node streams `node.event`s for invocations the Gateway itself started.
   */
  #rateLimit(deviceId: string, method: string, sideEffecting: boolean): void {
    if (method.startsWith("node.")) return;
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
    const same =
      device.scopes.length === identity.scopes.length &&
      device.scopes.every((s) => identity.scopes.includes(s));
    if (!same) {
      identity.scopes = [...device.scopes];
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
    if (!def.transactional) return await def.run(call, params as never);

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
    return result;
  }

  #connect(params: ConnectParams): unknown {
    if (this.#phase !== "new") {
      throw new PsycheError("conflict", "connect was already sent on this connection");
    }
    const { pending, challenge } = issueChallenge(
      params,
      this.peer,
      this.#ctx.serverOrigin(),
      this.#ctx.now().getTime(),
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
    const outcome = verifyChallenge(pending, params, this.peer, {
      db: ctx.db,
      handshakeSecret: ctx.handshakeSecret,
      serverOrigin: ctx.serverOrigin(),
      now: ctx.now,
      limits: ctx.limits,
      failedChallenges: ctx.failedChallenges,
    });
    this.#challenge = null;
    const { result, identity } = outcome;
    ctx.log.log("info", "handshake finished", { conn: this.id, phase: result.phase });
    if (outcome.createdRequest) {
      ctx.bus.publish("pairing.requested", { pairingRequest: outcome.createdRequest });
    }
    if (result.phase === "paired" && identity) {
      this.#phase = "paired";
      this.#identity = identity;
      const sink: FrameSink = (frame) => this.#send(frame);
      this.#sink = sink;
      this.#unsubscribe = ctx.bus.subscribe(identity.scopes, sink);
      let nodeId: string | undefined;
      if (identity.role === "node" && this.#connectParams) {
        nodeId = ctx.nodes.attach(this, identity, this.#connectParams).id;
      }
      return { ...result, stateVersion: ctx.bus.stateVersion, ...(nodeId ? { nodeId } : {}) };
    }
    if (result.phase === "pending") {
      this.#phase = "pending";
      this.#pendingDeviceId = outcome.pendingDeviceId;
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
