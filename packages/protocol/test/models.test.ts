import { describe, expect, it } from "vitest";
import {
  type MethodResult,
  methodSpec,
  requiresIdempotencyKey,
  validateParams,
  validateResult,
} from "../src/index.ts";

const provider: MethodResult<"models.probe">["provider"] = {
  id: "lmstudio",
  kind: "lmstudio",
  label: "LM Studio",
  baseURL: "http://127.0.0.1:1234/v1",
  local: true,
  keyConfigured: false,
  models: [
    {
      ref: "lmstudio/qwen3.8-27b",
      capabilities: { toolCalling: true, vision: false, contextWindow: 32768, source: "listing" },
      toolCheck: "untested",
    },
  ],
  probe: {
    state: "reachable",
    probedAt: "2026-10-19T20:00:00Z",
    latencyMs: 12,
    server: "LM Studio",
    models: [
      {
        ref: "lmstudio/qwen3.8-27b",
        id: "qwen3.8-27b",
        loaded: true,
        capabilities: { toolCalling: true, contextWindow: 32768, source: "listing" },
      },
    ],
  },
};

describe("models.* methods (B1, B4)", () => {
  it("accepts a provider list with a not_probed endpoint", () => {
    const result = {
      providers: [{ ...provider, probe: { state: "not_probed", models: [] } }],
      roles: { primary: "lmstudio/qwen3.8-27b" },
    };
    expect(() => validateResult("models.list", result)).not.toThrow();
  });

  it("accepts a probe result and rejects an unknown state", () => {
    expect(() => validateResult("models.probe", { provider })).not.toThrow();
    const bad = { provider: { ...provider, probe: { state: "maybe", models: [] } } };
    expect(() => validateResult("models.probe", bad)).toThrow();
  });

  it("validates models.setRole params and marks it side-effecting", () => {
    expect(() =>
      validateParams("models.setRole", {
        role: "utility",
        ref: "openrouter/google/gemini-3-flash",
      }),
    ).not.toThrow();
    expect(() => validateParams("models.setRole", { role: "speech", ref: "a/b" })).toThrow();
    expect(() => validateParams("models.setRole", { role: "primary", ref: "no-slash" })).toThrow();
    expect(requiresIdempotencyKey("models.setRole")).toBe(true);
    expect(methodSpec("models.probe").scope).toBe("operator.admin");
  });

  it("validates a tool-check verdict", () => {
    const result = {
      ref: "llamacpp/qwen3-8b",
      status: "chat-only",
      passed: 3,
      total: 6,
      inconclusive: false,
      probedAt: "2026-10-19T20:00:00Z",
    };
    expect(() => validateResult("models.check", { result })).not.toThrow();
  });
});
