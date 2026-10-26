import { describe, expect, it } from "vitest";
import {
  AppleCalendarChangedEvent,
  AppleCalendarWatchParams,
  createValidator,
  SPEECH_FILE_CAPABILITIES,
  SPEECH_FILE_MAX_DURATION_MS,
  SpeechProgressEvent,
  SpeechTranscribeFileParams,
  SpeechTranscribeFileResult,
} from "../src/index.ts";

/** Long-form transcription and calendar.changed (docs/workflows/mail-and-meetings-2026.md §8.4). */

const check = (schema: Parameters<typeof createValidator>[0], value: unknown) =>
  createValidator(schema).check(value);

describe("speech.transcribe_file", () => {
  it("accepts a path with the 4-hour ceiling and refuses more", () => {
    expect(check(SpeechTranscribeFileParams, { path: "/Users/o/Recordings/standup.m4a" })).toBe(
      true,
    );
    expect(
      check(SpeechTranscribeFileParams, {
        path: "/Users/o/Recordings/standup.m4a",
        locale: "en-US",
        vocabulary: ["Psyche"],
        maxDurationMs: SPEECH_FILE_MAX_DURATION_MS,
      }),
    ).toBe(true);
    expect(
      check(SpeechTranscribeFileParams, {
        path: "/x.m4a",
        maxDurationMs: SPEECH_FILE_MAX_DURATION_MS + 1,
      }),
    ).toBe(false);
    expect(check(SpeechTranscribeFileParams, { path: "" })).toBe(false);
    expect(check(SpeechTranscribeFileParams, { path: "/x.m4a", source: "microphone" })).toBe(false);
  });

  it("result and progress shapes", () => {
    expect(
      check(SpeechTranscribeFileResult, {
        text: "hello there",
        segments: [{ text: "hello there", startMs: 600_000, endMs: 601_200, final: true }],
        engine: "speechAnalyzer",
        language: "en-US",
        audioMs: 10_800_000,
        chunks: 18,
      }),
    ).toBe(true);
    expect(
      check(SpeechProgressEvent, {
        type: "speech.progress",
        processedMs: 600_000,
        totalMs: 10_800_000,
        fraction: 0.056,
        chunk: 1,
        chunks: 18,
      }),
    ).toBe(true);
    expect(SPEECH_FILE_CAPABILITIES.map((c) => c.name)).toEqual(["speech.transcribe_file"]);
  });
});

describe("calendar.watch", () => {
  it("takes no params and emits calendar.changed", () => {
    expect(check(AppleCalendarWatchParams, {})).toBe(true);
    expect(check(AppleCalendarWatchParams, { calendarIds: [] })).toBe(false);
    expect(
      check(AppleCalendarChangedEvent, {
        type: "calendar.changed",
        at: "2026-10-25T10:00:30.000Z",
        coalesced: 3,
      }),
    ).toBe(true);
    expect(
      check(AppleCalendarChangedEvent, { type: "calendar.changed", at: "x", coalesced: 0 }),
    ).toBe(false);
  });
});
