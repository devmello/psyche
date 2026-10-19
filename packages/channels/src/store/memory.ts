import { randomUUID } from "node:crypto";
import {
  type Channel,
  type ChannelIdentity,
  type Clock,
  type PairingRequest,
  PsycheError,
} from "@psyche/protocol";
import type { ChannelStore, NewChannelPairing, PairingFilter } from "./types.ts";

/** In-memory `ChannelStore` for tests and the WebChat-only dev Gateway. */
export class MemoryChannelStore implements ChannelStore {
  #channels = new Map<string, Channel>();
  #identities = new Map<string, ChannelIdentity>();
  #pairings: PairingRequest[] = [];
  #clock: Clock;
  #newId: () => string;

  constructor(options: { clock?: Clock; newId?: () => string } = {}) {
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#newId = options.newId ?? (() => randomUUID());
  }

  async listChannels(): Promise<Channel[]> {
    return [...this.#channels.values()].map((c) => structuredClone(c));
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    const c = this.#channels.get(id);
    return c === undefined ? undefined : structuredClone(c);
  }

  async saveChannel(channel: Channel): Promise<Channel> {
    this.#channels.set(channel.id, structuredClone(channel));
    return structuredClone(channel);
  }

  async listIdentities(): Promise<ChannelIdentity[]> {
    return [...this.#identities.values()].map((i) => structuredClone(i));
  }

  async saveIdentity(identity: ChannelIdentity): Promise<ChannelIdentity> {
    this.#identities.set(identity.id, structuredClone(identity));
    return structuredClone(identity);
  }

  async deleteIdentity(id: string): Promise<boolean> {
    return this.#identities.delete(id);
  }

  async createPairing(input: NewChannelPairing): Promise<PairingRequest> {
    const now = new Date(this.#clock.now()).toISOString();
    const row: PairingRequest = {
      id: this.#newId(),
      kind: "channel-sender",
      code: input.code,
      deviceId: null,
      channelId: input.channelId,
      senderId: input.senderId,
      display: input.display,
      status: "pending",
      createdAt: now,
      expiresAt: new Date(input.expiresAt).toISOString(),
      decidedAt: null,
      decidedByDeviceId: null,
    };
    this.#pairings.push(row);
    return structuredClone(row);
  }

  async getPairing(id: string): Promise<PairingRequest | undefined> {
    const row = this.#pairings.find((p) => p.id === id);
    return row === undefined ? undefined : structuredClone(row);
  }

  async listPairings(filter: PairingFilter = {}): Promise<PairingRequest[]> {
    return this.#pairings
      .filter(
        (p) =>
          (filter.channelId === undefined || p.channelId === filter.channelId) &&
          (filter.status === undefined || p.status === filter.status) &&
          (filter.senderId === undefined || p.senderId === filter.senderId),
      )
      .reverse()
      .map((p) => structuredClone(p));
  }

  async decidePairing(
    id: string,
    decision: "approved" | "denied",
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest> {
    const row = this.#pairings.find((p) => p.id === id);
    if (row === undefined) throw new PsycheError("not_found", `pairing request ${id} not found`);
    if (row.status !== "pending") {
      throw new PsycheError("conflict", `pairing request ${id} is already ${row.status}`);
    }
    const now = new Date(this.#clock.now()).toISOString();
    if (row.expiresAt <= now) {
      row.status = "expired";
      throw new PsycheError("conflict", `pairing request ${id} has expired`);
    }
    row.status = decision;
    row.decidedAt = now;
    row.decidedByDeviceId = decidedByDeviceId;
    return structuredClone(row);
  }

  async expirePairings(nowIso: string): Promise<number> {
    let n = 0;
    for (const row of this.#pairings) {
      if (row.status === "pending" && row.expiresAt <= nowIso) {
        row.status = "expired";
        n++;
      }
    }
    return n;
  }
}
