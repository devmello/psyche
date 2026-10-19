import { randomInt } from "node:crypto";
import type { Clock, PairingRequest } from "@psyche/protocol";
import type { ChannelStore } from "./store/types.ts";

/**
 * Channel-sender pairing (ADR-011, security §9): 8-character codes from an alphabet without
 * 0 / O / 1 / I, valid for 1 hour, at most 3 pending per channel. A sender with a live pending
 * request keeps its code (re-sent at most once per `resendAfterMs`); a full channel answers
 * nobody new until a slot frees up.
 */

export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 60 * 60 * 1000;
export const PAIRING_MAX_PENDING = 3;

export function generatePairingCode(random: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[random(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/** Codes are compared case-insensitively, ignoring spaces and dashes the owner may type. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export type PairingOutcome =
  /** A new request; send the code. */
  | { kind: "created"; request: PairingRequest }
  /** The sender already has a live code; `resend` says whether to send it again now. */
  | { kind: "existing"; request: PairingRequest; resend: boolean }
  /** Three requests are already pending on this channel; send nothing. */
  | { kind: "capped" };

export class PairingService {
  #store: ChannelStore;
  #clock: Clock;
  #random: (max: number) => number;
  #resendAfterMs: number;
  #lastSent = new Map<string, number>();
  /** Per-channel queue: the pending count check and the insert must not interleave. */
  #locks = new Map<string, Promise<unknown>>();

  constructor(options: {
    store: ChannelStore;
    clock: Clock;
    random?: (max: number) => number;
    resendAfterMs?: number;
  }) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#random = options.random ?? randomInt;
    this.#resendAfterMs = options.resendAfterMs ?? 10 * 60 * 1000;
  }

  #nowIso(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  async expire(): Promise<number> {
    return this.#store.expirePairings(this.#nowIso());
  }

  async request(channelId: string, senderId: string, display: string): Promise<PairingOutcome> {
    const previous = this.#locks.get(channelId) ?? Promise.resolve();
    const run = previous.then(() => this.#request(channelId, senderId, display));
    const settled = run.catch(() => undefined);
    this.#locks.set(channelId, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(channelId) === settled) this.#locks.delete(channelId);
    }
  }

  async #request(channelId: string, senderId: string, display: string): Promise<PairingOutcome> {
    await this.expire();
    const pending = await this.#store.listPairings({ channelId, status: "pending" });
    const mine = pending.find((p) => p.senderId === senderId);
    const now = this.#clock.now();
    if (mine !== undefined) {
      const last = this.#lastSent.get(mine.id) ?? 0;
      const resend = now - last >= this.#resendAfterMs;
      if (resend) this.#lastSent.set(mine.id, now);
      return { kind: "existing", request: mine, resend };
    }
    if (pending.length >= PAIRING_MAX_PENDING) return { kind: "capped" };
    const taken = new Set(pending.map((p) => p.code));
    let code = generatePairingCode(this.#random);
    while (taken.has(code)) code = generatePairingCode(this.#random);
    const request = await this.#store.createPairing({
      channelId,
      senderId,
      code,
      display,
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    });
    this.#lastSent.set(request.id, now);
    return { kind: "created", request };
  }

  /** Finds a pending request by code on a channel (after expiring stale ones). */
  async findByCode(channelId: string, code: string): Promise<PairingRequest | undefined> {
    await this.expire();
    const wanted = normalizePairingCode(code);
    const pending = await this.#store.listPairings({ channelId, status: "pending" });
    return pending.find((p) => p.code === wanted);
  }

  async decide(
    requestId: string,
    decision: "approved" | "denied",
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest> {
    const decided = await this.#store.decidePairing(requestId, decision, decidedByDeviceId);
    this.#lastSent.delete(requestId);
    return decided;
  }
}
