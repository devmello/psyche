import {
  type ConnectChallenge,
  type ConnectResult,
  connectSigningPayload,
  type DevicePlatform,
  type NodeCapability,
  type NodeInvokeParams,
  type NodeResultParams,
  PROTOCOL_VERSION,
  PsycheError,
  validateParams,
} from "@psyche/protocol";
import { Backoff } from "./backoff.ts";
import type {
  CapabilityEntry,
  CapabilityOutcome,
  CapabilityProvider,
} from "./capabilities/types.ts";
import { SkewClock } from "./clock.ts";
import type { NodeIdentity } from "./identity.ts";
import { createInvocationContext } from "./invocation.ts";
import { type Logger, silentLogger } from "./log.ts";
import { FramePeer } from "./peer.ts";
import type { ChannelFactory } from "./transports/channel.ts";

export type AgentState = "idle" | "connecting" | "pending" | "paired" | "denied" | "stopped";

export interface NodeAgentOptions {
  identity: NodeIdentity;
  /** Shown on the owner's pairing card. */
  name: string;
  platform: DevicePlatform;
  /** `vm-guest` inside the macOS guest (the Gateway records kind `vm-guest`), else `psyche-node`. */
  deviceFamily: string;
  version: string;
  providers: CapabilityProvider[];
  connect: ChannelFactory;
  /** Per-launch secret of a Gateway on this machine; only the mac helper may auto-pair with it. */
  handshakeSecret?: string;
  log?: Logger;
  clock?: SkewClock;
  backoff?: Backoff;
  /** A connection that stayed paired this long resets the backoff. */
  stableAfterMs?: number;
  /** Delay before reconnecting after a pending connection closed (approval or expiry). */
  pendingRetryMs?: number;
  /** Delay after a non-fatal `denied`. */
  deniedRetryMs?: number;
  /** Most invocations running at once; more are refused with retryable `rate_limited`. */
  maxConcurrent?: number;
  /** Wait for in-flight invocations before re-declaring changed capabilities, at most this long. */
  redeclareMaxWaitMs?: number;
}

/** `denied` reasons that no retry can fix: stop and tell the operator. */
const FATAL_DENIALS = new Set(["device revoked", "device key mismatch", "device role mismatch"]);

interface Running {
  controller: AbortController;
}

/**
 * The node agent (architecture §7): pairs with a Gateway as role `node`, declares the
 * capabilities its providers detect, serves `node.invoke` with streamed `node.event`s and exactly
 * one `node.result`, and reconnects with backoff. Capability changes (a helper starting) are
 * re-declared by reconnecting, the only re-declaration the v1 protocol has.
 */
export class NodeAgent {
  readonly clock: SkewClock;
  readonly #opts: NodeAgentOptions;
  readonly #log: Logger;
  readonly #backoff: Backoff;
  readonly #running = new Map<string, Running>();
  #entries = new Map<string, CapabilityEntry>();
  #state: AgentState = "idle";
  #stateListeners: ((state: AgentState, detail?: Record<string, unknown>) => void)[] = [];
  #peer: FramePeer | null = null;
  #stopped = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #redeclareTimer: NodeJS.Timeout | null = null;
  #nodeId: string | null = null;
  #pairingCode: string | null = null;

  constructor(options: NodeAgentOptions) {
    this.#opts = options;
    this.#log = options.log ?? silentLogger;
    this.clock = options.clock ?? new SkewClock();
    this.#backoff = options.backoff ?? new Backoff();
    for (const p of options.providers) p.onChange?.(() => this.#scheduleRedeclare());
  }

  get state(): AgentState {
    return this.#state;
  }

  get nodeId(): string | null {
    return this.#nodeId;
  }

  /** The code the owner approves (`psyched devices approve <code>`), while pending. */
  get pairingCode(): string | null {
    return this.#pairingCode;
  }

  get inFlight(): number {
    return this.#running.size;
  }

  onState(listener: (state: AgentState, detail?: Record<string, unknown>) => void): void {
    this.#stateListeners.push(listener);
  }

  /** Current manifest, as declared on the last connect. */
  manifest(): NodeCapability[] {
    return [...this.#entries.values()].map((e) => e.manifest);
  }

  start(): Promise<void> {
    this.#loop ??= this.#run();
    return this.#loop;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#redeclareTimer) clearTimeout(this.#redeclareTimer);
    this.#abortAll("node stopping");
    this.#peer?.close("node stopping");
    this.#wake?.();
    await this.#loop;
    await Promise.all(this.#opts.providers.map((p) => p.dispose?.().catch(() => {})));
    this.#setState("stopped");
  }

  #setState(state: AgentState, detail?: Record<string, unknown>): void {
    this.#state = state;
    for (const l of this.#stateListeners) l(state, detail);
  }

  /** Sleeps, but `stop()` or a re-declaration wakes it early. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
  }

  async #collect(): Promise<void> {
    const entries = new Map<string, CapabilityEntry>();
    for (const provider of this.#opts.providers) {
      let list: CapabilityEntry[];
      try {
        list = await provider.entries();
      } catch (err) {
        this.#log.log("warn", "provider detection failed", {
          provider: provider.id,
          error: PsycheError.from(err).message,
        });
        continue;
      }
      for (const entry of list) {
        if (entries.has(entry.manifest.name)) {
          this.#log.log("warn", "duplicate capability ignored", {
            provider: provider.id,
            capability: entry.manifest.name,
          });
          continue;
        }
        entries.set(entry.manifest.name, entry);
      }
    }
    this.#entries = entries;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      await this.#collect();
      if (this.#stopped) break;
      this.#setState("connecting");
      let peer: FramePeer;
      try {
        peer = new FramePeer(await this.#opts.connect());
      } catch (err) {
        const delay = this.#backoff.next();
        this.#log.log("warn", "gateway unreachable", {
          error: PsycheError.from(err).message,
          retryInMs: delay,
        });
        await this.#sleep(delay);
        continue;
      }
      this.#peer = peer;
      const closed = new Promise<string>((resolve) => peer.channel.onClose(resolve));
      let next: number;
      try {
        next = await this.#session(peer, closed);
      } catch (err) {
        const e = PsycheError.from(err);
        peer.close(e.message);
        if (e.code === "protocol_version_mismatch") {
          this.#log.log("error", "gateway speaks another protocol version", { error: e.message });
          this.#setState("denied", { reason: e.message });
          this.#stopped = true;
          break;
        }
        next = this.#backoff.next();
        this.#log.log("warn", "connection failed", { error: e.message, retryInMs: next });
      } finally {
        this.#peer = null;
        this.#abortAll("gateway connection closed");
      }
      if (next < 0) {
        this.#stopped = true;
        break;
      }
      if (!this.#stopped && next > 0) await this.#sleep(next);
    }
  }

  /**
   * One connection: handshake, then serve until it closes. Resolves the delay before the next
   * attempt (`-1`: stop for good).
   */
  async #session(peer: FramePeer, closed: Promise<string>): Promise<number> {
    const { identity, platform, deviceFamily } = this.#opts;
    const capabilities = this.manifest();
    const challenge = (await peer.request("connect", {
      protocolVersion: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      role: "node",
      platform,
      deviceFamily,
      name: this.#opts.name,
      capabilities,
      ...(this.#opts.handshakeSecret ? { handshakeSecret: this.#opts.handshakeSecret } : {}),
    })) as ConnectChallenge;
    const signature = identity.sign(
      connectSigningPayload({
        nonce: challenge.nonce,
        platform,
        deviceFamily,
        protocolVersion: challenge.protocolVersion,
        serverOrigin: challenge.serverOrigin,
      }),
    );
    const sentAt = Date.now();
    const result = (await peer.request("connect.verify", {
      nonce: challenge.nonce,
      signature,
    })) as ConnectResult;

    if (result.phase === "denied") {
      this.#log.log("error", "pairing denied", { reason: result.reason });
      this.#setState("denied", { reason: result.reason });
      if (FATAL_DENIALS.has(result.reason)) return -1;
      return this.#opts.deniedRetryMs ?? 300_000;
    }

    if (result.phase === "pending") {
      this.#pairingCode = result.code;
      this.#log.log("info", "waiting for the owner to approve this node", {
        code: result.code,
        hint: `psyched devices approve ${result.code}`,
      });
      this.#setState("pending", { code: result.code });
      // The Gateway closes a pending connection once the owner decides or the request expires;
      // the next connect then pairs (or stays pending with the same code).
      await closed;
      return this.#opts.pendingRetryMs ?? 1_000;
    }

    this.#pairingCode = null;
    this.clock.observe(result.serverTime, sentAt);
    this.#nodeId = result.nodeId ?? null;
    if (!result.scopes.includes("node")) {
      this.#log.log("error", "paired without the node scope; ask the owner to grant it", {
        scopes: result.scopes,
      });
    }
    peer.setHandler((method, params) => this.#handle(peer, method, params));
    const pairedAt = Date.now();
    this.#log.log("info", "paired", {
      nodeId: this.#nodeId,
      transport: peer.channel.describe,
      capabilities: capabilities.length,
      clockOffsetMs: this.clock.offsetMs,
    });
    this.#setState("paired", { nodeId: this.#nodeId });
    const reason = await closed;
    const stable = Date.now() - pairedAt >= (this.#opts.stableAfterMs ?? 10_000);
    if (stable) this.#backoff.reset();
    if (reason === REDECLARE) {
      this.#backoff.reset();
      return 0;
    }
    const delay = this.#backoff.next();
    this.#log.log("warn", "gateway connection closed", { reason, retryInMs: delay });
    return delay;
  }

  #handle(peer: FramePeer, method: string, params: unknown): unknown {
    if (method === "node.cancel") {
      // Not in protocol v1 yet (S14 requested it); honoured like the mac helper does.
      const id = (params as { invocationId?: unknown } | null)?.invocationId;
      if (typeof id !== "string") throw new PsycheError("invalid_params", "invocationId required");
      this.#running.get(id)?.controller.abort(new PsycheError("cancelled", "cancelled"));
      return { ok: true };
    }
    if (method !== "node.invoke") {
      throw new PsycheError("unknown_method", `unknown method ${method}`);
    }
    const invoke = validateParams("node.invoke", params) as NodeInvokeParams;
    const entry = this.#entries.get(invoke.capability);
    if (!entry) throw new PsycheError("not_found", `unknown capability ${invoke.capability}`);
    if (this.#running.has(invoke.invocationId)) {
      throw new PsycheError("conflict", "invocation already running");
    }
    if (this.#running.size >= (this.#opts.maxConcurrent ?? 16)) {
      throw new PsycheError("rate_limited", "too many invocations in flight", { retryable: true });
    }
    const controller = new AbortController();
    this.#running.set(invoke.invocationId, { controller });
    void this.#execute(peer, entry, invoke, controller);
    return { accepted: true };
  }

  async #execute(
    peer: FramePeer,
    entry: CapabilityEntry,
    invoke: NodeInvokeParams,
    controller: AbortController,
  ): Promise<void> {
    const { invocationId } = invoke;
    let done = false;
    // Events go out in order on the same channel; the Gateway's acks are not awaited.
    const emit = (data: unknown) => {
      if (done || peer.closed) return;
      peer.request("node.event", { invocationId, data }).catch((err) => {
        this.#log.log("debug", "node.event not acknowledged", {
          invocationId,
          error: PsycheError.from(err).message,
        });
      });
    };
    const ctx = createInvocationContext({
      invocationId,
      capability: invoke.capability,
      approvalId: invoke.approvalId,
      signal: controller.signal,
      clock: this.clock,
      emit,
    });
    const started = Date.now();
    let outcome: CapabilityOutcome;
    try {
      outcome = await entry.handler(invoke.params, ctx);
    } catch (err) {
      outcome = { ok: false, error: PsycheError.from(err).toPayload() };
    }
    if (controller.signal.aborted && outcome.ok) {
      // The work finished but the caller already gave up; report what happened anyway.
      this.#log.log("debug", "invocation finished after abort", { invocationId });
    }
    done = true;
    this.#running.delete(invocationId);
    this.#log.log("info", "invocation finished", {
      invocationId,
      capability: invoke.capability,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { code: outcome.error.code }),
      ms: Date.now() - started,
    });
    if (peer.closed) return;
    let result: NodeResultParams = { invocationId, ok: outcome.ok };
    if (outcome.ok && outcome.result !== undefined) result.result = outcome.result;
    if (!outcome.ok) result.error = outcome.error;
    if (outcome.receipt) result.receipt = outcome.receipt;
    try {
      validateParams("node.result", result);
    } catch (err) {
      this.#log.log("error", "handler produced an invalid result", {
        capability: invoke.capability,
        error: PsycheError.from(err).message,
      });
      result = {
        invocationId,
        ok: false,
        error: { code: "internal", message: "capability produced an invalid result" },
        ...(outcome.receipt ? { receipt: { ...outcome.receipt, outcome: "uncertain" } } : {}),
      };
      try {
        validateParams("node.result", result);
      } catch {
        delete result.receipt;
      }
    }
    await peer.request("node.result", result).catch((err) => {
      this.#log.log("warn", "node.result not acknowledged", {
        invocationId,
        error: PsycheError.from(err).message,
      });
    });
  }

  #abortAll(reason: string): void {
    for (const [, run] of this.#running) {
      run.controller.abort(new PsycheError("cancelled", reason));
    }
  }

  /**
   * Debounced re-declaration: once in-flight work drains (or after `redeclareMaxWaitMs`),
   * reconnect so the Gateway records the new manifest. Pending or unpaired: wake the loop.
   */
  #scheduleRedeclare(): void {
    if (this.#stopped || this.#redeclareTimer) return;
    const deadline = Date.now() + (this.#opts.redeclareMaxWaitMs ?? 30_000);
    const tick = () => {
      this.#redeclareTimer = null;
      if (this.#stopped) return;
      if (this.#state !== "paired") {
        this.#wake?.();
        return;
      }
      if (this.#running.size > 0 && Date.now() < deadline) {
        this.#redeclareTimer = setTimeout(tick, 250);
        this.#redeclareTimer.unref();
        return;
      }
      this.#log.log("info", "capabilities changed; re-declaring");
      this.#peer?.close(REDECLARE);
    };
    this.#redeclareTimer = setTimeout(tick, 500);
    this.#redeclareTimer.unref();
  }
}

const REDECLARE = "capabilities changed";
