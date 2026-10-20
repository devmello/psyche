import {
  type ApprovalRequest,
  type Channel,
  type ChannelAdapter,
  type IssuedApproval,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import {
  approvalRef,
  chatEligibility,
  kindLabel,
  renderApprovalCard,
  renderDevicePointer,
} from "./format/approval-card.ts";
import { channelSettings } from "./settings.ts";

/**
 * Approvals over chat (architecture §4.6, security §3.7 and §9, feature N4). The broker issues one
 * single-use answer token per surface (`<channel>:<peerId>`); this router delivers cards to the
 * owner's chats, and turns button presses and `/approve <ref> approve|deny` into
 * `PermissionBroker.answer` calls. Only owner identities on strong transports may answer; chat
 * answers are always scope `once` (review design-28); kinds that are device-only never get here.
 */

export interface ApprovalHost {
  /** Attached, active channels of a type (one per account). */
  channelsOfType(type: string): { channel: Channel; adapter: ChannelAdapter }[];
  isOwner(channel: Channel, senderId: string): boolean;
  sendText(channel: Channel, chatId: string, text: string): Promise<void>;
  now(): number;
}

interface Delivery {
  channelId: string;
  chatId: string;
  surface: string;
  answerToken: string;
}

interface Pending {
  approval: ApprovalRequest;
  deliveries: Delivery[];
}

export interface DeliveryReport {
  surface: string;
  delivered: boolean;
  reason?: string;
}

const ERROR_REPLIES: Partial<Record<string, string>> = {
  approval_expired: "That approval expired. You can resume the task from Psyche.",
  answer_late: "That approval was already answered.",
  answer_replayed: "That approval was already answered.",
  approval_invalidated:
    "That approval was replaced (Psyche restarted or the run stopped). Use the newest card.",
  approval_not_armed: "Too quick. Tap again in a moment.",
  not_found: "No pending approval with that ref.",
  forbidden: "That answer was not accepted.",
};

export function approvalErrorReply(error: unknown): string {
  const code = error instanceof PsycheError ? error.code : "internal";
  return ERROR_REPLIES[code] ?? "Could not record the answer. Try again from Psyche.";
}

/** Channels whose chats may carry approval cards; WebChat clients use the device card instead. */
const CHAT_APPROVAL_CHANNELS = (channel: Channel): boolean => channel.type !== "webchat";

export class ChatApprovals {
  #broker: PermissionBroker;
  #host: ApprovalHost;
  #pending = new Map<string, Pending>();

  constructor(options: { broker: PermissionBroker; host: ApprovalHost }) {
    this.#broker = options.broker;
    this.#host = options.host;
  }

  #prune(): void {
    const now = this.#host.now();
    for (const [id, p] of this.#pending) {
      if (Date.parse(p.approval.expiresAt) + 5 * 60_000 < now) this.#pending.delete(id);
    }
  }

  /**
   * Deliver an issued (or re-issued) approval to every chat surface it carries a token for.
   * Surfaces that are not chat channels (`desktop`, `web`, `notification`) are ignored here.
   */
  async deliver(issued: IssuedApproval): Promise<DeliveryReport[]> {
    this.#prune();
    const { approval } = issued;
    const reports: DeliveryReport[] = [];
    const pending: Pending = this.#pending.get(approval.id) ?? { approval, deliveries: [] };
    pending.approval = approval;
    for (const [surface, answerToken] of Object.entries(issued.answerTokens)) {
      const sep = surface.indexOf(":");
      if (sep <= 0) continue;
      const type = surface.slice(0, sep);
      const peerId = surface.slice(sep + 1);
      const targets = this.#host
        .channelsOfType(type)
        .filter(({ channel }) => this.#host.isOwner(channel, peerId));
      if (targets.length === 0) {
        reports.push({ surface, delivered: false, reason: "no_owner_channel" });
        continue;
      }
      for (const { channel, adapter } of targets) {
        // WebChat clients are paired devices with real approval cards (`approvals.*` and the
        // `operator.approvals` scope); a chat card there would bypass that scope.
        if (!CHAT_APPROVAL_CHANNELS(channel)) {
          reports.push({ surface, delivered: false, reason: "not_a_chat_surface" });
          continue;
        }
        const eligibility = chatEligibility(approval, {
          allowDestructive: channelSettings(channel).allowDestructiveApprovals,
        });
        if (!eligibility.ok) {
          // The chat may not answer this one: the header and "Answer this on your Mac." only,
          // never the arguments and never a token (security §3.7, §9; design-12).
          try {
            await this.#host.sendText(channel, peerId, renderDevicePointer(surface, approval));
          } catch {
            // The pointer is a courtesy; the report carries the reason either way.
          }
          reports.push({ surface, delivered: false, reason: eligibility.reason });
          continue;
        }
        const caps = adapter.capabilities();
        const buttons = adapter.sendApprovalButtons !== undefined && caps.buttons;
        const card = renderApprovalCard(approval, {
          surface,
          ref: approvalRef(approval.id),
          now: this.#host.now(),
          commandFallback: !buttons,
          ...(caps.maxMessageChars === undefined ? {} : { maxChars: caps.maxMessageChars }),
        });
        try {
          if (!card.answerable) {
            // Too long to show in full (or device-only): point to the Mac, accept no chat answer.
            await this.#host.sendText(channel, peerId, card.text);
            reports.push({
              surface,
              delivered: false,
              reason: card.reason === "device_only" ? "device_only" : "too_long_for_chat",
            });
            continue;
          }
          if (buttons) await adapter.sendApprovalButtons?.(peerId, approval, answerToken);
          else await this.#host.sendText(channel, peerId, card.text);
        } catch (error) {
          const code = error instanceof PsycheError ? error.code : "internal";
          reports.push({ surface, delivered: false, reason: `send_failed:${code}` });
          continue;
        }
        pending.deliveries.push({ channelId: channel.id, chatId: peerId, surface, answerToken });
        reports.push({ surface, delivered: true });
      }
    }
    if (pending.deliveries.length > 0) this.#pending.set(approval.id, pending);
    return reports;
  }

  /** Approval id for a `/approve` ref: the 8-character ref or the full id. */
  #resolveRef(ref: string): Pending | undefined {
    const wanted = ref.toLowerCase();
    for (const p of this.#pending.values()) {
      if (approvalRef(p.approval.id) === wanted || p.approval.id.toLowerCase() === wanted) return p;
    }
    return undefined;
  }

  /** A button press relayed by an adapter (`onApprovalAnswer`). */
  async answerFromButton(
    channel: Channel,
    answer: {
      approvalId: string;
      answerToken: string;
      decision: "approve" | "deny";
      senderId: string;
    },
  ): Promise<void> {
    await this.#answer(channel, answer.senderId, answer.senderId, {
      approvalId: answer.approvalId,
      answerToken: answer.answerToken,
      decision: answer.decision,
    });
  }

  /** `/approve <ref> approve|deny` typed in `chatId`. */
  async answerFromCommand(
    channel: Channel,
    chatId: string,
    senderId: string,
    ref: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    if (!CHAT_APPROVAL_CHANNELS(channel)) {
      await this.#host.sendText(channel, chatId, "Answer approvals on the approval card.");
      return;
    }
    if (!this.#host.isOwner(channel, senderId)) {
      await this.#host.sendText(channel, chatId, "Only the owner can answer approvals.");
      return;
    }
    this.#prune();
    const pending = this.#resolveRef(ref);
    const surface = `${channel.type}:${senderId}`;
    const delivery = pending?.deliveries.find(
      (d) => d.surface === surface && d.channelId === channel.id,
    );
    if (pending === undefined || delivery === undefined) {
      await this.#host.sendText(channel, chatId, ERROR_REPLIES.not_found ?? "");
      return;
    }
    await this.#answer(channel, senderId, chatId, {
      approvalId: pending.approval.id,
      answerToken: delivery.answerToken,
      decision,
    });
  }

  async #answer(
    channel: Channel,
    senderId: string,
    chatId: string,
    answer: { approvalId: string; answerToken: string; decision: "approve" | "deny" },
  ): Promise<void> {
    if (!CHAT_APPROVAL_CHANNELS(channel)) {
      await this.#host.sendText(channel, chatId, "Answer approvals on the approval card.");
      return;
    }
    if (!this.#host.isOwner(channel, senderId)) {
      await this.#host.sendText(channel, chatId, "Only the owner can answer approvals.");
      return;
    }
    const known = this.#pending.get(answer.approvalId)?.approval;
    const approval = known ?? (await this.#broker.get(answer.approvalId));
    if (approval !== undefined) {
      const eligibility = chatEligibility(approval, {
        allowDestructive: channelSettings(channel).allowDestructiveApprovals,
      });
      if (!eligibility.ok) {
        await this.#host.sendText(
          channel,
          chatId,
          "This approval can only be answered on a paired device.",
        );
        return;
      }
    }
    try {
      const decided = await this.#broker.answer({
        ...answer,
        scope: "once",
        decidedBy: { channel: channel.type, senderId },
      });
      const label = kindLabel(decided.kind);
      const verb = decided.status === "approved" ? "Approved" : "Denied";
      await this.#host.sendText(channel, chatId, `${verb}: ${label}.`);
    } catch (error) {
      await this.#host.sendText(channel, chatId, approvalErrorReply(error));
    }
  }
}
