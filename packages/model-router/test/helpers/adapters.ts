import type { ModelRef, ModelRequest, ToolSpec } from "@psyche/protocol";
import { FakeCredentialBroker } from "@psyche/testing";
import { AiSdkAdapter, brokerKeySource, type ProviderConfig } from "../../src/index.ts";

export const weatherTool: ToolSpec = {
  name: "weather",
  description: "Current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  sideEffect: "read",
  provenanceOut: "untrusted",
};

export function textRequest(model: ModelRef): ModelRequest {
  return {
    model,
    system: "You are terse.",
    messages: [{ role: "user", parts: [{ type: "text", text: "Say hello." }] }],
    maxOutputTokens: 256,
  };
}

/**
 * Adapter over a replayed fetch. With `key`, a fake vault item bound to `key.origin` and a
 * standing `site` grant back a single auth profile, as Settings would set them up (B6).
 */
export function makeAdapter(
  config: ProviderConfig,
  fetch: typeof globalThis.fetch,
  key?: { secret: string; origin: string; slug?: string },
  broker: FakeCredentialBroker = new FakeCredentialBroker(),
): { adapter: AiSdkAdapter; broker: FakeCredentialBroker } {
  let cfg = config;
  if (key !== undefined) {
    const slug = key.slug ?? `${config.id}-key`;
    broker.add({ slug, kind: "api_key", bindings: [{ origin: key.origin }], secret: key.secret });
    broker.approve(`appr_${slug}`, { slug, origin: key.origin, scope: "site" });
    cfg = {
      ...config,
      profiles: [{ id: "main", credential: `{{cred:${slug}}}`, approvalId: `appr_${slug}` }],
    };
  }
  return { adapter: new AiSdkAdapter(cfg, { keys: brokerKeySource(broker), fetch }), broker };
}
