import { createThread, openDb } from "@psyche/db";
import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { SecretRedactor } from "@psyche/vault";
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
  const redactor = new SecretRedactor();
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
    redactor: redactor as never,
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
  return { db, redactor, id, requests, turn, texts };
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

  it("never sends part of a vault value, even one the 4,000-character cap cuts in half", async () => {
    const s = setup({ minIntervalMs: 30_000 });
    const secret = "Qz7pLm2Xw9Rt4Kv8";
    s.redactor.add(secret);
    const pad = "a ".repeat(1995); // the secret starts at offset 3990
    await s.turn(`${pad}${secret} tail`); // immediate path
    await s.turn(`${pad}${secret} tail`); // held, then flushed with the next
    await s.turn("I live in Lisbon.");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.requests).toHaveLength(2);
    for (const text of s.texts()) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(0, 6));
    }
  });

  it("masks a 32-character key split 19/13 across two held turns: no key characters reach the model", async () => {
    const s = setup({ minIntervalMs: 30_000 });
    const key = "Qz7pLm2Xw9Rt4Kv8HsB3nD6fGj1YcE5u";
    expect(key).toHaveLength(32);
    s.redactor.add(key);
    await s.turn("My sister is Maya."); // immediate; opens the window
    await s.turn(`please use ${key.slice(0, 19)}`);
    await s.turn(`${key.slice(19)} for the deploy`);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.requests).toHaveLength(2);
    const sent = s.texts().join("\n");
    // No 6-character window of the key survives anywhere in what was sent.
    for (let i = 0; i + 6 <= key.length; i++) expect(sent).not.toContain(key.slice(i, i + 6));
  });

  it("bounds the held buffer by dropping the oldest turn whole, never slicing one", async () => {
    const s = setup({ minIntervalMs: 30_000 });
    await s.turn("first, opens the window");
    const big = (c: string) => `${c} ${c.repeat(2998)}`; // 3,000 characters
    await s.turn(big("a"));
    await s.turn(big("b"));
    await s.turn(big("c"));
    await vi.advanceTimersByTimeAsync(31_000);
    const flushed = s.texts()[1] ?? "";
    expect(flushed).not.toContain("a a");
    expect(flushed).toContain("b b".slice(0, 1));
    expect(flushed.length).toBeLessThanOrEqual(4_000);
  });

  it("does not raise an unhandled rejection when the database is gone at flush time", async () => {
    const s = setup({ minIntervalMs: 30_000 });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      await s.turn("My sister is Maya.");
      await s.turn("My brother is Theo.");
      s.db.close();
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(s.requests).toHaveLength(1);
  });

  it("holds nothing from an incognito chat", async () => {
    const s = setup({ minIntervalMs: 30_000, kind: "incognito" });
    await s.turn("My sister is Maya.");
    await s.turn("My brother is Theo.");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.requests).toHaveLength(0);
  });
});
