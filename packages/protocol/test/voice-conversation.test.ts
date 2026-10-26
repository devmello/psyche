import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApprovalAnswer,
  DictationKeyPayload,
  type ErrorCode,
  HelperSpeechVoice,
  HelperSynthesizeParams,
  Message,
  ModelRoles,
  methodSpec,
  NOTIFICATION_LISTEN_ACTION,
  PickableModelRole,
  PsycheError,
  requiresIdempotencyKey,
  VOICE_CONVERSATION_SETTING_KEYS,
  VOICE_REVIEW_MAX_CHARS,
  validateEventPayload,
  validateParams,
  validateResult,
} from "../src/index.ts";

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err.code;
    throw err;
  }
  return undefined;
}

const PCM = { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 } as const;

describe("voice.conversation.* (voice-mode-2026 §7)", () => {
  it("defines the seven methods as operator.write, none needing an idempotency key", () => {
    for (const m of [
      "voice.conversation.start",
      "voice.conversation.audio",
      "voice.conversation.turn",
      "voice.conversation.interrupt",
      "voice.conversation.played",
      "voice.conversation.review",
      "voice.conversation.stop",
    ] as const) {
      expect(methodSpec(m).scope, m).toBe("operator.write");
      expect(requiresIdempotencyKey(m), m).toBe(false);
    }
  });

  it("validates params and results", () => {
    expect(
      validateParams("voice.conversation.start", { mode: "push", format: PCM, threadId: "thr_1" }),
    ).toBeTruthy();
    expect(
      codeOf(() => validateParams("voice.conversation.start", { mode: "wake", format: PCM })),
    ).toBe("invalid_params");
    expect(
      validateResult("voice.conversation.start", {
        conversationId: "vc_1",
        engine: "mac-node",
        location: "node",
      }),
    ).toBeTruthy();
    expect(
      validateParams("voice.conversation.turn", { conversationId: "vc_1", action: "end" }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateParams("voice.conversation.turn", { conversationId: "vc_1", action: "pause" }),
      ),
    ).toBe("invalid_params");
    expect(
      validateParams("voice.conversation.interrupt", {
        conversationId: "vc_1",
        stage: "suspect",
        playedMs: 1200,
      }),
    ).toBeTruthy();
    expect(
      validateParams("voice.conversation.played", {
        conversationId: "vc_1",
        utteranceId: "u_1",
        playedMs: 900,
        done: false,
      }),
    ).toBeTruthy();
    expect(validateResult("voice.conversation.stop", { ok: true })).toEqual({ ok: true });
  });

  it("validates the five events", () => {
    expect(
      validateEventPayload("voice.conversation.state", {
        conversationId: "vc_1",
        phase: "waiting",
        reason: "approval",
        approvalId: "apr_1",
        prompt: "Send an email to alice@example.org. Say 'send it' or 'cancel'.",
        windowMs: 10_000,
        listening: true,
      }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateEventPayload("voice.conversation.state", {
          conversationId: "vc_1",
          phase: "napping",
          listening: false,
        }),
      ),
    ).toBeDefined();
    expect(
      validateEventPayload("voice.conversation.caption", {
        conversationId: "vc_1",
        role: "agent",
        utteranceId: "u_1",
        text: "You have two meetings.",
        final: false,
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload("voice.conversation.speech", {
        conversationId: "vc_1",
        utteranceId: "u_1",
        seq: 0,
        audio: "AAAA",
        format: PCM,
        last: true,
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload("voice.conversation.step", {
        conversationId: "vc_1",
        toolCallId: "tc_1",
        label: "Checking your calendar",
        status: "running",
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload("voice.conversation.ended", {
        conversationId: "vc_1",
        reason: "locked",
      }),
    ).toBeTruthy();
  });

  it("reviews a transcript before sending (spec §4.10)", () => {
    expect(
      validateEventPayload("voice.conversation.state", {
        conversationId: "vc_1",
        phase: "waiting",
        reason: "review",
        draft: "Tell Sam I'm running late",
        utteranceId: "u_2",
        listening: false,
      }),
    ).toBeTruthy();
    const review = { conversationId: "vc_1", utteranceId: "u_2" };
    expect(validateParams("voice.conversation.review", { ...review, action: "send" })).toBeTruthy();
    expect(
      validateParams("voice.conversation.review", {
        ...review,
        action: "send",
        text: "Tell Sam I'm running ten minutes late",
      }),
    ).toBeTruthy();
    expect(
      validateParams("voice.conversation.review", { ...review, action: "discard" }),
    ).toBeTruthy();
    for (const bad of [
      { ...review, action: "edit" },
      { ...review, action: "send", text: "" },
      { ...review, action: "send", text: "x".repeat(VOICE_REVIEW_MAX_CHARS + 1) },
      { conversationId: "vc_1", action: "send" },
    ]) {
      expect(codeOf(() => validateParams("voice.conversation.review", bad))).toBe("invalid_params");
    }
    expect(validateResult("voice.conversation.review", {})).toEqual({});
  });

  it("starts a conversation that first speaks a notification (Listen, spec §4.9)", () => {
    expect(NOTIFICATION_LISTEN_ACTION).toBe("listen");
    expect(
      validateParams("voice.conversation.start", {
        mode: "push",
        format: PCM,
        listen: { notificationId: "ntf_1" },
      }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateParams("voice.conversation.start", { mode: "push", format: PCM, listen: {} }),
      ),
    ).toBe("invalid_params");
  });

  it("names the settings keys under voice.conversation", () => {
    for (const key of Object.values(VOICE_CONVERSATION_SETTING_KEYS)) {
      expect(key.startsWith("voice.conversation.")).toBe(true);
    }
    expect(Object.keys(VOICE_CONVERSATION_SETTING_KEYS)).toHaveLength(14);
  });
});

describe("voice markers, the voice role and the two-key watch", () => {
  it("accepts via: voice on approval answers and messages, and nothing else", () => {
    const answer = { approvalId: "apr_1", answerToken: "tok", decision: "approve", scope: "once" };
    expect(Value.Check(ApprovalAnswer, { ...answer, via: "voice" })).toBe(true);
    expect(Value.Check(ApprovalAnswer, answer)).toBe(true);
    expect(Value.Check(ApprovalAnswer, { ...answer, via: "telepathy" })).toBe(false);
    const message = {
      id: "msg_1",
      threadId: "thr_1",
      seq: 1,
      role: "user",
      blocks: [{ type: "text", md: "what's on my calendar" }],
      providerNative: null,
      provenance: "owner",
      replyToMessageId: null,
      channelRef: null,
      runId: null,
      createdAt: "2026-10-25T10:00:00.000Z",
    };
    expect(Value.Check(Message, { ...message, via: "voice" })).toBe(true);
    expect(Value.Check(Message, message)).toBe(true);
  });

  it("adds voice to the pickable roles and to ModelRoles", () => {
    expect(Value.Check(PickableModelRole, "voice")).toBe(true);
    expect(Value.Check(ModelRoles, { primary: "anthropic/claude", voice: "anthropic/fast" })).toBe(
      true,
    );
    expect(validateParams("models.setRole", { role: "voice", ref: "anthropic/fast" })).toBeTruthy();
  });

  it("watches up to two keys with roles and keeps the single-key form", () => {
    expect(validateParams("dictation.watch", { key: "fn" })).toBeTruthy();
    expect(
      validateParams("dictation.watch", {
        key: null,
        keys: [
          { key: "fn", role: "dictation" },
          { key: "rightCommand", role: "voice" },
        ],
      }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateParams("dictation.watch", {
          key: null,
          keys: [
            { key: "fn", role: "dictation" },
            { key: "rightOption", role: "voice" },
            { key: "rightCommand", role: "voice" },
          ],
        }),
      ),
    ).toBe("invalid_params");
    expect(
      Value.Check(DictationKeyPayload, { key: "rightCommand", down: true, at: "t", role: "voice" }),
    ).toBe(true);
    expect(Value.Check(DictationKeyPayload, { key: "fn", down: false, at: "t" })).toBe(true);
  });

  it("describes the helper's speech shapes for V-H", () => {
    expect(
      Value.Check(HelperSynthesizeParams, {
        text: "Hi",
        speed: 1.25,
        utteranceId: "u_1",
        personalVoice: false,
      }),
    ).toBe(true);
    expect(Value.Check(HelperSynthesizeParams, { text: "Hi", speed: 3 })).toBe(false);
    expect(
      Value.Check(HelperSpeechVoice, {
        id: "com.apple.voice.premium.en-US.Zoe",
        name: "Zoe",
        language: "en-US",
        quality: "premium",
        personalVoice: false,
        installed: true,
      }),
    ).toBe(true);
  });
});
