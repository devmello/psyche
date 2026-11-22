import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { claimTranscript, type DevicePlatform, normalizeSetupCode } from "@psyche/protocol";
import { claimProof, deriveClaimKey, proofsEqual } from "@psyche/protocol/claim-node";
import WebSocket from "ws";
import { PinnedChannel, PinRefusal } from "./lan-tls.ts";

/**
 * Claiming a fresh psyche-server with its setup code (remote-gateway design §3.6), from main.
 *
 * Nothing about the server is trusted until it has proved it knows the code: not the Bonjour
 * record, not the self-signed certificate, not the identity key it names. The order:
 *
 * 1. TLS 1.3 to the server's LAN listener with no pin yet (`PinnedChannel`), noting the SPKI of
 *    the certificate this socket was given.
 * 2. `gateway.claim.hello` with a fresh nonce and this computer's device key for that server. The
 *    answer must name the certificate this socket presented, or the client stops (a relay).
 * 3. The client proves the code first: HMAC keyed by scrypt(code, salt) over the transcript (both
 *    nonces, the identity key, the SPKI and the device key). A server that does not know the code
 *    learns only that proof (see `claim-node.ts` on what that costs to guess at).
 * 4. The server answers with its own proof over the same transcript. Only when it checks does the
 *    caller pin the identity key and the certificate, exactly as a `psyche-pair:v2` link would.
 */

export type ClaimProblem =
  /** What was typed is not a setup code (checked before anything is sent). */
  | "bad_code"
  | "wrong_code"
  | "code_expired"
  | "too_many_attempts"
  /** Not a server waiting to be set up (set up already, or not a psyche-server). */
  | "not_claimable"
  /** Nothing answered at that address, or it did not speak TLS 1.3. */
  | "unreachable"
  /** The answer named another certificate than the one this connection presented. */
  | "cert_mismatch"
  /** The server took the code but could not prove it knows it: not the server you set up. */
  | "server_unproven"
  /**
   * The proof was sent and no answer came back (dropped connection, timeout): the server may
   * have made this device its admin. The caller keeps the device key and lets the owner retry.
   */
  | "unconfirmed"
  /** Anything else the server refused with. */
  | "failed";

export class ClaimError extends Error {
  readonly problem: ClaimProblem;
  readonly attemptsLeft: number | undefined;
  readonly retryAfterSec: number | undefined;
  constructor(problem: ClaimProblem, opts: { attemptsLeft?: number; retryAfterSec?: number } = {}) {
    super(problem);
    this.name = "ClaimError";
    this.problem = problem;
    this.attemptsLeft = opts.attemptsLeft;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export interface ClaimDevice {
  deviceId: string;
  publicKey: string;
  name: string;
  platform: DevicePlatform;
}

export interface ClaimOptions {
  /** What to dial: a `.local` name or a private address. */
  host: string;
  port: number;
  /** The code as the owner typed it. */
  code: string;
  device: ClaimDevice;
  timeoutMs?: number;
}

export interface ClaimedServer {
  /** The identity key the server proved, to pin. */
  gatewayKey: string;
  /** The SPKI of the certificate this connection presented, to pin. */
  certSpki: string;
  hostName: string;
}

const B64_43 = /^[A-Za-z0-9_-]{43}$/;
const B64_22 = /^[A-Za-z0-9_-]{22}$/;

type Frame = {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  payload?: unknown;
  error?: { code?: unknown; details?: Record<string, unknown> };
};

function refusalOf(error: Frame["error"]): ClaimError {
  const reason = error?.details?.reason;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const extra = {
    ...(n(error?.details?.attemptsLeft) === undefined
      ? {}
      : { attemptsLeft: n(error?.details?.attemptsLeft) as number }),
    ...(n(error?.details?.retryAfterSec) === undefined
      ? {}
      : { retryAfterSec: n(error?.details?.retryAfterSec) as number }),
  };
  if (
    reason === "wrong_code" ||
    reason === "code_expired" ||
    reason === "too_many_attempts" ||
    reason === "not_claimable" ||
    reason === "claim_mode"
  ) {
    return new ClaimError(reason === "claim_mode" ? "not_claimable" : reason, extra);
  }
  if (error?.code === "rate_limited") return new ClaimError("too_many_attempts", extra);
  return new ClaimError("failed");
}

/** Runs the claim handshake; resolves with what to pin, or rejects with a `ClaimError`. */
export async function claimServer(opts: ClaimOptions): Promise<ClaimedServer> {
  const code = normalizeSetupCode(opts.code);
  if (code === null) throw new ClaimError("bad_code");
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const channel = new PinnedChannel({
    host: opts.host,
    port: opts.port,
    // No pin yet: the code is what proves who answers.
    pinned: () => undefined,
  });
  let socket: Awaited<ReturnType<PinnedChannel["connect"]>>;
  try {
    socket = await channel.connect("ws");
  } catch (err) {
    throw new ClaimError(err instanceof PinRefusal ? "failed" : "unreachable");
  }
  const seen = channel.observedSpki();
  if (seen === undefined) {
    socket.destroy();
    throw new ClaimError("unreachable");
  }
  const hostInUrl = isIP(opts.host) === 6 ? `[${opts.host}]` : opts.host;
  const ws = new WebSocket(`wss://${hostInUrl}:${opts.port}/ws`, {
    createConnection: () => socket,
    handshakeTimeout: 10_000,
  });
  const waiting = new Map<string, (f: Frame) => void>();
  let closedWith: ClaimError | null = null;
  const failAll = (e: ClaimError) => {
    closedWith ??= e;
    for (const [, w] of waiting) w({ type: "res", ok: false, error: { code: "closed" } });
    waiting.clear();
  };
  ws.on("message", (data) => {
    let f: Frame;
    try {
      f = JSON.parse(data.toString()) as Frame;
    } catch {
      return;
    }
    if (f.type !== "res" || typeof f.id !== "string") return;
    const w = waiting.get(f.id);
    waiting.delete(f.id);
    w?.(f);
  });
  ws.on("close", () => failAll(new ClaimError("unreachable")));
  ws.on("error", () => failAll(new ClaimError("unreachable")));
  const timer = setTimeout(() => {
    failAll(new ClaimError("unreachable"));
    ws.terminate();
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", () => reject(new ClaimError("unreachable")));
      ws.once("unexpected-response", () => reject(new ClaimError("unreachable")));
    });
    let seq = 0;
    const call = (method: string, params: unknown): Promise<Frame> =>
      new Promise((resolve) => {
        if (closedWith !== null) {
          resolve({ type: "res", ok: false, error: { code: "closed" } });
          return;
        }
        const id = `c${++seq}`;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });

    const clientNonce = randomBytes(32).toString("base64url");
    const hello = await call("gateway.claim.hello", {
      clientNonce,
      deviceId: opts.device.deviceId,
      publicKey: opts.device.publicKey,
      name: opts.device.name.slice(0, 128),
      platform: opts.device.platform,
    });
    if (hello.ok !== true) {
      if (hello.error?.code === "closed") throw closedWith ?? new ClaimError("unreachable");
      throw refusalOf(hello.error);
    }
    const h = (hello.payload ?? {}) as Record<string, unknown>;
    if (
      typeof h.serverNonce !== "string" ||
      !B64_43.test(h.serverNonce) ||
      typeof h.salt !== "string" ||
      !B64_22.test(h.salt) ||
      typeof h.gatewayKey !== "string" ||
      !B64_43.test(h.gatewayKey) ||
      typeof h.certSpki !== "string" ||
      !B64_43.test(h.certSpki)
    ) {
      throw new ClaimError("failed");
    }
    // The certificate the server says it serves must be the one this socket was given.
    if (h.certSpki !== seen) throw new ClaimError("cert_mismatch");
    const key = await deriveClaimKey(code, Buffer.from(h.salt, "base64url"));
    const transcript = claimTranscript({
      clientNonce,
      serverNonce: h.serverNonce,
      salt: h.salt,
      gatewayKey: h.gatewayKey,
      certSpki: seen,
      deviceId: opts.device.deviceId,
      devicePublicKey: opts.device.publicKey,
    });
    const prove = await call("gateway.claim.prove", {
      proof: claimProof(key, "client", transcript),
    });
    if (prove.ok !== true) {
      if (prove.error?.code === "closed") throw new ClaimError("unconfirmed");
      throw refusalOf(prove.error);
    }
    const p = (prove.payload ?? {}) as Record<string, unknown>;
    if (
      typeof p.proof !== "string" ||
      !proofsEqual(p.proof, claimProof(key, "server", transcript)) ||
      p.deviceId !== opts.device.deviceId
    ) {
      throw new ClaimError("server_unproven");
    }
    const hostName =
      typeof h.hostName === "string" && h.hostName.length > 0 ? h.hostName.slice(0, 64) : "";
    return { gatewayKey: h.gatewayKey, certSpki: seen, hostName };
  } finally {
    clearTimeout(timer);
    ws.terminate();
  }
}
