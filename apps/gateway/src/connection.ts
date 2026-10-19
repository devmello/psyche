import { createHash } from "node:crypto";
import {
  type ConnectParams,
  type ConnectVerifyParams,
  type DeviceScope,
  errRes,
  isAdminSettingKey,
  isMethodName,
  methodSpec,
  okRes,
  PsycheError,
  parseFrame,
  type ReqFrame,
  validateParams,
} from "@psyche/protocol";
import {
  issueChallenge,
  type PairedIdentity,
  type PeerInfo,
  type PendingChallenge,
  verifyChallenge,
} from "./auth.ts";
import type { EventBus } from "./event-bus.ts";
import type { Logger } from "./log.ts";
import { type GatewayStore, INTERNAL_SETTING_PREFIX } from "./store.ts";

export interface ConnectionDeps {
  store: GatewayStore;
  bus: EventBus;
  log: Logger;
  handshakeSecret: string;
  serverOrigin: () => string;
  now: () => Date;
  idempotency: IdempotencyCache;
}

export interface Transport {
  send(frame: string): void;
  close(reason: string): void;
}

/** Stored results of side-effecting requests, keyed by device + method + idempotency key (feature A2). */
export class IdempotencyCache {
  readonly #entries = new Map<string, { paramsHash: string; payload: unknown }>();
  readonly #max: number;

  constructor(max = 10_000) {
    this.#max = max;
  }

  get(key: string): { paramsHash: string; payload: unknown } | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: { paramsHash: string; payload: unknown }): void {
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, value);
  }
}

/** Reply id used when a malformed request carried no usable id. */
export const UNKNOWN_FRAME_ID = "_unknown";

type Phase = "new" | "challenged" | "paired" | "pending" | "closed";

/** One client or node connection: handshake state machine + method dispatch. */
export class Connection {
  readonly id: string;
  #phase: Phase = "new";
  #challenge: PendingChallenge | null = null;
  #identity: PairedIdentity | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #peer: PeerInfo;
  readonly #transport: Transport;
  readonly #deps: ConnectionDeps;

  constructor(id: string, peer: PeerInfo, transport: Transport, deps: ConnectionDeps) {
    this.id = id;
    this.#peer = peer;
    this.#transport = transport;
    this.#deps = deps;
  }

  get phase(): Phase {
    return this.#phase;
  }

  get identity(): PairedIdentity | null {
    return this.#identity;
  }

  handleRaw(raw: string): void {
    let id = "";
    try {
      const frame = parseFrame(raw);
      if (frame.type !== "req") {
        // Responses from nodes to node.invoke are routed by S01's node registry.
        this.#deps.log.log("debug", "ignored non-request frame", {
          conn: this.id,
          type: frame.type,
        });
        return;
      }
      id = frame.id;
      const payload = this.#dispatch(frame);
      this.#transport.send(JSON.stringify(okRes(frame.id, payload)));
    } catch (err) {
      const e = PsycheError.from(err);
      // A frame that failed to parse may still have carried an id (parseFrame puts it in details).
      if (id === "") {
        const details = e.details as { id?: unknown } | undefined;
        id =
          typeof details?.id === "string" && details.id.length > 0 ? details.id : UNKNOWN_FRAME_ID;
      }
      this.#deps.log.log(e.code === "internal" ? "error" : "info", "request failed", {
        conn: this.id,
        code: e.code,
      });
      this.#transport.send(JSON.stringify(errRes(id, e.toPayload())));
      if (e.code === "unauthorized" || e.code === "protocol_version_mismatch")
        this.close("handshake failed");
    }
  }

  close(reason: string): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#transport.close(reason);
  }

  #dispatch(frame: ReqFrame): unknown {
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
    const spec = methodSpec(method);
    const scope = spec.scope as DeviceScope | "none";
    if (scope !== "none" && !identity.scopes.includes(scope)) {
      throw new PsycheError("forbidden", `${method} requires scope ${scope}`);
    }
    if (spec.sideEffecting) {
      return this.#idempotent(frame, identity, () => this.#handle(method, params, identity));
    }
    return this.#handle(method, params, identity);
  }

  #idempotent(frame: ReqFrame, identity: PairedIdentity, run: () => unknown): unknown {
    if (!frame.idempotencyKey) {
      throw new PsycheError(
        "invalid_params",
        `${frame.method} is side-effecting and needs an idempotencyKey`,
      );
    }
    const key = `${identity.deviceId}\u0000${frame.method}\u0000${frame.idempotencyKey}`;
    const paramsHash = createHash("sha256")
      .update(JSON.stringify(frame.params ?? null))
      .digest("hex");
    const prior = this.#deps.idempotency.get(key);
    if (prior) {
      if (prior.paramsHash !== paramsHash) {
        throw new PsycheError(
          "idempotency_conflict",
          "idempotencyKey was used with different params",
        );
      }
      return prior.payload;
    }
    const payload = run();
    this.#deps.idempotency.set(key, { paramsHash, payload });
    return payload;
  }

  #connect(params: ConnectParams): unknown {
    if (this.#phase !== "new")
      throw new PsycheError("conflict", "connect was already sent on this connection");
    const { pending, challenge } = issueChallenge(
      params,
      this.#deps.serverOrigin(),
      this.#deps.now().getTime(),
    );
    this.#challenge = pending;
    this.#phase = "challenged";
    this.#deps.log.log("info", "challenge issued", {
      conn: this.id,
      role: params.role,
      family: params.deviceFamily,
      transport: this.#peer.transport,
    });
    return challenge;
  }

  #verify(params: ConnectVerifyParams): unknown {
    const pending = this.#challenge;
    if (this.#phase !== "challenged" || pending === null) {
      throw new PsycheError("conflict", "connect.verify needs a pending challenge");
    }
    const { result, identity } = verifyChallenge(pending, params, this.#peer, {
      store: this.#deps.store,
      handshakeSecret: this.#deps.handshakeSecret,
      serverOrigin: this.#deps.serverOrigin(),
      now: this.#deps.now,
    });
    this.#challenge = null;
    this.#deps.log.log("info", "handshake finished", { conn: this.id, phase: result.phase });
    if (result.phase === "paired" && identity) {
      this.#phase = "paired";
      this.#identity = identity;
      this.#unsubscribe = this.#deps.bus.subscribe(identity.scopes, (frame) =>
        this.#transport.send(frame),
      );
      return { ...result, stateVersion: this.#deps.bus.stateVersion };
    }
    if (result.phase === "pending") {
      this.#phase = "pending";
      return result;
    }
    // denied: answer, then close.
    queueMicrotask(() => this.close("denied"));
    return result;
  }

  #handle(method: string, params: unknown, identity: PairedIdentity): unknown {
    switch (method) {
      case "settings.get":
        return this.#settingsGet(params as { keys?: string[] });
      case "settings.set":
        return this.#settingsSet(params as { key: string; value: unknown }, identity);
      default:
        throw new PsycheError(
          "not_implemented",
          `${method} is not implemented yet (S01 owns the Gateway)`,
        );
    }
  }

  #settingsGet(params: { keys?: string[] }): unknown {
    const keys = params.keys?.filter((k) => !k.startsWith(INTERNAL_SETTING_PREFIX));
    const all = this.#deps.store.getSettings(keys);
    const settings = Object.fromEntries(
      Object.entries(all).filter(([k]) => !k.startsWith(INTERNAL_SETTING_PREFIX)),
    );
    return { settings, stateVersion: this.#deps.bus.stateVersion };
  }

  #settingsSet(params: { key: string; value: unknown }, identity: PairedIdentity): unknown {
    const { key, value } = params;
    if (key.startsWith(INTERNAL_SETTING_PREFIX)) {
      throw new PsycheError(
        "invalid_params",
        `Setting keys starting with "${INTERNAL_SETTING_PREFIX}" are reserved`,
      );
    }
    // Security §10: security settings need operator.admin (fresh user presence is added by S01).
    if (isAdminSettingKey(key) && !identity.scopes.includes("operator.admin")) {
      throw new PsycheError("forbidden", `Changing ${key} requires operator.admin`);
    }
    const { store, bus } = this.#deps;
    const { entry, stateVersion } = store.transaction(() => {
      const stored = store.setSetting(key, value);
      return { entry: stored, stateVersion: bus.bumpStateVersion() };
    });
    bus.publish("settings.changed", { entries: [entry] }, "operator.read");
    return { entry, stateVersion };
  }
}
