import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type ConformanceFactory, collect, newContext } from "./harness.ts";

export interface ModelProviderConformanceOptions {
  /** Request sent by every test (default: one user text message to `<id>/conformance`). */
  request?: (providerId: string) => ModelRequest;
}

function defaultRequest(providerId: string): ModelRequest {
  return {
    model: `${providerId}/conformance`,
    system: "You are a test.",
    messages: [{ role: "user", parts: [{ type: "text", text: "Say ok." }] }],
    maxOutputTokens: 16,
  };
}

/** Architecture §4.4: stream invariants every provider adapter keeps. */
export function describeModelProviderConformance(
  name: string,
  factory: ConformanceFactory<ModelProvider>,
  options: ModelProviderConformanceOptions = {},
): void {
  const request = options.request ?? defaultRequest;
  const setup = async () => {
    const provider = await factory(newContext());
    return { provider, req: request(provider.id) };
  };

  describe(`ModelProvider conformance: ${name}`, () => {
    it("ends with exactly one finish event, and it is last", async () => {
      const { provider, req } = await setup();
      const events = await collect(provider.stream(req));
      const finishes = events.filter((e) => e.type === "finish");
      expect(finishes).toHaveLength(1);
      expect(events[events.length - 1]?.type).toBe("finish");
    });

    it("emits well-formed events", async () => {
      const { provider, req } = await setup();
      for (const e of await collect(provider.stream(req))) {
        if (e.type === "text_delta") expect(typeof e.text).toBe("string");
        if (e.type === "tool_call") {
          expect(e.id.length).toBeGreaterThan(0);
          expect(e.name.length).toBeGreaterThan(0);
          expect(() => JSON.stringify(e.input)).not.toThrow();
        }
        if (e.type === "usage") {
          for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
            expect(Number.isInteger(e.usage[k])).toBe(true);
            expect(e.usage[k]).toBeGreaterThanOrEqual(0);
          }
          expect(e.usage.costUsd).toBeGreaterThanOrEqual(0);
        }
        if (e.type === "reasoning") expect(typeof e.provider).toBe("string");
      }
    });

    it("does not mutate the request", async () => {
      const { provider, req } = await setup();
      const before = structuredClone(req);
      await collect(provider.stream(req));
      expect(req).toEqual(before);
    });

    it("ends with finish{cancelled} instead of throwing when the signal is already aborted", async () => {
      const { provider, req } = await setup();
      const ac = new AbortController();
      ac.abort();
      const events = await collect(provider.stream(req, { signal: ac.signal }));
      const last = events[events.length - 1];
      expect(last).toEqual(expect.objectContaining({ type: "finish", reason: "cancelled" }));
      expect(events.some((e) => e.type === "text_delta")).toBe(false);
    });

    it("ends with finish{cancelled} when aborted mid-stream", async () => {
      const { provider, req } = await setup();
      const ac = new AbortController();
      const events: ModelEvent[] = [];
      for await (const e of provider.stream(req, { signal: ac.signal })) {
        events.push(e);
        if (events.length === 1 && e.type !== "finish") ac.abort();
      }
      if (events[0]?.type === "finish") return; // a one-event stream cannot be interrupted
      expect(events[events.length - 1]).toEqual(
        expect.objectContaining({ type: "finish", reason: "cancelled" }),
      );
    });

    it("reports capabilities", async () => {
      const { provider, req } = await setup();
      const caps = await provider.capabilities(req.model);
      for (const k of ["toolCalling", "vision", "reasoning", "embeddings"] as const) {
        expect(typeof caps[k]).toBe("boolean");
      }
    });

    it("embeds one equal-length vector per text when embed is offered", async () => {
      const { provider } = await setup();
      if (provider.embed === undefined) return;
      const vectors = await provider.embed(["alpha", "beta gamma"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]?.length).toBeGreaterThan(0);
      expect(vectors[0]?.length).toBe(vectors[1]?.length);
    });
  });
}
