import type { VoiceConversationMode } from "@psyche/protocol";
import type { GatewayClient } from "../data/client.ts";
import type { VoiceTerminal } from "./terminal.ts";

/**
 * A voice terminal without a microphone or speaker (stories, tests): it calls the Gateway's
 * `voice.conversation.*` methods like the real one and reports synthetic levels, so the lantern
 * moves in stories and tests can assert what was sent.
 */
export class FakeVoiceTerminal implements VoiceTerminal {
  readonly calls: { method: string; params: unknown }[] = [];
  conversationId: string | null = null;
  muted = false;
  /** Fixed levels for stories (null: a slow synthetic wave). */
  fixedLevels: { input: number; output: number } | null = null;
  private readonly client: GatewayClient;
  private readonly failWith: string | null;

  constructor(client: GatewayClient, options: { failWith?: string } = {}) {
    this.client = client;
    this.failWith = options.failWith ?? null;
  }

  private call(method: string, params: unknown): void {
    this.calls.push({ method, params });
    void this.client.request(method as never, params as never).catch(() => undefined);
  }

  async start(o: {
    threadId: string | null;
    mode: VoiceConversationMode;
    listen?: { notificationId: string };
  }): Promise<string> {
    if (this.failWith) throw new Error(this.failWith);
    const params = {
      ...(o.threadId ? { threadId: o.threadId } : {}),
      mode: o.mode,
      ...(o.listen ? { listen: o.listen } : {}),
      format: { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 },
    };
    this.calls.push({ method: "voice.conversation.start", params });
    const res = (await this.client.request("voice.conversation.start", params)) as {
      conversationId: string;
    };
    this.conversationId = res.conversationId;
    return res.conversationId;
  }

  turn(action: "begin" | "end"): void {
    if (this.conversationId)
      this.call("voice.conversation.turn", { conversationId: this.conversationId, action });
  }

  mute(muted: boolean): void {
    this.muted = muted;
  }

  stopSpeaking(): void {
    if (this.conversationId)
      this.call("voice.conversation.interrupt", {
        conversationId: this.conversationId,
        stage: "confirmed",
      });
  }

  review(utteranceId: string, action: "send" | "discard", text?: string): void {
    if (this.conversationId)
      this.call("voice.conversation.review", {
        conversationId: this.conversationId,
        utteranceId,
        action,
        ...(text === undefined ? {} : { text }),
      });
  }

  end(): void {
    if (this.conversationId)
      this.call("voice.conversation.stop", { conversationId: this.conversationId });
    this.conversationId = null;
  }

  levels(): { input: number; output: number } {
    if (this.fixedLevels) return this.fixedLevels;
    const tt = Date.now() / 1000;
    const wave = 0.1 + 0.09 * Math.sin(tt * 5) * Math.sin(tt * 1.3);
    return { input: wave, output: wave };
  }
}
