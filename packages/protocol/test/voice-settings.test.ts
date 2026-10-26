import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApprovalAnswer,
  DictationKeyPayload,
  type ErrorCode,
  HelperSpeechTimings,
  Message,
  methodSpec,
  PickableModelRole,
  PsycheError,
  VOICE_CONVERSATION_SETTING_KEYS,
  validateEventPayload,
  validateParams,
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

describe("talk with Psyche: speech to text only", () => {
  it("names the three settings keys under voice.conversation", () => {
    for (const key of Object.values(VOICE_CONVERSATION_SETTING_KEYS)) {
      expect(key.startsWith("voice.conversation.")).toBe(true);
    }
    expect(Object.keys(VOICE_CONVERSATION_SETTING_KEYS).sort()).toEqual([
      "enabled",
      "key",
      "reviewBeforeSend",
    ]);
  });

  it("has no spoken-reply methods or events", () => {
    for (const m of [
      "speech.readAloud",
      "speech.readAloud.cancel",
      "speech.voices",
      "voice.conversation.start",
      "voice.conversation.stop",
    ]) {
      expect(() => methodSpec(m as never), m).toThrow();
    }
    for (const e of ["speech.audio", "voice.conversation.speech", "voice.conversation.state"]) {
      expect(
        codeOf(() => validateEventPayload(e as never, {})),
        e,
      ).toBeDefined();
    }
    expect(Value.Check(PickableModelRole, "voice")).toBe(false);
    expect(Value.Check(PickableModelRole, "utility")).toBe(true);
  });

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

  it("describes the helper's transcription timings", () => {
    expect(
      Value.Check(HelperSpeechTimings, {
        firstPartialMs: { long: 700, short: 600 },
        finalizeMs: {},
      }),
    ).toBe(true);
  });
});
