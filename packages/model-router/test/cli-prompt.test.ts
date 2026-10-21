import type { ModelMessage } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { cliPrompt } from "../src/index.ts";

/** What a subscription-CLI run is told, from the thread's messages (#538). */

const user = (text: string): ModelMessage => ({ role: "user", parts: [{ type: "text", text }] });
const oslo: ModelMessage[] = [
  user("What is the weather in Oslo?"),
  {
    role: "assistant",
    parts: [
      { type: "tool_call", id: "call_probe_1", name: "get_weather", input: { city: "Oslo" } },
    ],
  },
  {
    role: "tool",
    parts: [
      {
        type: "tool_result",
        callId: "call_probe_1",
        name: "get_weather",
        output: { city: "Oslo", tempC: 7, condition: "sleet" },
      },
    ],
  },
];

describe("cliPrompt", () => {
  it("keeps a tool exchange that ends the history, and asks for the answer (probe uses_tool_result)", () => {
    const p = cliPrompt(oslo, "claude-code");
    expect(p.resume).toBeUndefined();
    expect(p.text).toContain("user: What is the weather in Oslo?");
    expect(p.text).toContain('assistant: [called get_weather {"city":"Oslo"}]');
    expect(p.text).toContain(
      'tool: [get_weather result: {"city":"Oslo","tempC":7,"condition":"sleet"}]',
    );
    expect(p.text).toMatch(/results are shown\. Answer the last request using those results/);
  });

  it("sends a plain new message as is", () => {
    expect(cliPrompt([user("Hi")], "claude-code").text).toBe("Hi");
  });

  it("puts a tool exchange before a new user message into the transcript", () => {
    const p = cliPrompt(
      [
        ...oslo,
        { role: "assistant", parts: [{ type: "text", text: "7°C, sleet." }] },
        user("And Bergen?"),
      ],
      "claude-code",
    );
    expect(p.text).toContain("tool: [get_weather result:");
    expect(p.text).toMatch(/<\/transcript>\n\nAnd Bergen\?$/);
  });

  it("after a resumable turn sends only what is new, results included", () => {
    const resumed: ModelMessage[] = [
      user("What is the weather in Oslo?"),
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            provider: "claude-code",
            data: { v: 1, kind: "cli-session", model: "haiku", sessionId: "s-1" },
          },
          { type: "tool_call", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } },
        ],
      },
      oslo[2] as ModelMessage,
    ];
    const p = cliPrompt(resumed, "claude-code");
    expect(p.resume).toBe("s-1");
    expect(p.text).toContain("Since your last reply");
    expect(p.text).toContain("tool: [get_weather result:");
    expect(p.text).not.toContain("What is the weather in Oslo?");
  });
});
