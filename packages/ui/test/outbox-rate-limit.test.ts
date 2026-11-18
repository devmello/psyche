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
  let next = 0;
  const client = {
    connectionState: () => "open",
    onConnectionState: () => () => undefined,
    subscribe: () => () => undefined,
    request: (_method: string, params: unknown, options?: { idempotencyKey?: string }) => {
      sends.push({
        key: options?.idempotencyKey,
        content: (params as { content: string }).content,
      });
      const reply = replies[Math.min(next, replies.length - 1)];
      next += 1;
      return reply ? reply() : Promise.resolve({ messageId: "m1" });
    },
  } as unknown as GatewayClient;
  return { client, sends };
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
    await vi.advanceTimersByTimeAsync(60_000);
    await flushing;

    expect(sends).toHaveLength(3);
    expect(new Set(sends.map((s) => s.key)).size).toBe(1);
    // Still waiting for the next trigger, with no failure counted and nothing shown as "not sent".
    expect(outbox.items()).toHaveLength(1);
    expect(outbox.items()[0]?.failures).toBeUndefined();
    expect(store.getState().queue).toEqual([]);
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
