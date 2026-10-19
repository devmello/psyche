import type { ModelRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { convertRequest } from "../src/convert-request.ts";
import { StreamConverter } from "../src/convert-stream.ts";
import { sanitizeToolName, ToolNameMap } from "../src/tool-names.ts";

const ctx = {
  config: { id: "anthropic", kind: "anthropic" as const },
  modelId: "claude-haiku-5-5",
};

const schema = { type: "object", properties: {} } as const;

describe("provider tool names", () => {
  it("sanitizes names Anthropic and OpenAI reject and keeps valid ones", () => {
    expect(sanitizeToolName("gmail.search")).toBe("gmail_search");
    expect(sanitizeToolName("subagent.spawn")).toBe("subagent_spawn");
    expect(sanitizeToolName("mcp__server__tool")).toBe("mcp__server__tool");
    expect(sanitizeToolName("a/b:c d")).toBe("a_b_c_d");
    expect(sanitizeToolName("x".repeat(200))).toHaveLength(128);
    expect(sanitizeToolName("…")).toBe("_");
    expect(sanitizeToolName("")).toBe("tool");
  });

  it("maps reversibly and keeps colliding names apart", () => {
    const m = new ToolNameMap();
    expect(m.toProvider("gmail.search")).toBe("gmail_search");
    expect(m.toProvider("gmail_search")).toBe("gmail_search_2");
    expect(m.toProvider("gmail.search")).toBe("gmail_search");
    expect(m.toOurs("gmail_search")).toBe("gmail.search");
    expect(m.toOurs("gmail_search_2")).toBe("gmail_search");
    expect(m.toOurs("never_seen")).toBe("never_seen");
  });

  it("renames tools, tool calls, tool results and the tool choice in the provider request", () => {
    const request: ModelRequest = {
      model: "anthropic/claude-haiku-5-5",
      messages: [
        { role: "user", parts: [{ type: "text", text: "Triage my inbox." }] },
        {
          role: "assistant",
          parts: [
            { type: "tool_call", id: "c1", name: "gmail.search", input: { query: "in:inbox" } },
          ],
        },
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "c1", name: "gmail.search", output: { messages: [] } },
          ],
        },
      ],
      tools: [
        {
          name: "gmail.search",
          description: "Search mail",
          inputSchema: schema,
          sideEffect: "read",
          provenanceOut: "untrusted",
        },
        {
          name: "library.save",
          description: "Save to the Library",
          inputSchema: schema,
          sideEffect: "none",
          provenanceOut: "trusted",
        },
      ],
      toolChoice: { tool: "library.save" },
    };
    const call = convertRequest(request, ctx);
    const tools = (call.tools ?? []).map((t) => t.name);
    expect(tools).toEqual(["gmail_search", "library_save"]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "library_save" });
    const assistant = call.prompt.find((m) => m.role === "assistant");
    const toolMsg = call.prompt.find((m) => m.role === "tool");
    expect(JSON.stringify(assistant)).toContain('"toolName":"gmail_search"');
    expect(JSON.stringify(toolMsg)).toContain('"toolName":"gmail_search"');
    expect(JSON.stringify(call)).not.toContain("gmail.search");
  });

  it("maps the provider's tool call back to the real name", () => {
    const names = ToolNameMap.for({
      tools: [{ name: "gmail.search" }],
      messages: [],
    });
    const conv = new StreamConverter("anthropic", "claude-haiku-5-5", names);
    const events = conv.push({
      type: "tool-call",
      toolCallId: "toolu_1",
      toolName: "gmail_search",
      input: JSON.stringify({ query: "in:inbox" }),
    });
    expect(events[0]).toMatchObject({ type: "tool_call", id: "toolu_1", name: "gmail.search" });
  });
});
