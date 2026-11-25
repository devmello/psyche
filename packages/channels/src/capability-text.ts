import type { ChannelCapabilities } from "@psyche/protocol";
import { DiscordAdapter } from "./adapters/discord/adapter.ts";
import { EmailAdapter } from "./adapters/email/adapter.ts";
import { IMessageAdapter } from "./adapters/imessage/adapter.ts";
import { SignalAdapter } from "./adapters/signal/adapter.ts";
import { SlackAdapter } from "./adapters/slack/adapter.ts";
import { SmsAdapter } from "./adapters/sms/adapter.ts";
import { TelegramAdapter } from "./adapters/telegram/adapter.ts";
import { WebChatAdapter } from "./adapters/webchat.ts";
import { WhatsAppAdapter } from "./adapters/whatsapp/adapter.ts";

/**
 * What the agent may be told about a chat channel, derived from the one place an adapter declares
 * what it can send (`capabilities()`), so the words never drift from the adapter. A channel that
 * cannot send files says so and says not to offer them (the send itself would fail with
 * `not_implemented`).
 */
export function channelCapabilityText(
  label: string,
  caps: Pick<ChannelCapabilities, "attachments" | "voiceNotes">,
): string {
  const lines: string[] = [];
  lines.push(
    caps.attachments
      ? `${label}: files and images can be sent.`
      : `${label}: only text can be sent. Files and images are not sent here, so do not offer to attach or send one.`,
  );
  if (!caps.voiceNotes) lines.push(`${label}: voice notes are not sent.`);
  return lines.join(" ");
}

type CapabilityHolder = { prototype: { capabilities(): ChannelCapabilities } };

const ADAPTER_CLASSES: Readonly<Record<string, CapabilityHolder>> = {
  telegram: TelegramAdapter,
  discord: DiscordAdapter,
  slack: SlackAdapter,
  email: EmailAdapter,
  webchat: WebChatAdapter,
  imessage: IMessageAdapter,
  signal: SignalAdapter,
  whatsapp: WhatsAppAdapter,
  sms: SmsAdapter,
};

/**
 * What a channel type's adapter declares it can send, read from the adapter itself (its
 * `capabilities()` is a constant table), so there is one source of truth. Undefined for a type
 * this build does not know.
 */
export function channelCapabilitiesFor(type: string): ChannelCapabilities | undefined {
  return ADAPTER_CLASSES[type]?.prototype.capabilities.call({});
}

/**
 * The system-authored line for a turn in a chat on `type`, only when the adapter cannot send
 * files (nothing changes for adapters that can). Trusted text: built here from the adapter's own
 * flags, never from the chat.
 */
export function channelCapabilityNote(type: string): string | undefined {
  const caps = channelCapabilitiesFor(type);
  if (caps === undefined || caps.attachments) return undefined;
  return channelCapabilityText(type, caps);
}
