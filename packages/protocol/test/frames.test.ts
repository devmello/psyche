import { describe, expect, it } from "vitest";
import {
  type ErrorCode,
  errRes,
  eventFrame,
  type Frame,
  MAX_FRAME_BYTES,
  okRes,
  PsycheError,
  parseFrame,
  reqFrame,
  serializeFrame,
} from "../src/index.ts";

function rejects(raw: string): PsycheError {
  try {
    parseFrame(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe<ErrorCode>("invalid_frame");
    return err as PsycheError;
  }
  throw new Error(`expected parseFrame to reject ${raw.slice(0, 80)}`);
}

describe("parseFrame", () => {
  it("accepts every frame kind from the wire spec", () => {
    const frames: Frame[] = [
      { type: "req", id: "1", method: "threads.list" },
      {
        type: "req",
        id: "2",
        method: "chat.send",
        params: { threadId: "t" },
        idempotencyKey: "k-1",
      },
      { type: "res", id: "1", ok: true, payload: { threads: [] } },
      { type: "res", id: "1", ok: true, payload: null },
      { type: "res", id: "2", ok: false, error: { code: "not_paired", message: "pair first" } },
      {
        type: "res",
        id: "3",
        ok: false,
        error: {
          code: "rate_limited",
          message: "slow down",
          details: { retryAfterMs: 500 },
          retryable: true,
        },
      },
      { type: "event", event: "chat.delta", payload: { delta: "hi" }, seq: 0, stateVersion: 4411 },
    ];
    for (const frame of frames) expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("rejects malformed JSON", () => {
    expect(rejects("{not json").message).toMatch(/not valid JSON/);
    rejects("");
  });

  it("rejects non-object frames and unknown types", () => {
    expect(rejects("[]").message).toMatch(/JSON object/);
    rejects("null");
    rejects('"req"');
    expect(rejects('{"type":"ping","id":"1"}').message).toMatch(/unknown frame type "ping"/);
  });

  it("rejects a req without id, with an empty id or without method", () => {
    expect(rejects('{"type":"req","method":"threads.list"}').message).toMatch(/\/id/);
    rejects('{"type":"req","id":"","method":"threads.list"}');
    rejects('{"type":"req","id":"1"}');
  });

  it("rejects wrong field types", () => {
    rejects('{"type":"req","id":1,"method":"threads.list"}');
    rejects('{"type":"res","id":"1","ok":"true","payload":{}}');
    rejects('{"type":"event","event":"chat.delta","payload":{},"seq":"1","stateVersion":0}');
    rejects('{"type":"event","event":"chat.delta","payload":{},"seq":1.5,"stateVersion":0}');
    rejects('{"type":"event","event":"chat.delta","payload":{},"seq":-1,"stateVersion":0}');
    rejects('{"type":"req","id":"1","method":"m","idempotencyKey":""}');
    rejects(`{"type":"req","id":"1","method":"m","idempotencyKey":"${"k".repeat(129)}"}`);
  });

  it("rejects mixed ok/error responses, unknown error codes and extra envelope keys", () => {
    rejects('{"type":"res","id":"1","ok":true}');
    rejects(
      '{"type":"res","id":"1","ok":true,"payload":1,"error":{"code":"internal","message":"x"}}',
    );
    const err = rejects('{"type":"res","id":"1","ok":false,"error":{"code":"nope","message":"x"}}');
    expect(err.message).toMatch(/\/error\/code: Expected one of "not_implemented"/);
    rejects('{"type":"req","id":"1","method":"threads.list","token":"secret"}');
  });

  it("reports the frame id when it can, so the receiver can answer", () => {
    const err = rejects('{"type":"req","id":"abc","method":7}');
    expect(err.details).toEqual({ id: "abc" });
    expect(rejects('{"type":"req","method":7}').details).toBeUndefined();
  });

  it("enforces MAX_FRAME_BYTES in UTF-8 bytes", () => {
    const envelope = '{"type":"req","id":"1","method":"m","params":""}';
    const fits = envelope.replace('""', `"${"a".repeat(MAX_FRAME_BYTES - envelope.length)}"`);
    expect(new TextEncoder().encode(fits).length).toBe(MAX_FRAME_BYTES);
    expect(parseFrame(fits).type).toBe("req");

    const over = envelope.replace('""', `"${"a".repeat(MAX_FRAME_BYTES - envelope.length + 1)}"`);
    expect(rejects(over).message).toMatch(/limit is 1048576/);

    // Fewer UTF-16 code units than the limit, but more UTF-8 bytes.
    const multibyte = envelope.replace('""', `"${"é".repeat(MAX_FRAME_BYTES / 2)}"`);
    expect(multibyte.length).toBeLessThan(MAX_FRAME_BYTES);
    rejects(multibyte);
    const emoji = envelope.replace('""', `"${"😀".repeat(MAX_FRAME_BYTES / 4)}"`);
    expect(rejects(emoji).details).toEqual({
      bytes: MAX_FRAME_BYTES + envelope.length,
      limit: MAX_FRAME_BYTES,
    });
  });
});

describe("frame helpers", () => {
  it("round-trip through serializeFrame and parseFrame", () => {
    const frames: Frame[] = [
      reqFrame("1", "settings.get"),
      reqFrame("2", "settings.set", { key: "appearance.theme", value: "dark" }, "idem-1"),
      okRes("1", { settings: {}, stateVersion: 3 }),
      errRes("2", new PsycheError("forbidden", "needs operator.admin")),
      errRes("3", { code: "timeout", message: "slow", retryable: true }),
      eventFrame("settings.changed", { entries: [] }, 7, 3),
    ];
    for (const frame of frames) {
      const line = serializeFrame(frame);
      expect(line).not.toContain("\n");
      expect(parseFrame(line)).toEqual(frame);
    }
  });

  it("keeps an undefined payload on the wire as null", () => {
    const frame = okRes("1", undefined);
    expect(frame.payload).toBeNull();
    expect(parseFrame(serializeFrame(frame))).toEqual({
      type: "res",
      id: "1",
      ok: true,
      payload: null,
    });
    expect(eventFrame("gateway.shutdown", undefined, 0, 0).payload).toBeNull();
  });

  it("omits absent optional req fields", () => {
    expect(reqFrame("1", "threads.list")).toEqual({ type: "req", id: "1", method: "threads.list" });
  });

  it("serializes PsycheError details and retryable", () => {
    const frame = errRes(
      "9",
      new PsycheError("rate_limited", "later", { details: { n: 1 }, retryable: true }),
    );
    expect(frame.error).toEqual({
      code: "rate_limited",
      message: "later",
      details: { n: 1 },
      retryable: true,
    });
  });
});
