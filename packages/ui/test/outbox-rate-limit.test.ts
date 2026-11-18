import { PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/data/client.ts";
import { ChatOutbox, type OutboxStorage } from "../src/data/outbox.ts";
import { GatewayStore } from "../src/data/store.ts";

/**
 * A queued `chat.send` answered with `rate_limited` waits out the shared gate pause and goes
 * again under the same idempotency key (the Gateway replays it, so it runs once). It gives up
 * after a few tries and stays queued; it never counts as a failed message.
 */

function memoryStorage(): OutboxStorage {
  const data = new Map<string, string>();
  return { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

const limited = (retryAfterSec: number) =>
  new PsycheError("rate_limited", "slow down", { details: { retryAfterSec }, retryable: true });

/** A client whose `chat.send` answers from a script, one entry per attempt. */
function scriptedClient(replies: Array<() => Promise<unknown>>) {
  const sends: { key: string | undefined; content: string }[] = [];
  const times: number[] = [];
  let next = 0;
  const client = {
    connectionState: () => "open",
    onConnectionState: () => () => undefined,
    subscribe: () => () => undefined,
    request: (_method: string, params: unknown, options?: { idempotencyKey?: string }) => {
      times.push(Date.now());
      sends.push({
        key: options?.idempotencyKey,
        content: (params as { content: string }).content,
      });
      const reply = replies[Math.min(next, replies.length - 1)];
      next += 1;
      return reply ? reply() : Promise.resolve({ messageId: "m1" });
    },
  } as unknown as GatewayClient;
  return { client, sends, times };
}

/**
 * Advances fake time in small steps until `p` settles. Small steps keep it from running past a
 * retry the test wants to observe later (every pause is at least a second).
 */
async function untilSettled(p: Promise<unknown>): Promise<void> {
  let done = false;
  void p.finally(() => {
    done = true;
  });
  for (let i = 0; i < 1_000 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
  }
}

const refuse = (err: unknown) => () => Promise.reject(err);
const accept = () => Promise.resolve({ messageId: "m1" });

describe("queued sends and rate_limited", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits out the pause, then sends once under the key it was queued with", async () => {
    const { client, sends } = scriptedClient([refuse(limited(2)), accept]);
    const outbox = new ChatOutbox(memoryStorage());
    const item = outbox.enqueue({ threadId: "t1", content: "hello" });
    const store = new GatewayStore(client, { outbox });

    const flushing = store.flushOutbox();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    // Not before retryAfterSec (the jitter only adds time).
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushing;

    expect(sends).toEqual([
      { key: item.key, content: "hello" },
      { key: item.key, content: "hello" },
    ]);
    expect(outbox.items()).toEqual([]);
    expect(store.getState().queue).toEqual([]);
  });

  it("gives up after a few tries and keeps the message queued, not failed", async () => {
    const { client, sends } = scriptedClient([refuse(limited(1))]);
    const outbox = new ChatOutbox(memoryStorage());
    outbox.enqueue({ threadId: "t1", content: "stuck" });
    const store = new GatewayStore(client, { outbox });

    const flushing = store.flushOutbox();
    await untilSettled(flushing);
    // Waiting out the last pause, then nothing: no failure counted, nothing shown as "not sent".
    expect(sends).toHaveLength(3);
    expect(new Set(sends.map((s) => s.key)).size).toBe(1);
    expect(outbox.items()).toHaveLength(1);
    expect(outbox.items()[0]?.failures).toBeUndefined();
    expect(store.getState().queue).toEqual([]);
    store.stop();
  });

  it("after giving up, sends once after the gate pause under the same key, then stops", async () => {
    const { client, sends, times } = scriptedClient([
      refuse(limited(2)),
      refuse(limited(2)),
      refuse(limited(2)),
      accept,
    ]);
    const outbox = new ChatOutbox(memoryStorage());
    const item = outbox.enqueue({ threadId: "t1", content: "later" });
    const store = new GatewayStore(client, { outbox });
    store.start();

    const flushing = store.flushOutbox();
    await untilSettled(flushing);
    expect(sends).toHaveLength(3);
    const gaveUpAt = times.at(-1) ?? 0;
    expect(outbox.items()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(4);
    // The retry waited for the pause that followed the last refusal (retryAfterSec = 2).
    expect((times[3] ?? 0) - gaveUpAt).toBeGreaterThanOrEqual(2_000);
    expect(sends.map((s) => s.key)).toEqual([item.key, item.key, item.key, item.key]);
    expect(outbox.items()).toEqual([]);

    // Nothing more is scheduled: no further sends after it went out.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toHaveLength(4);
    store.stop();
  });

  it("holds the messages behind a limited one, in order", async () => {
    const { client, sends } = scriptedClient([refuse(limited(3)), accept, accept]);
    const outbox = new ChatOutbox(memoryStorage());
    outbox.enqueue({ threadId: "t1", content: "first" });
    outbox.enqueue({ threadId: "t1", content: "second" });
    const store = new GatewayStore(client, { outbox });

    const flushing = store.flushOutbox();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((s) => s.content)).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushing;
    expect(sends.map((s) => s.content)).toEqual(["first", "first", "second"]);
    expect(outbox.items()).toEqual([]);
  });
});
