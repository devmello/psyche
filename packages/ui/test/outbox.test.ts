import { describe, expect, it } from "vitest";
import {
  ChatOutbox,
  type ConnectionState,
  type GatewayClient,
  GatewayRequestError,
  OUTBOX_MAX_FAILURES,
  OUTBOX_STALE_MS,
  type OutboxItem,
  type OutboxStorage,
} from "../src/data/index.ts";
import { GatewayStore } from "../src/data/store.ts";

/**
 * The `chat.send` outbox (remote-gateway design §4.5; acceptance 6): a message sent offline is
 * delivered exactly once after reconnecting, in order, under the key it was queued with.
 */

function memoryStorage(): OutboxStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

/** A Gateway that remembers keys, as `idempotency.ts` does: a repeated key replays, not reruns. */
function fakeGateway() {
  const delivered: string[] = [];
  const byKey = new Map<string, unknown>();
  return {
    delivered,
    receive(item: OutboxItem): unknown {
      const hit = byKey.get(item.key);
      if (hit !== undefined) return hit;
      delivered.push(item.params.content);
      const res = { messageId: `m${delivered.length}` };
      byKey.set(item.key, res);
      return res;
    },
  };
}

const unavailable = () => new GatewayRequestError("chat.send", "unavailable", "offline");

describe("ChatOutbox", () => {
  it("keeps what is queued across a restart, oldest first", () => {
    const storage = memoryStorage();
    const a = new ChatOutbox(storage);
    a.enqueue({ threadId: "t1", content: "one" });
    a.enqueue({ threadId: "t2", content: "two", replyToMessageId: "m9" });
    a.enqueue({ threadId: "t1", content: "three" });
    const b = new ChatOutbox(storage);
    expect(b.items().map((i) => i.params.content)).toEqual(["one", "two", "three"]);
    expect(b.items("t1").map((i) => i.params.content)).toEqual(["one", "three"]);
    expect(b.items()[1]?.params.replyToMessageId).toBe("m9");
  });

  it("gives every message its own plain idempotency key", () => {
    const o = new ChatOutbox(memoryStorage());
    const keys = [1, 2, 3].map(() => o.enqueue({ threadId: "t", content: "x" }).key);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^outbox:[A-Za-z0-9_.:-]+$/);
  });

  it("ignores a damaged store instead of failing", () => {
    const storage = memoryStorage();
    storage.set("psyche.chat-outbox.v1", "{not json");
    expect(new ChatOutbox(storage).items()).toEqual([]);
    storage.set("psyche.chat-outbox.v1", JSON.stringify([{ nope: 1 }, "x"]));
    expect(new ChatOutbox(storage).items()).toEqual([]);
  });

  it("delivers exactly once even when the connection drops after the Gateway got it", async () => {
    const gw = fakeGateway();
    const o = new ChatOutbox(memoryStorage());
    o.enqueue({ threadId: "t", content: "hello" });
    o.enqueue({ threadId: "t", content: "world" });

    // First try: the Gateway receives "hello", the answer is lost with the connection.
    let first = true;
    const r1 = await o.flush(async (item) => {
      gw.receive(item);
      if (first) {
        first = false;
        throw unavailable();
      }
    });
    expect(r1).toMatchObject({ sent: 0, blocked: true });
    expect(o.items()).toHaveLength(2);

    // Reconnect: the same key goes out again and the Gateway replays instead of re-running it.
    const r2 = await o.flush(async (item) => void gw.receive(item));
    expect(r2).toMatchObject({ sent: 2, blocked: false });
    expect(gw.delivered).toEqual(["hello", "world"]);
    expect(o.items()).toEqual([]);
    // Nothing left to send a third time.
    expect(await o.flush(async (item) => void gw.receive(item))).toMatchObject({ sent: 0 });
    expect(gw.delivered).toEqual(["hello", "world"]);
  });

  it("keeps order: a message that can't go yet holds back the ones behind it", async () => {
    const sent: string[] = [];
    const o = new ChatOutbox(memoryStorage());
    o.enqueue({ threadId: "t", content: "a" });
    o.enqueue({ threadId: "t", content: "b" });
    const r = await o.flush(async (item) => {
      if (item.params.content === "a") throw unavailable();
      sent.push(item.params.content);
    });
    expect(r.blocked).toBe(true);
    expect(sent).toEqual([]);
  });

  it("two triggers at once share one run, so nothing is sent twice", async () => {
    const o = new ChatOutbox(memoryStorage());
    o.enqueue({ threadId: "t", content: "a" });
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const send = async () => {
      calls += 1;
      await gate;
    };
    const p1 = o.flush(send);
    const p2 = o.flush(send);
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("drops a message the Gateway refuses for good and goes on with the rest", async () => {
    const o = new ChatOutbox(memoryStorage());
    o.enqueue({ threadId: "gone", content: "lost" });
    o.enqueue({ threadId: "t", content: "kept" });
    const sent: string[] = [];
    const r = await o.flush(async (item) => {
      if (item.params.threadId === "gone")
        throw new GatewayRequestError("chat.send", "not_found", "no such thread");
      sent.push(item.params.content);
    });
    expect(sent).toEqual(["kept"]);
    expect(r.dropped.map((d) => d.item.params.content)).toEqual(["lost"]);
    expect(o.items()).toEqual([]);
  });

  it("lets the owner take a waiting message back, and tells subscribers", () => {
    const o = new ChatOutbox(memoryStorage());
    let notified = 0;
    o.subscribe(() => {
      notified += 1;
    });
    const item = o.enqueue({ threadId: "t", content: "x" });
    expect(o.remove(item.key)).toBe(true);
    expect(o.remove(item.key)).toBe(false);
    expect(o.items()).toEqual([]);
    expect(notified).toBe(2);
  });
});

describe("ChatOutbox across windows, retries, age and owner", () => {
  it("two windows over one store never overwrite each other's messages", () => {
    const storage = memoryStorage();
    const a = new ChatOutbox(storage);
    const b = new ChatOutbox(storage);
    a.enqueue({ threadId: "t", content: "from a" });
    b.enqueue({ threadId: "t", content: "from b" });
    expect(a.items().map((i) => i.params.content)).toEqual(["from a", "from b"]);
    const first = a.items()[0];
    b.remove(first?.key as string);
    expect(a.items().map((i) => i.params.content)).toEqual(["from b"]);
    // A's list was stale in memory terms; its next write still keeps B's message.
    a.enqueue({ threadId: "t", content: "again a" });
    expect(b.items().map((i) => i.params.content)).toEqual(["from b", "again a"]);
  });

  it("tells subscribers when another window changed the store", () => {
    const listeners: (() => void)[] = [];
    const storage: OutboxStorage = {
      ...memoryStorage(),
      onChange: (_k, cb) => {
        listeners.push(cb);
        return () => undefined;
      },
    };
    const o = new ChatOutbox(storage);
    let heard = 0;
    o.subscribe(() => {
      heard += 1;
    });
    for (const l of listeners) l();
    expect(heard).toBe(1);
  });

  it("gives up on a message the Gateway keeps failing, but never for a lost connection", async () => {
    const o = new ChatOutbox(memoryStorage());
    o.enqueue({ threadId: "t", content: "stuck" });
    const internal = async () => {
      throw new GatewayRequestError("chat.send", "internal", "boom");
    };
    for (let i = 0; i < OUTBOX_MAX_FAILURES - 1; i++) {
      expect(await o.flush(internal)).toMatchObject({ blocked: true, dropped: [] });
    }
    const last = await o.flush(internal);
    expect(last.dropped).toHaveLength(1);
    expect(o.items()).toEqual([]);

    o.enqueue({ threadId: "t", content: "offline" });
    for (let i = 0; i < OUTBOX_MAX_FAILURES * 2; i++) {
      expect(await o.flush(async () => Promise.reject(unavailable()))).toMatchObject({
        blocked: true,
      });
    }
    expect(o.items()).toHaveLength(1);
  });

  it("asks before sending a message that waited more than a day", async () => {
    let now = Date.parse("2026-11-04T10:00:00Z");
    const o = new ChatOutbox(memoryStorage(), {
      now: () => new Date(now).toISOString(),
      nowMs: () => now,
    });
    const item = o.enqueue({ threadId: "t", content: "old news" });
    now += OUTBOX_STALE_MS + 1;
    const sent: string[] = [];
    const send = async (i: OutboxItem) => void sent.push(i.params.content);
    expect(await o.flush(send)).toMatchObject({ sent: 0, blocked: true, stale: { key: item.key } });
    expect(sent).toEqual([]);
    o.confirm(item.key);
    expect(await o.flush(send)).toMatchObject({ sent: 1 });
    expect(sent).toEqual(["old news"]);
  });

  it("holds sends until it knows whose messages these are, and drops another device's", async () => {
    const storage = memoryStorage();
    const first = new ChatOutbox(storage, { requireOwner: true });
    first.enqueue({ threadId: "t", content: "hi" });
    const sent: string[] = [];
    const send = async (i: OutboxItem) => void sent.push(i.params.content);
    expect(await first.flush(send)).toMatchObject({ blocked: true });
    first.bindOwner("dev-1");
    expect(await first.flush(send)).toMatchObject({ sent: 1 });

    // The owner forgets the Gateway and pairs again: a new device id.
    first.enqueue({ threadId: "t", content: "queued as the old device" });
    const again = new ChatOutbox(storage, { requireOwner: true });
    again.bindOwner("dev-2");
    expect(again.items()).toEqual([]);
    expect(await again.flush(send)).toMatchObject({ sent: 0 });
    expect(sent).toEqual(["hi"]);
  });
});

describe("the store's outbox", () => {
  function client() {
    let state: ConnectionState = "offline";
    const listeners = new Set<(s: ConnectionState) => void>();
    const requests: { method: string; params: unknown; key: string | undefined }[] = [];
    const c: GatewayClient = {
      request: async (method, params, options) => {
        requests.push({ method, params, key: options?.idempotencyKey });
        return {} as never;
      },
      subscribe: () => () => undefined,
      connectionState: () => state,
      onConnectionState: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    return {
      c,
      requests,
      set(next: ConnectionState) {
        state = next;
        for (const l of listeners) l(next);
      },
    };
  }

  it("sends what waited when the connection opens, under the queued key, once", async () => {
    const g = client();
    const outbox = new ChatOutbox(memoryStorage());
    const store = new GatewayStore(g.c, { outbox });
    store.start();
    const item = outbox.enqueue({ threadId: "t1", content: "while away" });
    g.set("connecting");
    g.set("open");
    await store.flushOutbox();
    const sends = g.requests.filter((r) => r.method === "chat.send");
    expect(sends).toEqual([
      {
        method: "chat.send",
        params: { threadId: "t1", content: "while away" },
        key: item.key,
      },
    ]);
    expect(outbox.items()).toEqual([]);
    store.stop();
  });

  it("sends what was left from an earlier session as soon as it starts connected", async () => {
    const g = client();
    g.set("open");
    const outbox = new ChatOutbox(memoryStorage());
    outbox.enqueue({ threadId: "t1", content: "left over" });
    const store = new GatewayStore(g.c, { outbox });
    store.start();
    await store.flushOutbox();
    expect(g.requests.filter((r) => r.method === "chat.send")).toHaveLength(1);
    store.stop();
  });

  it("shows a refused message as 'not sent' in the follow-up strip", async () => {
    const g = client();
    g.c.request = async (method) => {
      throw new GatewayRequestError(method, "not_found", "no such thread");
    };
    const outbox = new ChatOutbox(memoryStorage());
    outbox.enqueue({ threadId: "gone", content: "lost" });
    const store = new GatewayStore(g.c, { outbox });
    await store.flushOutbox();
    expect(store.getState().queue).toMatchObject([
      { threadId: "gone", content: "lost", failed: true },
    ]);
  });
});
