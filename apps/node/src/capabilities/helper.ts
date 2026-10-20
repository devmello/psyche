import { createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  type ConnectParams,
  connectSigningPayload,
  type ErrorPayload,
  errRes,
  type Frame,
  type NodeCapability,
  okRes,
  PROTOCOL_VERSION,
  PsycheError,
  parseFrame,
  type ReqFrame,
  type ResFrame,
  reqFrame,
  serializeFrame,
  validateParams,
} from "@psyche/protocol";
import { NdjsonChannel } from "../transports/ndjson.ts";
import type {
  CapabilityEntry,
  CapabilityOutcome,
  CapabilityProvider,
  InvocationContext,
} from "./types.ts";

/**
 * Local hub for a co-located mac helper (`apps/mac-helper`). The helper never listens: it dials
 * `$PSYCHE_NODE_SOCKET` (else `$PSYCHE_HOME/run/node.sock`) as a node and reads the per-launch
 * secret from `$PSYCHE_HOME/run/handshake.secret`. So psyche-node plays the Gateway's role on a
 * local Unix socket: it writes the secret, accepts `connect` / `connect.verify` from a
 * `mac-helper` presenting it, and proxies `node.invoke` for the helper's `computer.*`, `apps.*`,
 * `notify.*`, `speech.*` and `keychain.*` capabilities. `vault.*`, `permissions.*` and anything
 * else are dropped: security settings are never reachable through `node.invoke` (security §10).
 *
 * The helper must be launched with `PSYCHE_HOME=<home>` so it reads this hub's secret.
 */

export const HELPER_SERVER_ORIGIN = "psyche-node-local";
export const HELPER_CHALLENGE_TTL_MS = 60_000;
/** How long an aborted invocation waits for the helper's `node.result` before giving up. */
export const HELPER_CANCEL_GRACE_MS = 5_000;
/** An unpaired connection is closed after this long. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

const PROXIED_PREFIXES = ["computer.", "apps.", "notify.", "speech."];

/**
 * Keychain calls that never hand secret material back. Anything that returns a secret or key
 * (`retrieve`, `unwrap_key`, `vault.unlock`) stays off the node: the host vault releases one
 * credential per approved fill through the Gateway, never through a generic invoke (security §13).
 */
const PROXIED_KEYCHAIN = new Set(["keychain.set", "keychain.delete", "keychain.status"]);

export function isProxiedHelperCapability(name: string): boolean {
  return PROXIED_KEYCHAIN.has(name) || PROXIED_PREFIXES.some((p) => name.startsWith(p));
}

export interface HelperProviderOptions {
  /** psyche-node's home (the helper's `PSYCHE_HOME`). */
  home: string;
  /** Defaults to `<home>/run/node.sock`. */
  socketPath?: string;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export type HelperProvider = CapabilityProvider & {
  start(): Promise<void>;
  readonly socketPath: string;
  waitForHelper(ms: number): Promise<boolean>;
  status(): Promise<Record<string, unknown>>;
  onChange(listener: () => void): void;
  dispose(): Promise<void>;
};

interface InFlight {
  ctx: InvocationContext;
  resolve: (outcome: CapabilityOutcome) => void;
}

type ConnState =
  | { phase: "await_connect" }
  | {
      phase: "await_verify";
      params: ConnectParams;
      key: KeyObject;
      nonce: string;
      expiresAtMs: number;
    }
  | { phase: "paired"; params: ConnectParams; manifest: NodeCapability[] }
  | { phase: "closed" };

function secretMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ed25519Key(b64url: string): KeyObject {
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

/** True when something accepts connections on `path`. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const done = (answer: boolean) => {
      probe.destroy();
      resolve(answer);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(1_000, () => done(false));
  });
}

export function createHelperProvider(options: HelperProviderOptions): HelperProvider {
  const home = options.home;
  const runDir = join(home, "run");
  const socketPath = options.socketPath ?? join(runDir, "node.sock");
  const secretPath = join(runDir, "handshake.secret");
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  let secret = "";
  let server: Server | undefined;
  let listening = false;
  let disposed = false;
  const sockets = new Set<Socket>();
  const conns = new Set<HelperConnection>();
  const listeners: (() => void)[] = [];
  let pairWaiters: (() => void)[] = [];
  let active: HelperConnection | undefined;

  const fireChange = () => {
    for (const l of listeners) {
      try {
        l();
      } catch (err) {
        log("helper onChange listener failed", { error: (err as Error).message });
      }
    }
  };

  /** One accepted connection: handshake, then the node protocol (we are the Gateway side). */
  class HelperConnection {
    readonly channel: NdjsonChannel;
    state: ConnState = { phase: "await_connect" };
    readonly inFlight = new Map<string, InFlight>();
    readonly pending = new Map<string, (res: ResFrame) => void>();
    #nextId = 0;
    #handshakeTimer: NodeJS.Timeout;

    constructor(socket: Socket) {
      this.channel = new NdjsonChannel("mac-helper", socket, socket, () => {
        // Let a final reply (a denial) reach the helper before the socket goes away.
        socket.end();
        setTimeout(() => socket.destroy(), 1_000).unref();
      });
      this.channel.onFrame((raw) => this.#onFrame(raw));
      this.channel.onClose((reason) => this.#onClose(reason));
      socket.once("close", () => this.channel.close("socket closed"));
      this.#handshakeTimer = setTimeout(() => {
        if (this.state.phase !== "paired") this.channel.close("handshake timeout");
      }, HANDSHAKE_TIMEOUT_MS);
      this.#handshakeTimer.unref();
    }

    send(frame: Frame): void {
      this.channel.send(serializeFrame(frame));
    }

    request(method: string, params: unknown, onRes?: (res: ResFrame) => void): void {
      this.#nextId += 1;
      const id = `n${this.#nextId}`;
      if (onRes) this.pending.set(id, onRes);
      this.send(reqFrame(id, method, params));
    }

    get manifest(): NodeCapability[] {
      return this.state.phase === "paired" ? this.state.manifest : [];
    }

    #refuse(reason: string): void {
      log("helper handshake refused", { reason });
      this.channel.close(reason);
    }

    #onFrame(raw: string): void {
      let frame: Frame;
      try {
        frame = parseFrame(raw);
      } catch (err) {
        const e = PsycheError.from(err);
        const id = (e.details as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") this.send(errRes(id, e));
        if (this.state.phase !== "paired") this.#refuse("invalid frame before pairing");
        return;
      }
      if (frame.type === "event") return;
      if (frame.type === "res") {
        if (this.state.phase !== "paired") return;
        const cb = this.pending.get(frame.id);
        if (cb) {
          this.pending.delete(frame.id);
          cb(frame);
        }
        return;
      }
      if (this.state.phase === "paired") this.#onPairedReq(frame);
      else this.#onHandshakeReq(frame);
    }

    #onHandshakeReq(req: ReqFrame): void {
      const state = this.state;
      if (req.method === "connect" && state.phase === "await_connect") {
        let params: ConnectParams;
        let key: KeyObject;
        try {
          params = validateParams("connect", req.params);
          key = ed25519Key(params.publicKey);
        } catch (err) {
          this.send(errRes(req.id, PsycheError.from(err)));
          this.#refuse("invalid connect params");
          return;
        }
        const refuse = (error: PsycheError) => {
          this.send(errRes(req.id, error));
          this.#refuse(error.message);
        };
        if (params.role !== "node" || params.deviceFamily !== "mac-helper") {
          refuse(new PsycheError("forbidden", "This socket accepts only the mac helper"));
          return;
        }
        if (!secretMatches(secret, params.handshakeSecret)) {
          refuse(new PsycheError("unauthorized", "Handshake secret does not match"));
          return;
        }
        const range = params.protocolVersion;
        if (range.min > PROTOCOL_VERSION || range.max < PROTOCOL_VERSION) {
          refuse(
            new PsycheError(
              "protocol_version_mismatch",
              `psyche-node speaks protocol ${PROTOCOL_VERSION}; helper offered ${range.min}-${range.max}`,
              { details: { server: PROTOCOL_VERSION } },
            ),
          );
          return;
        }
        const nonce = randomBytes(32).toString("base64url");
        const expiresAtMs = now().getTime() + HELPER_CHALLENGE_TTL_MS;
        this.state = { phase: "await_verify", params, key, nonce, expiresAtMs };
        this.send(
          okRes(req.id, {
            phase: "challenge",
            nonce,
            serverOrigin: HELPER_SERVER_ORIGIN,
            protocolVersion: PROTOCOL_VERSION,
            expiresAt: new Date(expiresAtMs).toISOString(),
          }),
        );
        return;
      }
      if (req.method === "connect.verify" && state.phase === "await_verify") {
        const deny = (reason: string) => {
          this.send(okRes(req.id, { phase: "denied", reason }));
          this.#refuse(reason);
        };
        let input: { nonce: string; signature: string };
        try {
          input = validateParams("connect.verify", req.params);
        } catch {
          deny("invalid connect.verify params");
          return;
        }
        if (input.nonce !== state.nonce) {
          deny("nonce does not match the challenge");
          return;
        }
        if (now().getTime() > state.expiresAtMs) {
          deny("challenge expired");
          return;
        }
        const payload = connectSigningPayload({
          nonce: state.nonce,
          platform: state.params.platform,
          deviceFamily: state.params.deviceFamily,
          protocolVersion: PROTOCOL_VERSION,
          serverOrigin: HELPER_SERVER_ORIGIN,
        });
        let good = false;
        try {
          good = verify(null, payload, state.key, Buffer.from(input.signature, "base64url"));
        } catch {
          good = false;
        }
        if (!good) {
          deny("bad challenge signature");
          return;
        }
        const manifest = (state.params.capabilities ?? [])
          .filter((c) => isProxiedHelperCapability(c.name))
          .map((c) => structuredClone(c));
        this.state = { phase: "paired", params: state.params, manifest };
        clearTimeout(this.#handshakeTimer);
        this.send(
          okRes(req.id, {
            phase: "paired",
            deviceId: state.params.deviceId,
            scopes: ["node"],
            stateVersion: 0,
            serverTime: now().toISOString(),
          }),
        );
        onPaired(this);
        return;
      }
      this.send(errRes(req.id, new PsycheError("not_paired", "Complete the handshake first")));
    }

    #onPairedReq(req: ReqFrame): void {
      if (req.method === "node.event") {
        let params: { invocationId: string; data: unknown };
        try {
          params = validateParams("node.event", req.params);
        } catch (err) {
          this.send(errRes(req.id, PsycheError.from(err)));
          return;
        }
        const call = this.inFlight.get(params.invocationId);
        if (!call) {
          this.send(errRes(req.id, new PsycheError("not_found", "Unknown invocation")));
          return;
        }
        call.ctx.emit(params.data);
        this.send(okRes(req.id, { ok: true }));
        return;
      }
      if (req.method === "node.result") {
        const raw = req.params as { invocationId?: unknown } | undefined;
        const call =
          typeof raw?.invocationId === "string" ? this.inFlight.get(raw.invocationId) : undefined;
        let params: {
          ok: boolean;
          result?: unknown;
          error?: ErrorPayload;
          receipt?: CapabilityOutcome["receipt"];
        };
        try {
          params = validateParams("node.result", req.params);
        } catch (err) {
          this.send(errRes(req.id, PsycheError.from(err)));
          call?.resolve({
            ok: false,
            error: { code: "internal", message: "mac helper sent an invalid node.result" },
          });
          return;
        }
        if (!call) {
          this.send(errRes(req.id, new PsycheError("not_found", "Unknown invocation")));
          return;
        }
        this.send(okRes(req.id, { ok: true }));
        let outcome: CapabilityOutcome;
        if (params.ok) {
          outcome = { ok: true };
          if (params.result !== undefined) outcome.result = params.result;
        } else {
          outcome = {
            ok: false,
            error: params.error ?? { code: "internal", message: "mac helper reported a failure" },
          };
        }
        if (params.receipt !== undefined) outcome.receipt = params.receipt;
        call.resolve(outcome);
        return;
      }
      if (req.method === "connect" || req.method === "connect.verify") {
        this.send(errRes(req.id, new PsycheError("conflict", "Already paired")));
        return;
      }
      this.send(errRes(req.id, new PsycheError("unknown_method", `Unknown method ${req.method}`)));
    }

    invoke(
      capability: string,
      params: unknown,
      ctx: InvocationContext,
    ): Promise<CapabilityOutcome> {
      if (ctx.signal.aborted) {
        return Promise.resolve({
          ok: false,
          error: { code: "cancelled", message: "invocation cancelled" },
        });
      }
      if (this.inFlight.has(ctx.invocationId)) {
        return Promise.resolve({
          ok: false,
          error: { code: "conflict", message: `Invocation ${ctx.invocationId} is already running` },
        });
      }
      return new Promise<CapabilityOutcome>((resolve) => {
        let cancelTimer: NodeJS.Timeout | undefined;
        const onAbort = () => {
          this.request("node.cancel", { invocationId: ctx.invocationId });
          cancelTimer = setTimeout(() => {
            finish({
              ok: false,
              error: { code: "cancelled", message: "invocation cancelled" },
            });
          }, HELPER_CANCEL_GRACE_MS);
          cancelTimer.unref();
        };
        const finish = (outcome: CapabilityOutcome) => {
          if (this.inFlight.get(ctx.invocationId)?.resolve !== finish) return;
          this.inFlight.delete(ctx.invocationId);
          ctx.signal.removeEventListener("abort", onAbort);
          if (cancelTimer) clearTimeout(cancelTimer);
          resolve(outcome);
        };
        this.inFlight.set(ctx.invocationId, { ctx, resolve: finish });
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        const invoke: Record<string, unknown> = {
          invocationId: ctx.invocationId,
          capability,
          params: params === undefined ? null : params,
        };
        if (ctx.approvalId !== undefined) invoke.approvalId = ctx.approvalId;
        this.request("node.invoke", invoke, (res) => {
          if (!res.ok) finish({ ok: false, error: res.error });
        });
      });
    }

    failAll(message: string): void {
      for (const call of [...this.inFlight.values()]) {
        call.resolve({ ok: false, error: { code: "unavailable", message } });
      }
    }

    #onClose(reason: string): void {
      clearTimeout(this.#handshakeTimer);
      const wasPaired = this.state.phase === "paired";
      this.state = { phase: "closed" };
      this.pending.clear();
      this.failAll("mac helper disconnected");
      if (wasPaired && active === this) {
        active = undefined;
        log("mac helper disconnected", { reason });
        fireChange();
      }
    }
  }

  function onPaired(conn: HelperConnection): void {
    const previous = active;
    active = conn;
    log("mac helper paired", { capabilities: conn.manifest.length });
    if (previous && previous !== conn) {
      previous.failAll("mac helper replaced by a new connection");
      previous.channel.close("replaced");
    }
    const waiters = pairWaiters;
    pairWaiters = [];
    for (const w of waiters) w();
    fireChange();
  }

  async function prepareSocketPath(): Promise<void> {
    let existing: Stats;
    try {
      existing = await lstat(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!existing.isSocket()) {
      throw new PsycheError("conflict", "The helper socket path exists and is not a socket");
    }
    if (await socketAnswers(socketPath)) {
      throw new PsycheError("conflict", "Another process is listening on the helper socket");
    }
    await rm(socketPath, { force: true });
  }

  async function writeSecret(): Promise<void> {
    secret = randomBytes(32).toString("base64url");
    const tmp = join(runDir, `.handshake.secret.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, `${secret}\n`, { mode: 0o600, flag: "wx" });
      await chmod(tmp, 0o600);
      await rename(tmp, secretPath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  const provider: HelperProvider = {
    id: "helper",
    socketPath,

    async start(): Promise<void> {
      if (listening) return;
      if (disposed) throw new PsycheError("conflict", "helper provider was disposed");
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      await chmod(runDir, 0o700);
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      // Check for a live listener first: a Gateway sharing this home must keep its secret.
      await prepareSocketPath();
      await writeSecret();
      const srv = createServer((socket) => {
        if (disposed) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        const conn = new HelperConnection(socket);
        conns.add(conn);
        socket.once("close", () => {
          sockets.delete(socket);
          conns.delete(conn);
        });
      });
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(socketPath, () => {
          srv.off("error", reject);
          resolve();
        });
      });
      srv.on("error", (err) => log("helper socket error", { error: err.message }));
      await chmod(socketPath, 0o600);
      server = srv;
      listening = true;
      log("helper socket listening");
    },

    async entries(): Promise<CapabilityEntry[]> {
      const conn = active;
      if (!conn) return [];
      return conn.manifest.map((manifest) => ({
        manifest: structuredClone(manifest),
        handler: (params, ctx) => {
          const current = active;
          if (!current) {
            return Promise.resolve({
              ok: false,
              error: { code: "unavailable", message: "mac helper not connected" },
            });
          }
          if (!current.manifest.some((c) => c.name === manifest.name)) {
            return Promise.resolve({
              ok: false,
              error: { code: "not_found", message: `mac helper no longer offers ${manifest.name}` },
            });
          }
          return current.invoke(manifest.name, params, ctx);
        },
      }));
    },

    async status(): Promise<Record<string, unknown>> {
      return {
        helper: active ? "connected" : "absent",
        capabilities: active?.manifest.length ?? 0,
      };
    },

    onChange(listener: () => void): void {
      listeners.push(listener);
    },

    waitForHelper(ms: number): Promise<boolean> {
      if (active) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          pairWaiters = pairWaiters.filter((w) => w !== waiter);
          resolve(false);
        }, ms);
        pairWaiters.push(waiter);
      });
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const srv = server;
      server = undefined;
      const conn = active;
      active = undefined;
      for (const c of conns) {
        c.failAll("psyche-node is shutting down");
        c.channel.close("psyche-node is shutting down");
      }
      conns.clear();
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
      if (listening) await rm(socketPath, { force: true });
      listening = false;
      if (conn) fireChange();
    },
  };
  return provider;
}
