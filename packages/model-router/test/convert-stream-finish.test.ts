import { describe, expect, it } from "vitest";
import { mapFinishReason } from "../src/convert-stream.ts";

describe("mapFinishReason", () => {
  it("maps every unified reason the AI SDK can emit", () => {
    expect(mapFinishReason({ unified: "stop", raw: undefined }).reason).toBe("stop");
    expect(mapFinishReason({ unified: "other", raw: undefined }).reason).toBe("stop");
    expect(mapFinishReason({ unified: "length", raw: undefined }).reason).toBe("length");
    expect(mapFinishReason({ unified: "tool-calls", raw: undefined }).reason).toBe("tool_calls");
  });

  it("treats an interrupted stream as an error, not a clean stop", () => {
    const mapped = mapFinishReason({ unified: "interrupted", raw: undefined });
    expect(mapped.reason).toBe("error");
    expect(mapped.error).toMatch(/^stream_interrupted:/);
  });
});
