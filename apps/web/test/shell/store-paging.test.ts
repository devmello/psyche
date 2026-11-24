import type { Message, ThreadListEntry } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { INITIAL_STATUS } from "../../src/client/status.ts";
import type { GatewayPort } from "../../src/shell/platform.ts";
import { mergeMessages, ShellStore } from "../../src/shell/store.ts";

type Handler = (params: unknown) => unknown;

/** A GatewayPort whose `call` is a plain map of handlers; every call is recorded. */
function fakeGateway(handlers: Record<string, Handler>) {
  const eventCbs = new Set<(e: GatewayEvent) => void>();
  const calls: [string, unknown][] = [];
  const port: GatewayPort = {
    getStatus: async () => INITIAL_STATUS,
    onStatus: () => () => undefined,
    onEvent: (cb) => {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    onResync: () => () => undefined,
    call: async (method, params) => {
      calls.push([method, params]);
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(method), { code: "unknown_method" });
      return h(params);
    },
  };
  return {
    port,
    calls,
    emit: (event: string, payload: unknown) => {
      for (const cb of eventCbs) cb({ event, payload, seq: 0, stateVersion: 0 });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function msg(threadId: string, seq: number): Message {
  return {
    id: `${threadId}-m${seq}`,
    threadId,
    seq,
    role: seq % 2 === 0 ? "agent" : "user",
    blocks: [{ type: "text", md: `message ${seq}` }],
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  } as unknown as Message;
}

/** Messages seq `from` through `to`, ascending. */
function range(threadId: string, from: number, to: number): Message[] {
  const out: Message[] = [];
  for (let s = from; s <= to; s++) out.push(msg(threadId, s));
  return out;
}

function entry(id: string): ThreadListEntry {
  return {
    thread: {
      id,
      kind: "side",
      title: id,
      archivedAt: null,
      lastMessageAt: null,
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    } as unknown as ThreadListEntry["thread"],
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  };
}

/**
 * A thread with 250 messages (seq 1..250) served as pages of 100 newest-first: the newest page
 * is seq 151..250 and the cursor `s151` returns 51..150, then `s51` returns 1..50 with no cursor.
 */
function historyHandler(threadId: string, total: number) {
  return (params: unknown): unknown => {
    const p = params as { threadId: string; cursor?: string };
    const before = p.cursor === undefined ? total + 1 : Number(p.cursor.slice(1));
    const from = Math.max(1, before - 100);
    const to = before - 1;
    const nextCursor = from > 1 ? `s${from}` : null;
    return { messages: range(threadId, from, to), nextCursor };
  };
}

describe("mergeMessages", () => {
  it("unions by id, sorted by seq, with the incoming copy winning", () => {
    const a = msg("t", 1);
    const b = msg("t", 2);
    const bFresh = { ...b, blocks: [{ type: "text", md: "edited" }] } as unknown as Message;
    const merged = mergeMessages([b, msg("t", 3)], [a, bFresh]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(merged[1]?.blocks).toEqual([{ type: "text", md: "edited" }]);
  });
});

describe("ShellStore chat history paging", () => {
  it("loads the newest page, then prepends older pages until the cursor ends", async () => {
    const gw = fakeGateway({ "chat.history": historyHandler("t1", 250) });
    const store = new ShellStore(gw.port);

    await store.loadHistory("t1");
    expect(store.getState().messages.t1?.map((m) => m.seq)[0]).toBe(151);
    expect(store.getState().historyCursors.t1).toBe("s151");

    await store.loadOlderMessages("t1");
    const afterFirstOlder = store.getState().messages.t1 ?? [];
    expect(afterFirstOlder.map((m) => m.seq)).toEqual(range("t1", 51, 250).map((m) => m.seq));
    expect(store.getState().historyCursors.t1).toBe("s51");

    await store.loadOlderMessages("t1");
    const all = store.getState().messages.t1 ?? [];
    expect(all.map((m) => m.seq)).toEqual(range("t1", 1, 250).map((m) => m.seq));
    expect(store.getState().historyCursors.t1).toBeNull();

    // Nothing older: no request is sent.
    const before = gw.calls.length;
    await store.loadOlderMessages("t1");
    expect(gw.calls.length).toBe(before);
    expect(store.getState().olderLoading.t1).toBeUndefined();
  });

  it("sends the cursor it holds, not the newest page again", async () => {
    const gw = fakeGateway({ "chat.history": historyHandler("t1", 250) });
    const store = new ShellStore(gw.port);
    await store.loadHistory("t1");
    await store.loadOlderMessages("t1");
    const older = gw.calls.filter((c) => c[0] === "chat.history").pop();
    expect(older?.[1]).toEqual({ threadId: "t1", cursor: "s151" });
  });

  it("dedupes an older page that repeats messages already shown", async () => {
    const gw = fakeGateway({
      "chat.history": (params: unknown) => {
        const p = params as { cursor?: string };
        if (p.cursor === undefined) return { messages: range("t1", 3, 5), nextCursor: "s3" };
        return { messages: range("t1", 1, 4), nextCursor: null };
      },
    });
    const store = new ShellStore(gw.port);
    await store.loadHistory("t1");
    await store.loadOlderMessages("t1");
    expect(store.getState().messages.t1?.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps older pages and live messages when the newest page reloads", async () => {
    const gw = fakeGateway({ "chat.history": historyHandler("t1", 250) });
    const store = new ShellStore(gw.port);
    store.start();
    await store.loadHistory("t1");
    await store.loadOlderMessages("t1");

    // A live message arrives after the newest page was read, then a reconnect reloads that page
    // (still 151..250 on the server, so 251 is only known from the live event).
    gw.emit("chat.message", { message: msg("t1", 251) });
    expect(store.getState().messages.t1?.at(-1)?.seq).toBe(251);
    await store.loadHistory("t1");

    const seqs = (store.getState().messages.t1 ?? []).map((m) => m.seq);
    expect(seqs[0]).toBe(51);
    expect(seqs[seqs.length - 1]).toBe(251);
    expect(seqs).toHaveLength(201);
    // The older cursor survives the reload.
    expect(store.getState().historyCursors.t1).toBe("s51");
  });

  it("restarts from the newest page when more than a page arrived unseen", async () => {
    // Held: pages 101..300. The server then has 301..400 newer, so the reload starts above them.
    let newestFrom = 201;
    const gw = fakeGateway({
      "chat.history": (params: unknown) => {
        const p = params as { cursor?: string };
        if (p.cursor === undefined) {
          return {
            messages: range("t1", newestFrom, newestFrom + 99),
            nextCursor: `s${newestFrom}`,
          };
        }
        return { messages: range("t1", 101, 200), nextCursor: "s101" };
      },
    });
    const store = new ShellStore(gw.port);
    await store.loadHistory("t1");
    await store.loadOlderMessages("t1");
    expect(store.getState().messages.t1?.[0]?.seq).toBe(101);
    expect(store.getState().messages.t1).toHaveLength(200);

    newestFrom = 301;
    await store.loadHistory("t1");
    expect(store.getState().messages.t1?.[0]?.seq).toBe(301);
    expect(store.getState().messages.t1).toHaveLength(100);
    expect(store.getState().historyCursors.t1).toBe("s301");
  });

  it("keeps the cursor when an older page fails, so the next scroll retries", async () => {
    let fail = true;
    const gw = fakeGateway({
      "chat.history": (params: unknown) => {
        const p = params as { cursor?: string };
        if (p.cursor === undefined) return { messages: range("t1", 151, 250), nextCursor: "s151" };
        if (fail) throw Object.assign(new Error("down"), { code: "unavailable_now" });
        return { messages: range("t1", 51, 150), nextCursor: null };
      },
    });
    const store = new ShellStore(gw.port);
    await store.loadHistory("t1");
    await store.loadOlderMessages("t1");
    expect(store.getState().historyCursors.t1).toBe("s151");
    expect(store.getState().olderLoading.t1).toBeUndefined();
    fail = false;
    await store.loadOlderMessages("t1");
    expect(store.getState().messages.t1).toHaveLength(200);
  });

  it("does not request a second page while one is in flight", async () => {
    const gw = fakeGateway({ "chat.history": historyHandler("t1", 250) });
    const store = new ShellStore(gw.port);
    await store.loadHistory("t1");
    const first = store.loadOlderMessages("t1");
    const second = store.loadOlderMessages("t1");
    await Promise.all([first, second]);
    const olderCalls = gw.calls.filter(
      (c) => c[0] === "chat.history" && "cursor" in (c[1] as object),
    );
    expect(olderCalls).toHaveLength(1);
  });

  it("drops the cursor when a thread is cleared", async () => {
    const gw = fakeGateway({ "chat.history": historyHandler("t1", 250) });
    const store = new ShellStore(gw.port);
    store.start();
    await store.loadHistory("t1");
    gw.emit("thread.cleared", { threadId: "t1" });
    expect(store.getState().historyCursors.t1).toBeUndefined();
    expect(store.getState().messages.t1).toBeUndefined();
  });
});

describe("ShellStore thread list paging", () => {
  function threadsHandler(ids: string[], pageSize: number) {
    return (params: unknown): unknown => {
      const p = params as { cursor?: string };
      const offset = p.cursor === undefined ? 0 : Number(p.cursor.slice(1));
      const slice = ids.slice(offset, offset + pageSize);
      const next = offset + pageSize < ids.length ? `o${offset + pageSize}` : null;
      return { threads: slice.map(entry), nextCursor: next };
    };
  }

  it("loads the next page, deduped by thread id, until the cursor ends", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `th${i}`);
    const gw = fakeGateway({ "threads.list": threadsHandler(ids, 50) });
    const store = new ShellStore(gw.port);
    await store.refresh();
    expect(store.getState().threads).toHaveLength(50);
    expect(store.getState().threadsCursor).toBe("o50");

    await store.loadMoreThreads();
    expect(store.getState().threads).toHaveLength(100);
    await store.loadMoreThreads();
    expect(store.getState().threads.map((x) => x.thread.id)).toEqual(ids);
    expect(store.getState().threadsCursor).toBeNull();

    const before = gw.calls.length;
    await store.loadMoreThreads();
    expect(gw.calls.length).toBe(before);
    expect(store.getState().threadsLoadingMore).toBe(false);
  });

  it("dedupes a page that repeats threads already listed", async () => {
    const gw = fakeGateway({
      "threads.list": (params: unknown) => {
        const p = params as { cursor?: string };
        if (p.cursor === undefined) return { threads: [entry("a"), entry("b")], nextCursor: "o2" };
        return { threads: [entry("b"), entry("c")], nextCursor: null };
      },
    });
    const store = new ShellStore(gw.port);
    await store.refresh();
    await store.loadMoreThreads();
    expect(store.getState().threads.map((x) => x.thread.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps threads paged in beyond the head when the list refreshes", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `th${i}`);
    let head = ids;
    const gw = fakeGateway({
      "threads.list": (params: unknown) => {
        const p = params as { cursor?: string };
        if (p.cursor === undefined)
          return { threads: head.slice(0, 50).map(entry), nextCursor: "o50" };
        return { threads: head.slice(50).map(entry), nextCursor: null };
      },
    });
    const store = new ShellStore(gw.port);
    await store.refresh();
    await store.loadMoreThreads();
    expect(store.getState().threads).toHaveLength(80);

    // A refresh with one head thread gone keeps the paged tail and drops the vanished head thread.
    head = ids.filter((id) => id !== "th3");
    await store.refresh();
    const listed = store.getState().threads.map((x) => x.thread.id);
    expect(listed).not.toContain("th3");
    expect(listed).toContain("th79");
    expect(new Set(listed).size).toBe(listed.length);
    expect(store.getState().threadsCursor).toBeNull();
  });

  it("does not drop a loaded page when a refresh returns the same head", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `th${i}`);
    const gw = fakeGateway({ "threads.list": threadsHandler(ids, 50) });
    const store = new ShellStore(gw.port);
    await store.refresh();
    await store.loadMoreThreads();
    await store.refresh();
    expect(store.getState().threads.map((x) => x.thread.id)).toEqual(ids);
  });
});

describe("ShellStore paging wiring", () => {
  it("moves a thread that updates to the top of the list", async () => {
    const gw = fakeGateway({
      "threads.list": () => ({ threads: [entry("a")], nextCursor: null }),
    });
    const store = new ShellStore(gw.port);
    store.start();
    await store.refresh();
    gw.emit("thread.updated", { thread: entry("z").thread });
    await flush();
    expect(store.getState().threads.map((x) => x.thread.id)).toEqual(["z", "a"]);
  });
});
