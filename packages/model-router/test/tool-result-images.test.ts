import type { ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/index.ts";
import { fakeKey, makeAdapter } from "./helpers/adapters.ts";

/**
 * What a tool-result screenshot looks like on the wire, per provider kind, captured with a fake
 * fetch (no network, no paid call). PR #1397 review round 2, finding 1: `@ai-sdk/openai-compatible`
 * and `ollama-ai-provider-v2` JSON.stringify a multi-part tool result, so a 750 KB screenshot
 * became a 1,000,143-character tool message.
 */
const SHOT = `iVBORw0KGgo${"A".repeat(1_000_000)}`;

function request(model: string): ModelRequest {
  return {
    model,
    system: "s",
    messages: [
      { role: "user", parts: [{ type: "text", text: "shot" }] },
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c1", name: "browser.screenshot", input: {} }],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "c1",
            name: "browser.screenshot",
            output: [
              { type: "image", mime: "image/png", data: SHOT },
              { type: "text", text: "meta" },
            ],
            provenance: "untrusted",
          },
        ],
      },
    ],
  } as unknown as ModelRequest;
}

/** The request body the adapter would send, from a fetch that records it and fails. */
async function wireBody(
  config: ProviderConfig,
  model: string,
  key?: { secret: string; origin: string },
): Promise<string> {
  const bodies: string[] = [];
  const fetch = (async (_url: string, init: { body?: unknown }) => {
    bodies.push(typeof init.body === "string" ? init.body : String(init.body));
    return new Response('{"error":{"message":"nope"}}', {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  const { adapter } = makeAdapter(config, fetch, key);
  await collect(adapter.stream(request(`${config.id}/${model}`)));
  expect(bodies).toHaveLength(1);
  return bodies[0] ?? "";
}

describe("tool-result images on the wire", () => {
  const textOnly: [string, ProviderConfig][] = [
    [
      "openai-compatible",
      { id: "vllm", kind: "openai-compatible", baseURL: "http://127.0.0.1:8000/v1" },
    ],
    ["llamacpp", { id: "llamacpp", kind: "llamacpp" }],
    ["lmstudio", { id: "lmstudio", kind: "lmstudio" }],
    ["ollama", { id: "ollama", kind: "ollama" }],
  ];
  for (const [kind, config] of textOnly) {
    it(`${kind}: no base64 in the body, a note in its place`, async () => {
      const body = await wireBody(config, "gemma4");
      expect(body).not.toContain("iVBORw0KGgo");
      expect(body.length).toBeLessThan(5_000);
      expect(body).toContain("cannot take images inside tool results");
      expect(body).toContain("meta");
    });
  }

  const native: [string, ProviderConfig, string, { secret: string; origin: string }][] = [
    [
      "anthropic",
      { id: "anthropic", kind: "anthropic" },
      "claude-haiku-5-5",
      { secret: fakeKey("anthropic"), origin: "https://api.anthropic.com" },
    ],
    [
      "openai (responses)",
      { id: "openai", kind: "openai" },
      "gpt-5.5",
      { secret: fakeKey("openai"), origin: "https://api.openai.com" },
    ],
    [
      "google (interactions)",
      { id: "google", kind: "google" },
      "gemini-4-argon",
      { secret: fakeKey("google"), origin: "https://generativelanguage.googleapis.com" },
    ],
    [
      "google (generate-content)",
      { id: "google", kind: "google", googleApi: "generate-content" },
      "gemini-3.8-flash",
      { secret: fakeKey("google"), origin: "https://generativelanguage.googleapis.com" },
    ],
    [
      "openrouter",
      { id: "openrouter", kind: "openrouter" },
      "anthropic/claude-haiku-5-5",
      { secret: fakeKey("openrouter"), origin: "https://openrouter.ai" },
    ],
  ];
  for (const [kind, config, model, key] of native) {
    it(`${kind}: the image goes as image content, not inside a JSON string`, async () => {
      const body = await wireBody(config, model, key);
      expect(body).toContain(SHOT);
      // A stringified AI SDK part would show up escaped inside a string value.
      expect(body).not.toContain('\\"mediaType\\"');
      expect(body).not.toContain('\\"type\\":\\"file\\"');
    });
  }

  it("an image link in a tool result is never passed on", async () => {
    const r = request("anthropic/claude-haiku-5-5");
    const tool = r.messages[2]?.parts[0] as { output: unknown };
    tool.output = [{ type: "image", mime: "image/png", url: "http://169.254.169.254/latest" }];
    const bodies: string[] = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response("{}", { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const { adapter } = makeAdapter({ id: "anthropic", kind: "anthropic" }, fetch, {
      secret: fakeKey("anthropic"),
      origin: "https://api.anthropic.com",
    });
    await collect(adapter.stream(r));
    expect(bodies[0]).not.toContain("169.254.169.254");
    expect(bodies[0]).toContain("cannot send an image link");
  });
});
