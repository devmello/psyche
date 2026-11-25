import { describe, expect, it } from "vitest";
import {
  channelCapabilityText,
  DiscordAdapter,
  EmailAdapter,
  IMessageAdapter,
  SignalAdapter,
  SlackAdapter,
  SmsAdapter,
  TelegramAdapter,
  WebChatAdapter,
  WhatsAppAdapter,
} from "../src/index.ts";

// `capabilities()` is a constant table per adapter; no instance state is read.
const caps = (cls: { prototype: { capabilities(): unknown } }) =>
  cls.prototype.capabilities.call({}) as Parameters<typeof channelCapabilityText>[1];

const SENDS_FILES = [
  ["telegram", TelegramAdapter],
  ["discord", DiscordAdapter],
  ["slack", SlackAdapter],
  ["email", EmailAdapter],
  ["webchat", WebChatAdapter],
] as const;
const TEXT_ONLY = [
  ["imessage", IMessageAdapter],
  ["signal", SignalAdapter],
  ["whatsapp", WhatsAppAdapter],
  ["sms", SmsAdapter],
] as const;

describe("channel capability text", () => {
  it.each(TEXT_ONLY)("%s: says files are not sent, matching the adapter", (name, cls) => {
    expect(caps(cls).attachments).toBe(false);
    expect(channelCapabilityText(name, caps(cls))).toContain("do not offer to attach");
  });

  it.each(SENDS_FILES)("%s: says files can be sent, matching the adapter", (name, cls) => {
    expect(caps(cls).attachments).toBe(true);
    const text = channelCapabilityText(name, caps(cls));
    expect(text).toContain("files and images can be sent");
    expect(text).not.toContain("do not offer");
  });
});
