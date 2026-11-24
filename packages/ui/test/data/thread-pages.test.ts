import type { ThreadListEntry } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, type UiState } from "../../src/data/state.ts";
import {
  applyHeadPage,
  loadAllThreadPages,
  loadNextThreadPage,
  setPageLoading,
  type ThreadPageResult,
  type ThreadPageStore,
  threadPageKey,
} from "../../src/data/thread-pages.ts";

function entry(id: string, title = id): ThreadListEntry {
  return {
    thread: {
      id,
      kind: "side",
      title,
      archivedAt: null,
      lastMessageAt: null,
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  } as unknown as ThreadListEntry;
}

/** A Gateway stand-in: pages `ids` `size` at a time, with an opaque `o<offset>` cursor. */
function server(ids: readonly string[], size = 50) {
  return (cursor?: string): ThreadPageResult => {
    const offset = cursor === undefined ? 0 : Number(cursor.slice(1));
    const end = offset + size;
    return {
      threads: ids.slice(offset, end).map((id) => entry(id)),
      nextCursor: end < ids.length ? `o${end}` : null,
    };
  };
}

/** A store-shaped fake: `call` is mocked, `update` runs the reducer against held state. */
function fakeStore(respond: (cursor?: string) => ThreadPageResult) {
  let state: UiState = { ...INITIAL_STATE, threadPages: {}, touched: {} };
  let version = 0;
  const calls: Array<{ includeArchived: boolean; cursor?: string }> = [];
  const store = {
    getState: () => state,
    update: (fn: (s: UiState) => UiState) => {
      state = fn(state);
    },
    version: () => version,
    call: async (_method: string, params: { includeArchived: boolean; cursor?: string }) => {
      calls.push(params);
      return respond(params.cursor);
    },
  };
  return {
    store: store as unknown as ThreadPageStore,
    calls,
    get state() {
      return state;
    },
    setVersion: (v: number) => {
      version = v;
    },
    /** The first page, as `useThreads` loads it. */
    head: async (includeArchived = true) => {
      const res = respond(undefined);
      const key = threadPageKey(includeArchived);
      state = applyHeadPage(state, key, res, version);
    },
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `th${i}`);
const listed = (s: UiState) => Object.keys(s.threads);

describe("thread list paging", () => {
  it("loads the next pages until the cursor ends, merged by id", async () => {
    const f = fakeStore(server(ids(120)));
    await f.head();
    expect(f.state.threadPages.true).toEqual({ cursor: "o50", beyondHead: false, loading: false });

    expect(await loadNextThreadPage(f.store, true)).toBe(true);
    expect(listed(f.state)).toHaveLength(100);
    expect(await loadNextThreadPage(f.store, true)).toBe(true);
    expect(listed(f.state)).toEqual(ids(120));
    expect(f.state.threadPages.true?.cursor).toBeNull();

    // Nothing further: no request is sent.
    const sent = f.calls.length;
    expect(await loadNextThreadPage(f.store, true)).toBe(false);
    expect(f.calls.length).toBe(sent);
  });

  it("a reload of the first page keeps the pages already loaded beyond it", async () => {
    const f = fakeStore(server(ids(120)));
    await f.head();
    await loadNextThreadPage(f.store, true);
    await f.head();
    expect(listed(f.state)).toHaveLength(100);
    expect(f.state.threadPages.true).toEqual({ cursor: "o100", beyondHead: true, loading: false });
  });

  it("a head reload takes the head's own cursor when no page beyond it loaded", async () => {
    let list = ids(120);
    const f = fakeStore((cursor) => server(list)(cursor));
    await f.head();
    expect(f.state.threadPages.true?.cursor).toBe("o50");
    list = ids(40);
    await f.head();
    expect(f.state.threadPages.true?.cursor).toBeNull();
  });

  it("does not overwrite a thread an event touched after the request started", async () => {
    const f = fakeStore(() => ({ threads: [entry("a", "stale")], nextCursor: null }));
    f.setVersion(5);
    f.store.update((s) => ({
      ...s,
      threads: { a: entry("a", "fresh") },
      touched: { "threads:a": 9 },
    }));
    await f.head();
    expect(f.state.threads.a?.thread.title).toBe("fresh");
  });

  it("keeps the cursor and clears the loading flag when a page fails", async () => {
    let fail = false;
    const f = fakeStore((cursor) => {
      if (fail) throw new Error("down");
      return server(ids(120))(cursor);
    });
    await f.head();
    fail = true;
    expect(await loadNextThreadPage(f.store, true)).toBe(false);
    expect(f.state.threadPages.true).toEqual({ cursor: "o50", beyondHead: false, loading: false });
    fail = false;
    expect(await loadNextThreadPage(f.store, true)).toBe(true);
    expect(listed(f.state)).toHaveLength(100);
  });

  it("does not start a second page while one is in flight", async () => {
    const f = fakeStore(server(ids(120)));
    await f.head();
    const first = loadNextThreadPage(f.store, true);
    const second = loadNextThreadPage(f.store, true);
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(f.calls.filter((c) => c.cursor !== undefined)).toHaveLength(1);
  });

  it("loads every remaining page for a search", async () => {
    const f = fakeStore(server(ids(230)));
    await f.head();
    await loadAllThreadPages(f.store, true);
    expect(listed(f.state)).toEqual(ids(230));
    expect(f.state.threadPages.true?.cursor).toBeNull();
  });

  it("keeps the paging state of each includeArchived flag apart", async () => {
    const f = fakeStore(server(ids(120)));
    await f.head(true);
    await f.head(false);
    expect(f.state.threadPages.true?.cursor).toBe("o50");
    expect(f.state.threadPages.false?.cursor).toBe("o50");
    await loadNextThreadPage(f.store, false);
    expect(f.state.threadPages.true?.cursor).toBe("o50");
    expect(f.calls.at(-1)).toEqual({ includeArchived: false, cursor: "o50" });
  });

  it("marks a page in flight without a page to mark", () => {
    const s = setPageLoading({ ...INITIAL_STATE, threadPages: {} }, "true", true);
    expect(s.threadPages).toEqual({});
  });
});
