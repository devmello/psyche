import type { Channel, ChannelIdentity, PairingRequest, PairingStatus } from "@psyche/protocol";

/**
 * Persistence port for the channel service: `channels`, `identities` (data model §8, owned by
 * S10) and the `channel-sender` rows of `pairing_requests` (§1, table owned by `@psyche/db`).
 * Implementations: `MemoryChannelStore` (tests) and `SqliteChannelStore` (`@psyche/db`).
 */
export interface NewChannelPairing {
  channelId: string;
  senderId: string;
  code: string;
  display: string;
  /** ISO-8601. */
  expiresAt: string;
}

export interface PairingFilter {
  channelId?: string;
  status?: PairingStatus;
  senderId?: string;
}

export interface ChannelStore {
  listChannels(): Promise<Channel[]>;
  getChannel(id: string): Promise<Channel | undefined>;
  /** Insert or replace by id. */
  saveChannel(channel: Channel): Promise<Channel>;

  listIdentities(): Promise<ChannelIdentity[]>;
  saveIdentity(identity: ChannelIdentity): Promise<ChannelIdentity>;
  /** Returns false when the id did not exist. */
  deleteIdentity(id: string): Promise<boolean>;

  createPairing(input: NewChannelPairing): Promise<PairingRequest>;
  getPairing(id: string): Promise<PairingRequest | undefined>;
  /** `channel-sender` requests only, newest first. */
  listPairings(filter?: PairingFilter): Promise<PairingRequest[]>;
  /**
   * Decide a pending request. Rejects `not_found`, or `conflict` when it is no longer pending or
   * has expired (an expired request is marked `expired` first).
   */
  decidePairing(
    id: string,
    decision: "approved" | "denied",
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest>;
  /** Marks pending requests with `expiresAt <= now` as expired; returns how many changed. */
  expirePairings(nowIso: string): Promise<number>;
}
