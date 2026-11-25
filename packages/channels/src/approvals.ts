import { checkOutbound } from "@psyche/permissions";
import { cardHeader } from "@psyche/permissions/cards";
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
  approvalWhat,
  chatEligibility,
  renderApprovalCard,
  renderDevicePointer,
} from "./format/approval-card.ts";
import { channelSettings, isWeakTransport } from "./settings.ts";
import { channelText, localizeCardText } from "./text.ts";

/**
 * Approvals over chat (architecture §4.6, security §3.7 and §9, feature N4). The broker issues one
 * single-use answer token per surface (`<channel>:<peerId>`); this router delivers cards to the
 * owner's chats, and turns button presses, `/approve <ref> approve|deny`, `/deny <ref>` and (for a
 * single open card in a 1:1 owner chat) a plain yes or no into `PermissionBroker.answer` calls.
 * Only owner identities on strong transports may answer (an SMS owner number gets an "Answer this
 * on your Mac." pointer, never a card it could answer); chat answers are always scope `once`
 * (review design-28); kinds that are device-only never get here. A pointer can be denied from chat
 * (deny is always safe) and is never approved from it.
 */

export interface ApprovalHost {
  /** Attached, active channels of a type (one per account). */
  channelsOfType(type: string): { channel: Channel; adapter: ChannelAdapter }[];
  isOwner(channel: Channel, senderId: string): boolean;
  /** Sends plain text; the id of the message it became, when the transport reports one. */
  sendText(channel: Channel, chatId: string, text: string): Promise<string | void>;
  now(): number;
  /** Notes a message the router sent through an adapter directly (the card itself). */
  recordSent?(channel: Channel, chatId: string, messageId: string): void;
  /** Whether `messageId` is still the newest message in that chat (nothing sent or received after). */
  isLastMessage?(channel: Channel, chatId: string, messageId: string): boolean;
  /** The name of a paired device (`iPhone`), for "Approved on iPhone". */
  deviceName?(deviceId: string): string | undefined;
}

interface Delivery {
  channelId: string;
  chatId: string;
  surface: string;
  answerToken: string;
  /** The card message, when the transport reported one (to edit it when the card is settled). */
  messageId?: string;
  /**
   * False for a pointer (device-only kinds, a card too long to show, sensitive arguments): the
   * chat may deny it with `/deny <ref>` but never approve it.
   */
  answerable: boolean;
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

/** What answering a card from a chat came to: the verdict, for a button press's toast. */
export interface AnswerOutcome {
  /** True when the Broker recorded the decision. */
  decided: boolean;
  /** Short text for a toast (Telegram, Slack): the real verdict, never "sent". */
  ack: string;
}

const YES_WORDS = new Set(["yes", "y", "yep", "yeah", "ok", "okay", "sure", "approve", "👍"]);
const NO_WORDS = new Set(["no", "n", "nope", "deny", "reject", "👎"]);

/** `yes`, `ok`, `no`, `👍`, `👎` (and only those, alone) as an answer; anything else is undefined. */
export function plainDecision(text: string): "approve" | "deny" | undefined {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/u, "")
    .replace(/\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (YES_WORDS.has(word)) return "approve";
  if (NO_WORDS.has(word)) return "deny";
  return undefined;
}

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
      // A weak transport (SMS) has no owner: its configured owner number gets a pointer only.
      const weak = isWeakTransport(type as Channel["type"]);
      const targets = this.#host
        .channelsOfType(type)
        .filter(({ channel }) =>
          weak ? channel.ownerIds.includes(peerId) : this.#host.isOwner(channel, peerId),
        );
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
        // A pointer: the header and "Answer this on your Mac." plus `/deny <ref>`. The chat can
        // deny it (deny is always safe) and never approve it; the token is kept for that.
        const pointer = async (text: string, reason: string): Promise<void> => {
          let messageId: string | undefined;
          try {
            const sent = await this.#host.sendText(channel, peerId, text);
            if (typeof sent === "string") messageId = sent;
          } catch {
            // A courtesy: the report carries the reason either way.
          }
          if (messageId !== undefined) this.#host.recordSent?.(channel, peerId, messageId);
          // A device-only approval is refused from chat whatever the answer: nothing to deny.
          if (!approval.deviceOnly) {
            pending.deliveries.push({
              channelId: channel.id,
              chatId: peerId,
              surface,
              answerToken,
              answerable: false,
              ...(messageId === undefined ? {} : { messageId }),
            });
          }
          reports.push({ surface, delivered: false, reason });
        };
        if (weak) {
          // Spoofable sender, plaintext carrier: the header and "Answer this on your Mac." only,
          // never the arguments, never `/approve` or `/deny`, and no delivery to answer against.
          try {
            await this.#host.sendText(
              channel,
              peerId,
              renderDevicePointer(surface, approval, { deny: false }),
            );
          } catch {
            // A courtesy, as below.
          }
          reports.push({ surface, delivered: false, reason: "weak_identity" });
          continue;
        }
        const eligibility = chatEligibility(approval, {
          allowDestructive: channelSettings(channel).allowDestructiveApprovals,
        });
        if (!eligibility.ok) {
          // The chat may not answer this one: the header and "Answer this on your Mac." only,
          // never the arguments and never an approve path (security §3.7, §9; design-12).
          await pointer(renderDevicePointer(surface, approval), eligibility.reason);
          continue;
        }
        const caps = adapter.capabilities();
        // Buttons, or reactions on the card (iMessage tapbacks): the adapter renders and tracks it.
        const buttons =
          adapter.sendApprovalButtons !== undefined && (caps.buttons || caps.reactions);
        const card = renderApprovalCard(approval, {
          surface,
          ref: approvalRef(approval.id),
          now: this.#host.now(),
          commandFallback: !buttons,
          ...(caps.maxMessageChars === undefined ? {} : { maxChars: caps.maxMessageChars }),
        });
        let messageId: string | undefined;
        try {
          if (checkOutbound(card.text, "other").action !== "allow") {
            // The card would carry a credential or identifier: the header and a pointer only.
            await pointer(renderDevicePointer(surface, approval), "sensitive_arguments");
            continue;
          }
          if (!card.answerable) {
            // Too long to show in full (or device-only): point to the Mac, accept no chat answer.
            await pointer(
              card.text,
              card.reason === "device_only" ? "device_only" : "too_long_for_chat",
            );
            continue;
          }
          if (buttons) {
            const sent = await adapter.sendApprovalButtons?.(peerId, approval, answerToken);
            messageId = sent?.messageId;
          } else {
            const sent = await this.#host.sendText(channel, peerId, card.text);
            if (typeof sent === "string") messageId = sent;
          }
        } catch (error) {
          const code = error instanceof PsycheError ? error.code : "internal";
          reports.push({ surface, delivered: false, reason: `send_failed:${code}` });
          continue;
        }
        if (messageId !== undefined) this.#host.recordSent?.(channel, peerId, messageId);
        pending.deliveries.push({
          channelId: channel.id,
          chatId: peerId,
          surface,
          answerToken,
          answerable: true,
          ...(messageId === undefined ? {} : { messageId }),
        });
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
  ): Promise<AnswerOutcome> {
    return this.#answer(channel, answer.senderId, answer.senderId, {
      approvalId: answer.approvalId,
      answerToken: answer.answerToken,
      decision: answer.decision,
    });
  }

  /** `/approve <ref> approve|deny` or `/deny <ref>` typed in `chatId`. */
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

  /**
   * A plain "yes" or "no" (or 👍 / 👎 typed) in a chat. It answers a card only when the message is
   * the owner's own, in a one-to-one chat, and exactly one card is open there; with several it
   * asks which one; with none (or only a pointer) it is not an answer and goes on to the agent.
   * `handled` means the router consumed the message.
   */
  async answerPlain(
    channel: Channel,
    chat: { chatId: string; senderId: string; isGroup: boolean; text: string },
  ): Promise<{ handled: boolean }> {
    const decision = plainDecision(chat.text);
    if (decision === undefined || chat.isGroup) return { handled: false };
    if (!CHAT_APPROVAL_CHANNELS(channel) || isWeakTransport(channel.type)) {
      return { handled: false };
    }
    if (!this.#host.isOwner(channel, chat.senderId)) return { handled: false };
    this.#prune();
    const now = this.#host.now();
    const surface = `${channel.type}:${chat.senderId}`;
    const open: { pending: Pending; delivery: Delivery }[] = [];
    for (const pending of this.#pending.values()) {
      if (Date.parse(pending.approval.expiresAt) <= now) continue;
      if (pending.approval.status !== "pending") continue;
      const delivery = pending.deliveries.find(
        (d) => d.surface === surface && d.channelId === channel.id,
      );
      if (delivery !== undefined) open.push({ pending, delivery });
    }
    const only = open[0];
    if (only === undefined) return { handled: false };
    if (open.length === 1) {
      // The one open card is a pointer (payment, purchase, credential, …): "yes" cannot answer it.
      if (!only.delivery.answerable) return { handled: false };
      await this.#answer(channel, chat.senderId, chat.chatId, {
        approvalId: only.pending.approval.id,
        answerToken: only.delivery.answerToken,
        decision,
      });
      return { handled: true };
    }
    if (!open.some((o) => o.delivery.answerable)) return { handled: false };
    await this.#host.sendText(channel, chat.chatId, channelText("whichOne"));
    return { handled: true };
  }

  /** The line a card is edited to (or followed up with) once it is settled. */
  #outcomeLine(approval: ApprovalRequest): string {
    const approved = approval.status === "approved";
    if (approved || approval.status === "denied") {
      const by = approval.decidedBy;
      if (by !== null && by !== undefined && "channel" in by) {
        return channelText(approved ? "retireApprovedChat" : "retireDeniedChat");
      }
      const name =
        by !== null && by !== undefined && "deviceId" in by
          ? this.#host.deviceName?.(by.deviceId)
          : undefined;
      if (name !== undefined && name.trim() !== "") {
        return channelText(approved ? "retireApprovedOn" : "retireDeniedOn", { device: name });
      }
      return channelText(approved ? "retireApprovedElsewhere" : "retireDeniedElsewhere");
    }
    if (approval.status === "expired") return channelText("retireExpired");
    if (approval.invalidatedReason === "run_cancelled") return channelText("retireStopped");
    return channelText("retireReplaced");
  }

  /**
   * An approval was answered, expired or cancelled: its cards in chat stop looking actionable.
   * Telegram, Slack and Discord edit the card (buttons removed); a chat that cannot edit gets one
   * short follow-up, and only when the card is still the newest message there.
   */
  async retire(approval: ApprovalRequest): Promise<void> {
    if (approval.status === "pending") return;
    const pending = this.#pending.get(approval.id);
    // Once per approval: the record stays (until it ages out) so a late press still gets the
    // Broker's "already answered", but it no longer counts as an open card.
    if (pending === undefined || pending.approval.status !== "pending") return;
    pending.approval = approval;
    const line = this.#outcomeLine(approval);
    for (const delivery of pending.deliveries) {
      const target = this.#host
        .channelsOfType(delivery.surface.slice(0, delivery.surface.indexOf(":")))
        .find(({ channel }) => channel.id === delivery.channelId);
      if (target === undefined) continue;
      const { channel, adapter } = target;
      try {
        const text = `${localizeCardText(cardHeader(approval))}\n${line}`;
        if (adapter.retireApproval !== undefined && delivery.messageId !== undefined) {
          await adapter.retireApproval(delivery.chatId, delivery.messageId, text, approval.id);
        } else if (
          delivery.messageId !== undefined &&
          this.#host.isLastMessage?.(channel, delivery.chatId, delivery.messageId) === true
        ) {
          await this.#host.sendText(channel, delivery.chatId, text);
        }
      } catch {
        // A courtesy: a card that cannot be edited stays as it was; the Broker already refuses it.
      }
    }
  }

  async #answer(
    channel: Channel,
    senderId: string,
    chatId: string,
    answer: { approvalId: string; answerToken: string; decision: "approve" | "deny" },
  ): Promise<AnswerOutcome> {
    const refuse = async (text: string): Promise<AnswerOutcome> => {
      await this.#host.sendText(channel, chatId, text);
      return { decided: false, ack: text };
    };
    if (!CHAT_APPROVAL_CHANNELS(channel)) return refuse("Answer approvals on the approval card.");
    if (isWeakTransport(channel.type) || !this.#host.isOwner(channel, senderId)) {
      return refuse("Only the owner can answer approvals.");
    }
    const pending = this.#pending.get(answer.approvalId);
    const approval = pending?.approval ?? (await this.#broker.get(answer.approvalId));
    if (answer.decision === "approve") {
      // Only a card the chat was shown in full and may answer can be approved from it. A pointer
      // (not answerable, or an ineligible kind) can be denied, never approved.
      const delivery = pending?.deliveries.find(
        (d) => d.answerToken === answer.answerToken && d.channelId === channel.id,
      );
      const eligible =
        approval === undefined ||
        chatEligibility(approval, {
          allowDestructive: channelSettings(channel).allowDestructiveApprovals,
        }).ok;
      if (!eligible || (delivery !== undefined && !delivery.answerable)) {
        return refuse("This approval can only be answered on a paired device.");
      }
    }
    try {
      const decided = await this.#broker.answer({
        ...answer,
        scope: "once",
        decidedBy: { channel: channel.type, senderId },
      });
      await this.#host.sendText(
        channel,
        chatId,
        channelText(decided.status === "approved" ? "approved" : "denied", {
          what: approvalWhat(decided),
        }),
      );
      // The card itself shows the outcome now, without waiting for the Broker's event.
      await this.retire(decided);
      return {
        decided: true,
        ack: channelText(decided.status === "approved" ? "ackApproved" : "ackDenied"),
      };
    } catch (error) {
      const text = approvalErrorReply(error);
      await this.#host.sendText(channel, chatId, text);
      return { decided: false, ack: text };
    }
  }
}
