import { APPLE_ON_DEVICE_REF, type ModelEvent, type ModelRequest } from "@psyche/protocol";
import { collect, FakeAppleLlmNode, FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  AppleOnDeviceAdapter,
  applyPrompt,
  createModelRouter,
  isLocalKind,
  type ModelRouter,
} from "../src/index.ts";

// Nothing here reaches Apple's real model: the helper is `FakeAppleLlmNode`.

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: APPLE_ON_DEVICE_REF,
  messages: [{ role: "user", parts: [{ type: "text", text: "What did Maya send in March?" }] }],
  ...over,
});

const adapterFor = (node: FakeAppleLlmNode | undefined) =>
  new AppleOnDeviceAdapter({ id: "apple", kind: "apple" }, { node: () => node });

const finish = (events: ModelEvent[]) =>
  events.find((e) => e.type === "finish") as { reason: string; error?: string };

describe("AppleOnDeviceAdapter", () => {
  it("is a local, tool-less, 4,096-token model", async () => {
    expect(isLocalKind("apple")).toBe(true);
    const caps = await adapterFor(undefined).capabilities();
    expect(caps).toMatchObject({ toolCalling: false, vision: false, contextWindow: 4096 });
  });

  it("sends one prompt with the system text as instructions and returns the reply", async () => {
    const node = new FakeAppleLlmNode();
    node.replies = ["Maya sent the lease."];
    const events = await collect(
      adapterFor(node).stream(
        request({ system: "Answer briefly.", maxOutputTokens: 200, temperature: 0 }),
      ),
    );
    expect(node.requests).toEqual([
      {
        prompt: "What did Maya send in March?",
        instructions: "Answer briefly.",
        maxTokens: 200,
        temperature: 0,
      },
    ]);
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Maya sent the lease." },
    ]);
    expect(finish(events).reason).toBe("stop");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ usage: { costUsd: 0 } });
  });

  it("passes providerOptions.apple.schema for guided generation and never sends tools", async () => {
    const node = new FakeAppleLlmNode();
    node.replies = ['{"terms":["lease"]}'];
    const schema = {
      type: "object",
      properties: { terms: { type: "array", items: { type: "string" } } },
    };
    await collect(
      adapterFor(node).stream(
        request({
          providerOptions: { apple: { schema } },
          tools: [
            {
              name: "t",
              description: "",
              inputSchema: {},
              sideEffect: "none",
              provenanceOut: "trusted",
            },
          ],
        }),
      ),
    );
    expect(node.requests[0]?.schema).toEqual(schema);
    expect(JSON.stringify(node.requests[0])).not.toContain('"tools"');
  });

  it("flattens several turns and drops tool results", () => {
    const { prompt } = applyPrompt(
      request({
        messages: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          { role: "assistant", parts: [{ type: "text", text: "hello" }] },
          { role: "tool", parts: [{ type: "tool_result", callId: "1", output: "secret" }] },
          { role: "user", parts: [{ type: "text", text: "and?" }] },
        ],
      }),
    );
    expect(prompt).toBe("User: hi\n\nAssistant: hello\n\nUser: and?");
  });

  it("fails closed with a clear error when no Mac helper is connected", async () => {
    const f = finish(await collect(adapterFor(undefined).stream(request())));
    expect(f.reason).toBe("error");
    expect(f.error).toMatch(/^model_not_found: .*Mac helper/);
  });

  it("turns every refusal into a router error kind, with the reason", async () => {
    const cases: [string, string][] = [
      ["too_long", "context_overflow"],
      ["context_exceeded", "context_overflow"],
      ["guardrail", "content_filter"],
      ["unsupported_language", "bad_request"],
      ["unsupported_schema", "bad_request"],
      ["rate_limited", "rate_limited"],
      ["timed_out", "timeout"],
      ["failed", "unknown"],
    ];
    for (const [refusal, kind] of cases) {
      const node = new FakeAppleLlmNode();
      node.refuse = refusal as never;
      const f = finish(await collect(adapterFor(node).stream(request())));
      expect(f.error?.startsWith(`${kind}:`), refusal).toBe(true);
    }
    const off = new FakeAppleLlmNode();
    off.availability = {
      available: false,
      reason: "apple_intelligence_not_enabled",
      contextTokens: 4096,
    };
    const f = finish(await collect(adapterFor(off).stream(request())));
    expect(f.error).toMatch(/^model_not_found: .*Apple Intelligence is turned off/);
    expect(off.requests).toEqual([]);
  });

  it("refuses an over-long prompt without cutting it", async () => {
    const node = new FakeAppleLlmNode();
    const long = request({
      messages: [{ role: "user", parts: [{ type: "text", text: "x".repeat(9001) }] }],
    });
    const f = finish(await collect(adapterFor(node).stream(long)));
    expect(f.error).toMatch(/^context_overflow:/);
    expect(node.requests).toEqual([]);
  });

  it("reads availability without generating", async () => {
    const node = new FakeAppleLlmNode();
    expect(await adapterFor(node).availability()).toMatchObject({ available: true });
    expect(await adapterFor(undefined).availability()).toBeUndefined();
    expect(node.requests).toEqual([]);
  });

  it("is built by createModelRouter for kind apple and routed as apple/on-device", async () => {
    const node = new FakeAppleLlmNode();
    node.replies = ["pong"];
    const router: ModelRouter = createModelRouter(
      { providers: [{ id: "apple", kind: "apple" }] },
      { clock: new FakeClock(0), apple: { node: () => node } },
    );
    expect(router.provider("apple")).toBeInstanceOf(AppleOnDeviceAdapter);
    const events = await collect(router.stream(request()));
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(node.requests.length).toBe(1);
  });
});
