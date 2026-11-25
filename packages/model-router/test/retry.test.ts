import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@psyche/protocol";
import { collect, FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCallError, type ModelErrorKind, ModelRouter } from "../src/index.ts";
import { textRequest } from "./helpers/adapters.ts";

type Attempt = ModelEvent[] | { fail: ModelErrorKind; retryAfterSec?: number };

/** A provider that plays one scripted attempt per call and reports the error like the adapter. */
class Scripted implements ModelProvider {
  readonly id = "alpha";
  calls = 0;
  readonly attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    this.attempts = attempts;
  }
  async *stream(_r: ModelRequest, options?: ModelCallOptions): AsyncIterable<ModelEvent> {
    const a = this.attempts[Math.min(this.calls, this.attempts.length - 1)] as Attempt;
    this.calls += 1;
    if (Array.isArray(a)) {
      yield* a;
      return;
    }
    const err = new ModelCallError(
      a.fail,
      "boom",
      a.retryAfterSec === undefined ? {} : { retryAfterSec: a.retryAfterSec },
    );
    (options as { onOutcome?: (o: unknown) => void } | undefined)?.onOutcome?.({ error: err });
    yield { type: "finish", reason: "error", error: err.toFinishError() };
  }
  async capabilities(): Promise<ModelCapabilities> {
    return { toolCalling: true, vision: false, reasoning: false, embeddings: false };
  }
}

const ok: ModelEvent[] = [
  { type: "text_delta", text: "hello" },
  { type: "finish", reason: "stop" },
];

function router(p: ModelProvider) {
  return new ModelRouter({
    providers: [p],
    clock: new FakeClock(),
    roles: { primary: { model: "alpha/big" } },
    retry: { random: () => 0.5 },
  });
}

const texts = (events: ModelEvent[]) =>
  events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("same-model retry of transient errors", () => {
  it("a 529 then success is one turn with no duplicate text", async () => {
    const p = new Scripted([{ fail: "overloaded" }, ok]);
    const run = collect(router(p).stream(textRequest("router/primary")));
    await vi.advanceTimersByTimeAsync(1000);
    const events = await run;
    expect(p.calls).toBe(2);
    expect(texts(events)).toBe("hello");
    expect(events.filter((e) => e.type === "finish")).toEqual([{ type: "finish", reason: "stop" }]);
  });

  it("waits retryAfterSec on a 429, capped", async () => {
    const p = new Scripted([{ fail: "rate_limited", retryAfterSec: 7 }, ok]);
    const run = collect(router(p).stream(textRequest("router/primary")));
    await vi.advanceTimersByTimeAsync(6900);
    expect(p.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(p.calls).toBe(2);
    expect(texts(await run)).toBe("hello");

    const q = new Scripted([{ fail: "rate_limited", retryAfterSec: 600 }, ok]);
    const run2 = collect(router(q).stream(textRequest("router/primary")));
    await vi.advanceTimersByTimeAsync(29_900);
    expect(q.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(q.calls).toBe(2);
    await run2;
  });

  it("gives up after three retries and fails the call", async () => {
    const p = new Scripted([{ fail: "server_error" }]);
    const run = collect(router(p).stream(textRequest("router/primary")));
    await vi.advanceTimersByTimeAsync(1000 + 3000 + 8000);
    const events = await run;
    expect(p.calls).toBe(4);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
  });

  it.each(["auth", "billing", "bad_request", "content_filter", "context_overflow"] as const)(
    "does not retry %s",
    async (kind) => {
      const p = new Scripted([{ fail: kind }, ok]);
      const run = collect(router(p).stream(textRequest("router/primary")));
      await vi.advanceTimersByTimeAsync(60_000);
      await run;
      expect(p.calls).toBe(1);
    },
  );

  it("does not retry an error after the first token, or after a tool call", async () => {
    const err: ModelEvent = { type: "finish", reason: "error", error: "server_error: reset" };
    for (const first of [
      { type: "text_delta", text: "par" },
      { type: "tool_call", id: "c1", name: "x", input: {} },
      { type: "tool_input", id: "c1", name: "x", delta: "{" },
    ] as ModelEvent[]) {
      const p = new Scripted([[first, err], ok]);
      const run = collect(router(p).stream(textRequest("router/primary")));
      await vi.advanceTimersByTimeAsync(60_000);
      const events = await run;
      expect(p.calls).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    }
  });

  it("abort during backoff stops at once", async () => {
    const p = new Scripted([{ fail: "network" }, ok]);
    const ac = new AbortController();
    const run = collect(router(p).stream(textRequest("router/primary"), { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(500);
    ac.abort();
    const events = await run;
    expect(events).toEqual([{ type: "finish", reason: "cancelled" }]);
    expect(p.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
