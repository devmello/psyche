import { describe, expect, it } from "vitest";
import { mapFinishReason, StreamConverter } from "../src/convert-stream.ts";

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

describe("tool input drafts", () => {
  it("streams the input of render_ui only, and stops at the finished call", () => {
    const conv = new StreamConverter("anthropic", "claude-haiku-5-5");
    const start = (id: string, toolName: string) =>
      conv.push({ type: "tool-input-start", id, toolName } as never);
    const delta = (id: string, d: string) =>
      conv.push({ type: "tool-input-delta", id, delta: d } as never);
    start("c1", "render_ui");
    expect(delta("c1", '{"v":')).toEqual([
      { type: "tool_input", id: "c1", name: "render_ui", delta: '{"v":' },
    ]);
    start("c2", "write_file");
    expect(delta("c2", "x")).toEqual([]);
    conv.push({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "render_ui",
      input: "{}",
    } as never);
    expect(delta("c1", "late")).toEqual([]);
  });
});
