import { describe, expect, it } from "vitest";
import { encodeFrame, MAX_FRAME_BYTES, parseWireFrame, reqFrame } from "../src/lib/frames.ts";

describe("frames", () => {
  it("builds req frames without an undefined params key", () => {
    expect(encodeFrame(reqFrame("1", "settings.get"))).toBe(
      '{"type":"req","id":"1","method":"settings.get"}',
    );
    expect(reqFrame("2", "connect", { a: 1 })).toEqual({
      type: "req",
      id: "2",
      method: "connect",
      params: { a: 1 },
    });
  });

  it("parses res ok, res error and event frames", () => {
    expect(parseWireFrame('{"type":"res","id":"1","ok":true,"payload":{"x":1}}')).toMatchObject({
      ok: true,
    });
    expect(
      parseWireFrame(
        '{"type":"res","id":"1","ok":false,"error":{"code":"not_paired","message":"m"}}',
      ),
    ).toMatchObject({ ok: false, error: { code: "not_paired" } });
    expect(
      parseWireFrame('{"type":"event","event":"e","payload":null,"seq":1,"stateVersion":0}'),
    ).toMatchObject({
      type: "event",
    });
  });

  it("rejects malformed frames", () => {
    expect(() => parseWireFrame("[]")).toThrow();
    expect(() => parseWireFrame("not json")).toThrow();
    expect(() => parseWireFrame('{"type":"res","id":"1","ok":false}')).toThrow();
    expect(() => parseWireFrame('{"type":"other"}')).toThrow();
    expect(() => parseWireFrame(" ".repeat(MAX_FRAME_BYTES + 1))).toThrow(/too large/);
  });
});
