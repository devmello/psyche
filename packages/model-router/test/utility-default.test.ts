import type { ModelEvent } from "@psyche/protocol";
import { collect, FakeClock, FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { convertRequest, ModelRouter, thinkingOffFor } from "../src/index.ts";
import { textRequest } from "./helpers/adapters.ts";

const ok: ModelEvent[] = [
  { type: "text_delta", text: "x" },
  { type: "finish", reason: "stop" },
];

function routerFor(providerId: string, primary: string, utility?: string) {
  const provider = FakeModelProvider.script([ok, ok], { id: providerId });
  const router = new ModelRouter({
    providers: [provider],
    clock: new FakeClock(),
    roles: {
      primary: { model: primary },
      ...(utility === undefined ? {} : { utility: { model: utility } }),
    },
  });
  return { provider, router };
}

describe("an unset utility role", () => {
  it("resolves to Haiku 5.5 on Anthropic, with no fallback to the primary", async () => {
    const { provider, router } = routerFor("anthropic", "anthropic/claude-opus-5-5");
    expect(router.utilityRef()).toBe("anthropic/claude-haiku-5-5");
    await collect(router.stream(textRequest("router/utility")));
    expect(provider.requests[0]?.model).toBe("anthropic/claude-haiku-5-5");
    // The role itself stays unset for Settings: the default is derived, not stored.
    expect(router.role("utility")).toBeUndefined();
  });

  it("does not fall back to the primary when the cheap model fails", async () => {
    const provider = FakeModelProvider.script(
      [[{ type: "finish", reason: "error", error: "overloaded: Overloaded" }], ok],
      { id: "anthropic" },
    );
    const router = new ModelRouter({
      providers: [provider],
      clock: new FakeClock(),
      roles: { primary: { model: "anthropic/claude-opus-5-5" } },
    });
    const events = await collect(router.stream(textRequest("router/utility")));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(provider.requests.map((r) => r.model)).toEqual(["anthropic/claude-haiku-5-5"]);
  });

  it("resolves to haiku on the Claude Code subscription CLI", () => {
    const { router } = routerFor("claude-code", "claude-code/opus");
    expect(router.utilityRef()).toBe("claude-code/haiku");
  });

  it.each([
    ["codex", "codex/default"],
    ["openai", "openai/gpt-6-sol"],
    ["ollama", "ollama/qwen3.8:27b"],
  ])("keeps the primary fallback where no cheap model is listed (%s)", async (id, primary) => {
    const { provider, router } = routerFor(id, primary);
    expect(router.utilityRef()).toBeUndefined();
    await collect(router.stream(textRequest("router/utility")));
    expect(provider.requests[0]?.model).toBe(primary);
  });

  it("respects the owner's explicit pick, even when it is the expensive model", async () => {
    const own = routerFor("anthropic", "anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5");
    expect(own.router.utilityRef()).toBe("anthropic/claude-opus-5-5");
    await collect(own.router.stream(textRequest("router/utility")));
    expect(own.provider.requests[0]?.model).toBe("anthropic/claude-opus-5-5");
  });

  it("gives vision no cheap default", async () => {
    const { provider, router } = routerFor("anthropic", "anthropic/claude-opus-5-5");
    await collect(router.stream(textRequest("router/vision")));
    expect(provider.requests[0]?.model).toBe("anthropic/claude-opus-5-5");
  });
});

describe("per-route request settings", () => {
  const anthropic = (modelId: string) => ({
    config: { id: "anthropic", kind: "anthropic" as const },
    modelId,
  });
  const req = (model: string, extra: object = {}) => ({
    model: `anthropic/${model}`,
    messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }],
    ...extra,
  });
  const marked = (call: ReturnType<typeof convertRequest>) =>
    call.prompt.filter(
      (m) => (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl,
    ).length;

  it("sends effort and turns thinking off for Haiku 5.5", () => {
    const call = convertRequest(
      req("claude-haiku-5-5", { effort: "low", reasoning: "off", maxOutputTokens: 24 }),
      anthropic("claude-haiku-5-5"),
    );
    expect(call.providerOptions).toEqual({
      anthropic: { thinking: { type: "disabled" }, effort: "low" },
    });
    expect(call.maxOutputTokens).toBe(24);
  });

  it("leaves adaptive thinking alone when the request asks for nothing", () => {
    const call = convertRequest(req("claude-haiku-5-5"), anthropic("claude-haiku-5-5"));
    expect(call.providerOptions).toEqual({ anthropic: { thinking: { type: "adaptive" } } });
  });

  it.each([
    ["claude-haiku-5-5", { type: "disabled" }],
    ["claude-sonnet-5-5", { type: "between_tools" }],
    ["claude-sonnet-5", { type: "disabled" }],
    ["claude-opus-4-8", { type: "disabled" }],
    ["claude-opus-5-5", undefined],
    ["claude-fable-5-2", undefined],
  ])("thinking off on %s", (id, expected) => {
    expect(thinkingOffFor(id)).toEqual(expected);
  });

  it("keeps Opus 5.5's thinking (it cannot be disabled) and lowers effort instead", () => {
    const call = convertRequest(
      req("claude-opus-5-5", { effort: "low", reasoning: "off" }),
      anthropic("claude-opus-5-5"),
    );
    expect(call.providerOptions).toEqual({
      anthropic: { thinking: { type: "adaptive" }, effort: "low" },
    });
  });

  it("sends no effort or thinking override to models that do not take them", () => {
    const call = convertRequest(
      req("claude-haiku-4-5", { effort: "low", reasoning: "off" }),
      anthropic("claude-haiku-4-5"),
    );
    expect(call.providerOptions).toBeUndefined();
  });

  it("lets an explicit providerOptions win over the route's settings", () => {
    const call = convertRequest(
      req("claude-haiku-5-5", {
        effort: "low",
        providerOptions: { anthropic: { effort: "high" } },
      }),
      anthropic("claude-haiku-5-5"),
    );
    expect(call.providerOptions).toEqual({
      anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    });
  });

  it("marks the system prompt and the last message by default, nothing for cache: none", () => {
    const withSystem = (extra: object) =>
      req("claude-haiku-5-5", { system: "You write titles.", ...extra });
    expect(marked(convertRequest(withSystem({}), anthropic("claude-haiku-5-5")))).toBe(2);
    const none = convertRequest(withSystem({ cache: "none" }), anthropic("claude-haiku-5-5"));
    expect(marked(none)).toBe(0);
  });
});
