import type { InboundDecisionEvent, PairingDecidedEvent } from "@psyche/channels";
import type { ChannelConversation } from "@psyche/permissions";

/**
 * What the channel layer's inbound policy decided per conversation, for the broker's channel
 * reply authority (N5): who last wrote there under the policy, when, and whether it is the
 * owner's own chat. Memory only: after a restart the conversation must write again before
 * Psyche answers it there (approval cards included).
 */
export class ChannelConversations {
  static readonly MAX = 1_000;
  readonly #byKey = new Map<string, ChannelConversation>();

  #key(channel: string, account: string, conversation: string): string {
    return `${channel}\u0000${account}\u0000${conversation}`;
  }

  /** `ChannelServiceOptions.onInboundDecision`. */
  record(event: InboundDecisionEvent): void {
    const m = event.message;
    const key = this.#key(m.channel, m.account, m.chatId);
    const prev = this.#byKey.get(key);
    this.#byKey.delete(key);
    this.#byKey.set(key, {
      senderId: m.senderId,
      lastInboundAt: m.receivedAt,
      allows: event.action === "deliver" ? "reply" : "pairing_code",
      owner: prev?.owner === true || event.route?.role === "owner",
      isGroup: m.isGroup,
    });
    // Oldest first: drop the least recently active conversation.
    if (this.#byKey.size > ChannelConversations.MAX) {
      const oldest = this.#byKey.keys().next().value;
      if (oldest !== undefined) this.#byKey.delete(oldest);
    }
  }

  /**
   * `ChannelServiceOptions.onPairingDecided`: an approved sender's pairing DM becomes answerable
   * (they are in `allowFrom` now), so the confirmation passes as a reply (#277). The window is
   * still the reply window from their last message; group chats never pair. A denial leaves
   * the record as it is: no code is re-sent and nothing else may be.
   */
  pairingDecided(event: PairingDecidedEvent): void {
    if (event.decision !== "approved") return;
    const prefix = this.#key(event.channel.type, event.channel.account, "");
    for (const [key, c] of this.#byKey) {
      if (!key.startsWith(prefix) || c.isGroup || c.allows !== "pairing_code") continue;
      if (c.senderId !== event.senderId) continue;
      this.#byKey.set(key, { ...c, allows: "reply" });
    }
  }

  /** `PermissionBrokerOptions.channelConversations`. */
  get(ref: { channel: string; account: string; conversation: string }) {
    const c = this.#byKey.get(this.#key(ref.channel, ref.account, ref.conversation));
    return c === undefined ? undefined : { ...c };
  }
}
