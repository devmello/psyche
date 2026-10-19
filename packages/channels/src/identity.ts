import type { ChannelIdentity, ChannelType } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { qualifiedSender } from "./settings.ts";

/**
 * Identities and owner matching (security §9; review design-21). A sender is the owner when its
 * qualified id (`telegram:123`) is in the global `commands.ownerAllowFrom` or its raw id is in the
 * channel's `ownerIds`, and the transport identity is strong. `identityLinks` merge one person's
 * senders across channels; a sender belongs to at most one identity.
 */

export const OWNER_IDENTITY_ID = "owner";

export interface SenderRef {
  type: ChannelType;
  senderId: string;
  /** Weak transports (SMS, email `From:`, Telegram anonymous admins) never match. */
  strong: boolean;
}

export class IdentityDirectory {
  #byLink = new Map<string, ChannelIdentity>();
  #byId = new Map<string, ChannelIdentity>();
  #owners = new Set<string>();

  constructor(identities: ChannelIdentity[] = [], ownerAllowFrom: string[] = []) {
    this.replace(identities, ownerAllowFrom);
  }

  replace(identities: ChannelIdentity[], ownerAllowFrom: string[]): void {
    assertDisjointLinks(identities);
    this.#byLink.clear();
    this.#byId.clear();
    for (const identity of identities) {
      this.#byId.set(identity.id, identity);
      for (const link of identity.links) this.#byLink.set(link, identity);
    }
    this.#owners = new Set(ownerAllowFrom.filter((o) => o !== "*"));
  }

  get ownerAllowFrom(): string[] {
    return [...this.#owners];
  }

  isOwner(sender: SenderRef, channelOwnerIds: readonly string[]): boolean {
    if (!sender.strong) return false;
    return (
      this.#owners.has(qualifiedSender(sender.type, sender.senderId)) ||
      channelOwnerIds.includes(sender.senderId)
    );
  }

  /** The linked identity of a strong sender (weak senders are never linked). */
  identityOf(sender: SenderRef): ChannelIdentity | undefined {
    if (!sender.strong) return undefined;
    return this.#byLink.get(qualifiedSender(sender.type, sender.senderId));
  }

  get(id: string): ChannelIdentity | undefined {
    return this.#byId.get(id);
  }

  list(): ChannelIdentity[] {
    return [...this.#byId.values()];
  }
}

/** Throws `conflict` when one sender appears in two identities (links must be unambiguous). */
export function assertDisjointLinks(identities: readonly ChannelIdentity[]): void {
  const seen = new Map<string, string>();
  for (const identity of identities) {
    if (identity.id === OWNER_IDENTITY_ID) {
      throw new PsycheError("invalid_params", `identity id "${OWNER_IDENTITY_ID}" is reserved`);
    }
    for (const link of identity.links) {
      if (!/^[a-z]+:.+$/.test(link)) {
        throw new PsycheError(
          "invalid_params",
          `identity link must be "<channel>:<senderId>": ${link}`,
        );
      }
      const other = seen.get(link);
      if (other !== undefined && other !== identity.id) {
        throw new PsycheError("conflict", `${link} already belongs to identity ${other}`);
      }
      seen.set(link, identity.id);
    }
  }
}
