import { createThread, openDb } from "@psyche/db";
import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserProfile, LEARN_SYSTEM, MAX_TEXT_CHARS } from "../src/compose/user-profile.ts";

/**
 * The profile learner is a background call after every owner message: it must be capped (input
 * and output), cheap per request, and sent once per window rather than once per message.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(over: { minIntervalMs?: number; kind?: "main" | "incognito" } = {}) {
  const db = openDb(":memory:");
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    capabilities: async () => ({}) as never,
    async *stream(req): AsyncIterable<ModelEvent> {
      requests.push(req);
      yield { type: "text_delta", text: '{"facts":[]}' };
      yield { type: "finish", reason: "stop" };
    },
  };
  const profile = createUserProfile({
    db,
    home: "/nonexistent",
    memory: {} as never,
    provider,
    model: "router/utility",
    active: true,
    ...(over.minIntervalMs === undefined ? {} : { minIntervalMs: over.minIntervalMs }),
    redactor: { redact: (s: string) => s } as never,
    audit: { append: async () => undefined } as never,
    broker: {} as never,
    surfaces: ["desktop"],
    publish: () => undefined,
  });
  const id = db.newId();
  createThread(db, { id, kind: over.kind ?? "side", sessionKey: `k:${id}` } as never);
  const turn = (ownerText: string) =>
    profile.onOwnerTurn({ threadId: id, runId: `run_${requests.length}`, ownerText });
  const texts = () =>
    requests.map((r) => {
      const part = r.messages[0]?.parts[0];
      return part?.type === "text" ? part.text : "";
    });
  return { requests, turn, texts };
}

describe("profile learner request", () => {
  it("caps the input and the output, and asks for a cheap one-shot", async () => {
    const s = setup();
    await s.turn(`My sister Maya lives in Lisbon. ${"x".repeat(20_000)}`);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.system).toBe(LEARN_SYSTEM);
    expect(s.texts()[0]?.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(s.requests[0]).toMatchObject({
      maxOutputTokens: 400,
      effort: "low",
      reasoning: "off",
      cache: "none",
    });
  });
});

describe("profile learner batching", () => {
  it("learns at once with no window set (every turn, as before)", async () => {
    const s = setup();
    await s.turn("My sister is Maya.");
    await s.turn("My brother is Theo.");
    expect(s.requests).toHaveLength(2);
  });

  it("sends the first turn at once and the turns inside the window together", async () => {
    const s = setup({ minIntervalMs: 30_000 });
    await s.turn("My sister is Maya.");
    expect(s.requests).toHaveLength(1);
    await s.turn("My brother is Theo.");
    await s.turn("I live in Lisbon.");
    expect(s.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(s.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(s.requests).toHaveLength(2);
    expect(s.texts()[1]).toContain("My brother is Theo.");
    expect(s.texts()[1]).toContain("I live in Lisbon.");
    // The window restarts after the batch; a quiet window later the next turn goes at once.
    await vi.advanceTimersByTimeAsync(60_000);
    await s.turn("I prefer tea.");
    expect(s.requests).toHaveLength(3);
    expect(s.texts()[2]).toBe("I prefer tea.");
  });

  it("holds nothing from an incognito chat", async () => {
    const s = setup({ minIntervalMs: 30_000, kind: "incognito" });
    await s.turn("My sister is Maya.");
    await s.turn("My brother is Theo.");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.requests).toHaveLength(0);
  });
});
