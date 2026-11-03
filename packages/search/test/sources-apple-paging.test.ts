import { describe, expect, it } from "vitest";
import {
  type AppleSourceDeps,
  calendarAdapter,
  isExcluded,
  mailAdapter,
  messagesAdapter,
  notesAdapter,
  remindersAdapter,
  type SourceAdapter,
  type SourceItem,
  type ToolCall,
} from "../src/index.ts";
import { DAY, NOW } from "./helpers.ts";

/**
 * The Apple tools answer at most 500 rows a call (`limit` 1–500, else "limit must be 1–500"), and
 * Mail's own search gives up on a wide range ("Mail search took too long"). These read a source
 * larger than one call can return, through fakes: nothing real is read.
 */

type Obj = Record<string, unknown>;
const signal = new AbortController().signal;

/** Pulls until the adapter says it is done; returns every item and every cursor it handed back. */
async function drain(adapter: SourceAdapter, start: unknown = null, limit = 100) {
  const items: SourceItem[] = [];
  let cursor = start;
  let pulls = 0;
  for (;;) {
    const page = await adapter.pull(cursor, { signal, limit });
    items.push(...page.items);
    cursor = page.cursor;
    pulls += 1;
    if (!page.hasMore) return { items, cursor, pulls };
    if (pulls > 500) throw new Error("the adapter never finished");
  }
}

const check = (p: Obj) => {
  const limit = Number(p.limit ?? 50);
  if (!(limit >= 1 && limit <= 500)) throw new Error("limit must be 1–500");
  return limit;
};

function deps(call: ToolCall, now = NOW): AppleSourceDeps {
  return {
    call: () => call,
    helper: () => undefined,
    ownAddresses: () => [],
    now: () => now,
  };
}

describe("notes", () => {
  const notes = (n: number): Obj[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      title: `Note ${i}`,
      folder: "Notes",
      // Older ids are older notes.
      modified: new Date(NOW - (n - i) * 60_000).toISOString(),
    }));

  function fake(rows: () => Obj[], opts: { honourOffset?: boolean } = {}) {
    const lists: Obj[] = [];
    const call: ToolCall = async (tool, p) => {
      if (tool === "notes_list") {
        const limit = check(p);
        lists.push(p);
        const offset = opts.honourOffset === false ? 0 : Number(p.offset ?? 0);
        return { notes: rows().slice(offset, offset + limit) };
      }
      if (tool === "notes_read") return { text: `body of ${String(p.id)}` };
      throw new Error(`no ${tool}`);
    };
    return { call, lists };
  }

  it("lists a library of more than 500 notes over several calls and indexes every one", async () => {
    const all = notes(1234);
    const f = fake(() => all);
    const adapter = notesAdapter(deps(f.call));
    const { items } = await drain(adapter);
    expect(items).toHaveLength(1234);
    expect(new Set(items.map((i) => i.nativeId)).size).toBe(1234);
    // Never above the connector's cap, and the list is walked once for the whole pass.
    expect(f.lists.every((p) => Number(p.limit) <= 500)).toBe(true);
    expect(f.lists.map((p) => p.offset ?? 0)).toEqual([0, 500, 1000]);
  });

  it("follows what changed afterwards, and lists again for each new pass", async () => {
    const all = notes(700);
    const f = fake(() => all);
    const adapter = notesAdapter(deps(f.call));
    const first = await drain(adapter);
    expect(first.items).toHaveLength(700);
    all[3] = { ...(all[3] as Obj), modified: new Date(NOW + 1000).toISOString() };
    const second = await drain(adapter, first.cursor);
    expect(second.items.map((i) => i.nativeId)).toEqual(["n3"]);
  });

  it("lists every id for the sweep, and says so when the helper cannot page", async () => {
    const all = notes(1100);
    const ok = await notesAdapter(deps(fake(() => all).call)).listIds?.(signal);
    expect(ok?.ids).toHaveLength(1100);
    expect(ok?.complete).toBe(true);
    // A helper that ignores `offset` returns the first page again: a partial list deletes nothing.
    const stale = await notesAdapter(deps(fake(() => all, { honourOffset: false }).call)).listIds?.(
      signal,
    );
    expect(stale?.ids).toHaveLength(500);
    expect(stale?.complete).toBe(false);
  });

  it("never asks the connector for more than 500", async () => {
    const f = fake(() => notes(10));
    await drain(notesAdapter(deps(f.call)));
    await notesAdapter(deps(f.call)).listIds?.(signal);
    expect(f.lists.length).toBeGreaterThan(0);
    expect(f.lists.every((p) => Number(p.limit) === 500)).toBe(true);
  });
});

describe("reminders", () => {
  it("reads open and done reminders past 500 each", async () => {
    const rows = (completed: boolean, n: number): Obj[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `${completed ? "d" : "o"}${i}`,
        title: `R ${i}`,
        completed,
      }));
    const open = rows(false, 1100);
    const done = rows(true, 600);
    const calls: Obj[] = [];
    const call: ToolCall = async (tool, p) => {
      if (tool !== "reminders_list") throw new Error(`no ${tool}`);
      const limit = check(p);
      calls.push(p);
      const list = p.completed === true ? done : open;
      const offset = Number(p.offset ?? 0);
      return { reminders: list.slice(offset, offset + limit) };
    };
    const adapter = remindersAdapter(deps(call));
    const { items } = await drain(adapter);
    expect(items).toHaveLength(1700);
    expect(items.filter((i) => i.tags?.includes("done"))).toHaveLength(600);
    expect(calls.every((p) => Number(p.limit) <= 500)).toBe(true);
    const ids = await adapter.listIds?.(signal);
    expect(ids?.ids).toHaveLength(1700);
    expect(ids?.complete).toBe(true);
  });
});

describe("calendar", () => {
  const event = (i: number, at: number): Obj => ({
    id: `e${i}`,
    title: `Event ${i}`,
    start: new Date(at).toISOString(),
  });

  function fake(events: Obj[]) {
    const calls: { from: number; to: number; limit: number }[] = [];
    const call: ToolCall = async (tool, p) => {
      if (tool !== "calendar_list_events") throw new Error(`no ${tool}`);
      const limit = check(p);
      const from = Date.parse(String(p.from));
      const to = Date.parse(String(p.to));
      calls.push({ from, to, limit });
      return {
        events: events
          .filter((e) => Date.parse(String(e.start)) >= from && Date.parse(String(e.start)) < to)
          .slice(0, limit),
      };
    };
    return { call, calls };
  }

  it("splits a window that fills the page, so a busy year is read whole", async () => {
    // 1,300 events over the last year: more than two pages, in one of the connector's windows.
    const events = Array.from({ length: 1300 }, (_, i) => event(i, NOW - ((i % 360) + 1) * DAY));
    const f = fake(events);
    const { items } = await drain(calendarAdapter(deps(f.call)));
    expect(new Set(items.map((i) => i.nativeId)).size).toBe(1300);
    expect(f.calls.every((c) => c.limit <= 500)).toBe(true);
    expect(f.calls.length).toBeGreaterThan(4);
  });

  it("does not split forever when 500 events span the whole range: a few calls, and partial", async () => {
    // Events that overlap every half of every range (a year-long block, say), as the helper lists
    // overlapping events: each half returns the same full page.
    const spanning = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      title: `All year ${i}`,
      start: new Date(NOW - 1000 * DAY).toISOString(),
      end: new Date(NOW + 1000 * DAY).toISOString(),
    }));
    let calls = 0;
    const call: ToolCall = async (tool, p) => {
      if (tool !== "calendar_list_events") throw new Error(`no ${tool}`);
      calls += 1;
      return { events: spanning.slice(0, check(p)) };
    };
    const adapter = calendarAdapter(deps(call));
    const pass = await drain(adapter);
    expect(new Set(pass.items.map((i) => i.nativeId)).size).toBe(500);
    // Four windows, a handful of calls each (the unsplit read and its two halves), not 2^14.
    expect(calls).toBeLessThanOrEqual(4 * 3);
    calls = 0;
    const ids = await adapter.listIds?.(signal);
    expect(calls).toBeLessThanOrEqual(4 * 3);
    expect(ids?.complete).toBe(false);
    expect(ids?.ids).toHaveLength(2000);
  });

  it("caps the calls for one window even when every half is full and different", async () => {
    // 100,000 events, one every 5 minutes: every split is full. The cap ends it.
    let calls = 0;
    const call: ToolCall = async (tool, p) => {
      if (tool !== "calendar_list_events") throw new Error(`no ${tool}`);
      calls += 1;
      const from = Date.parse(String(p.from));
      const to = Date.parse(String(p.to));
      const rows: Obj[] = [];
      for (
        let t = Math.ceil(from / 300_000) * 300_000;
        t < to && rows.length < check(p);
        t += 300_000
      )
        rows.push({ id: `e${t}`, title: "x", start: new Date(t).toISOString() });
      return { events: rows };
    };
    await calendarAdapter(deps(call)).pull(null, { signal, limit: 100 });
    expect(calls).toBeLessThanOrEqual(40);
  });

  it("says a listing is partial when 500 events share one hour", async () => {
    const events = Array.from({ length: 600 }, (_, i) => event(i, NOW - 10 * DAY + i));
    const ids = await calendarAdapter(deps(fake(events).call)).listIds?.(signal);
    expect(ids?.complete).toBe(false);
    const few = await calendarAdapter(deps(fake(events.slice(0, 40)).call)).listIds?.(signal);
    expect(few).toMatchObject({ complete: true });
    expect(few?.ids).toHaveLength(40);
  });
});

describe("mail", () => {
  /** A mailbox of `dates` (ms), answering like the helper: `since` inclusive, `until` exclusive. */
  function mailbox(dates: number[], opts: { slowOver?: number; busyFor?: number } = {}) {
    const rows = dates.map((at, i) => ({
      id: `m${i}`,
      subject: `Mail ${i}`,
      from: "Sam <sam@example.com>",
      date: new Date(at).toISOString(),
    }));
    const searches: { since?: number; until?: number; limit: number }[] = [];
    let timeouts = 0;
    const call: ToolCall = async (tool, p) => {
      if (tool === "mail_read") return { body: `body of ${String(p.id)}` };
      if (tool !== "mail_search") throw new Error(`no ${tool}`);
      const limit = check(p);
      const since = typeof p.since === "string" ? Date.parse(p.since) : undefined;
      const until = typeof p.until === "string" ? Date.parse(p.until) : undefined;
      searches.push({
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        limit,
      });
      // Mail's own search gives up on a wide range, and on an open one (no `since`).
      const span = (until ?? NOW) - (since ?? 0);
      if (
        (opts.slowOver !== undefined && span > opts.slowOver * DAY) ||
        (opts.busyFor !== undefined && searches.length <= opts.busyFor)
      ) {
        timeouts += 1;
        throw new Error(
          "Apple Mail: Mail search took too long. Narrow it: a shorter date range, a sender, or one mailbox.",
        );
      }
      return {
        messages: rows
          .filter(
            (m) =>
              (since === undefined || Date.parse(m.date) >= since) &&
              (until === undefined || Date.parse(m.date) < until),
          )
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
          .slice(0, limit),
      };
    };
    return { call, searches, timeouts: () => timeouts };
  }

  // 90 messages across the last 15 months, a few at a time.
  const spread = Array.from({ length: 90 }, (_, i) => NOW - (i * 5 + 1) * DAY - i * 1000);

  it("backfills in bounded date windows, newest first, and reads every message", async () => {
    const box = mailbox(spread);
    const adapter = mailAdapter(deps(box.call));
    const { items } = await drain(adapter, null, 25);
    expect(items).toHaveLength(90);
    expect(new Set(items.map((i) => i.nativeId)).size).toBe(90);
    // Every search is bounded on both ends, never wider than a year, and pages 25 at a time.
    expect(box.searches.every((s) => s.since !== undefined && s.until !== undefined)).toBe(true);
    expect(box.searches.every((s) => (s.until as number) - (s.since as number) <= 366 * DAY)).toBe(
      true,
    );
    expect(box.searches.every((s) => s.limit <= 25)).toBe(true);
    // Newest first: the first search ends now.
    expect(box.searches[0]?.until).toBe(NOW);
    // The first window is a week, not the whole mailbox.
    expect((box.searches[0]?.until as number) - (box.searches[0]?.since as number)).toBe(7 * DAY);
  });

  it("reads a window that fills the page in pages, without skipping or repeating", async () => {
    // 80 messages in one day.
    const day = Array.from({ length: 80 }, (_, i) => NOW - 3 * DAY - i * 60_000);
    const box = mailbox(day);
    const { items } = await drain(mailAdapter(deps(box.call)), null, 25);
    expect(items).toHaveLength(80);
    expect(new Set(items.map((i) => i.nativeId)).size).toBe(80);
  });

  it("halves a window Mail cannot answer and goes on, instead of failing the source", async () => {
    const box = mailbox(spread, { slowOver: 3 });
    const adapter = mailAdapter(deps(box.call));
    const { items } = await drain(adapter, null, 25);
    expect(items).toHaveLength(90);
    expect(box.timeouts()).toBeGreaterThan(0);
    // After the timeout, the next searches (until a run of them has worked) do not ask for more
    // than the size that worked.
    const firstOk = box.searches.findIndex(
      (s) => (s.until as number) - (s.since as number) <= 3 * DAY,
    );
    expect(firstOk).toBeGreaterThan(0);
    for (const s of box.searches.slice(firstOk, firstOk + 15))
      expect((s.until as number) - (s.since as number)).toBeLessThanOrEqual(3 * DAY);
  });

  it("keeps the smaller window in the cursor, so a timeout is not retried at full size", async () => {
    const box = mailbox(spread, { slowOver: 3 });
    const adapter = mailAdapter(deps(box.call));
    const first = await adapter.pull(null, { signal, limit: 25 });
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toMatchObject({ win: 3, cap: 3 });
    const before = box.timeouts();
    await adapter.pull(first.cursor, { signal, limit: 25 });
    expect(box.timeouts()).toBe(before);
  });

  it("lets the window grow back after a run of searches that worked (one busy moment is not forever)", async () => {
    // Mail is busy for the first two searches (7 days, then 3), then fine.
    const box = mailbox(spread, { busyFor: 2 });
    const adapter = mailAdapter(deps(box.call));
    let cursor: unknown = null;
    for (let i = 0; i < 2; i++) cursor = (await adapter.pull(cursor, { signal, limit: 25 })).cursor;
    expect((cursor as { cap: number }).cap).toBe(1);
    for (let i = 0; i < 80; i++) {
      const page = await adapter.pull(cursor, { signal, limit: 25 });
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    // Back above a day: the cap was lifted, not stuck where the busy moment left it.
    expect((cursor as { cap: number }).cap).toBeGreaterThan(1);
  });

  it("fails, saying why, only when even one day is too much", async () => {
    const box = mailbox(spread, { slowOver: 0.5 });
    const adapter = mailAdapter(deps(box.call));
    await expect(drain(adapter, null, 25)).rejects.toThrow(/took too long/);
    // The sweep gives no partial list: a sweep must not delete on it.
    const ids = await adapter.listIds?.(signal);
    expect(ids?.complete).toBe(false);
  });

  it("lists every id for the sweep over bounded windows", async () => {
    const box = mailbox(spread, { slowOver: 14 });
    const ids = await mailAdapter(deps(box.call)).listIds?.(signal);
    expect(ids?.ids).toHaveLength(90);
    expect(ids?.complete).toBe(true);
    expect(box.searches.every((s) => s.limit === 500)).toBe(true);
    expect(box.searches.every((s) => s.since !== undefined && s.until !== undefined)).toBe(true);
  });

  it("follows new mail with a window from the last sweep, not a rescan", async () => {
    const box = mailbox(spread);
    const adapter = mailAdapter(deps(box.call));
    const done = await drain(adapter, null, 25);
    const before = box.searches.length;
    // Same clock: nothing is newer. One search, from where the last sweep began.
    const again = await drain(adapter, done.cursor, 25);
    expect(again.items.length).toBeLessThanOrEqual(1);
    expect(box.searches.length - before).toBe(1);
    const search = box.searches.at(-1);
    expect(search?.until).toBe(NOW);
    expect((search?.until as number) - (search?.since as number)).toBe(10 * 60_000);
  });

  it("finishes at the start of the mailbox, not after centuries of empty windows", async () => {
    const box = mailbox([NOW - 2 * DAY]);
    const { items, pulls } = await drain(mailAdapter(deps(box.call)), null, 25);
    expect(items).toHaveLength(1);
    expect(pulls).toBeLessThan(25);
  });

  it("continues a cursor an earlier build wrote", async () => {
    const box = mailbox(spread);
    const adapter = mailAdapter(deps(box.call));
    const legacy = {
      newest: new Date(NOW - DAY).toISOString(),
      until: new Date(NOW - 200 * DAY).toISOString(),
      done: false,
    };
    const { items } = await drain(adapter, legacy, 25);
    // Everything older than the old frontier is still read.
    expect(items.length).toBe(spread.filter((t) => t < NOW - 200 * DAY).length);
    const finished = await drain(
      adapter,
      { newest: new Date(NOW).toISOString(), until: null, done: true },
      25,
    );
    expect(finished.items.length).toBeLessThanOrEqual(1);
  });
});

describe("messages", () => {
  it("asks the helper for at most 200 rows, which is what it serves", async () => {
    const seen: { cap: string; limit: unknown }[] = [];
    const d: AppleSourceDeps = {
      call: () => undefined,
      helper: () => async (cap, p) => {
        seen.push({ cap, limit: p.limit });
        if (cap === "messages.graph_chats") return { chats: [] };
        return { cursor: 0, hasMore: false, messages: [] };
      },
      ownAddresses: () => [],
      now: () => NOW,
    };
    await messagesAdapter(d).pull(null, { signal, limit: 500 });
    expect(seen.map((s) => s.cap)).toEqual(["messages.graph_chats", "messages.graph_read"]);
    expect(seen.every((s) => Number(s.limit) >= 1 && Number(s.limit) <= 200)).toBe(true);
  });

  /** 450 chats, newest first; the owner's only-outgoing chat with Dana is the 300th, past the first 200. */
  const chatList = (): { chatId: string; handles: string[]; isGroup: boolean }[] =>
    Array.from({ length: 450 }, (_, i) =>
      i === 299
        ? {
            chatId: "iMessage;+;chatOLD",
            handles: ["+15105550142", "dana@example.com"],
            isGroup: true,
          }
        : {
            chatId: `iMessage;-;+1555000${String(i).padStart(4, "0")}`,
            handles: [],
            isGroup: false,
          },
    );
  const outgoing = (chatId: string) => ({
    row: 1,
    chatId,
    sentAt: "2024-03-03T09:00:00Z",
    direction: "out",
    text: "see you at the climbing gym",
  });

  function helperWith(opts: { honourOffset: boolean; messages: Obj[]; hasMore?: boolean }) {
    const calls: { cap: string; params: Obj }[] = [];
    const call = async (cap: string, p: Obj) => {
      calls.push({ cap, params: p });
      if (cap === "messages.graph_chats") {
        const all = chatList();
        const offset = opts.honourOffset ? Number(p.offset ?? 0) : 0;
        return { chats: all.slice(offset, offset + Number(p.limit)) };
      }
      return { cursor: 1, hasMore: opts.hasMore === true, messages: opts.messages };
    };
    const deps: AppleSourceDeps = {
      call: () => undefined,
      helper: () => call,
      ownAddresses: () => [],
      now: () => NOW,
    };
    return { deps, calls };
  }

  it("names a day's participants from every chat, not the 200 newest: an excluded member is excluded", async () => {
    const h = helperWith({ honourOffset: true, messages: [outgoing("iMessage;+;chatOLD")] });
    const page = await messagesAdapter(h.deps).pull(null, { signal, limit: 100 });
    const chatCalls = h.calls.filter((c) => c.cap === "messages.graph_chats");
    expect(chatCalls.map((c) => c.params.offset ?? 0)).toEqual([0, 200, 400]);
    expect(page.items).toHaveLength(1);
    // Only the owner's own messages that day, yet the group's members are on it.
    expect(page.items[0]?.parties).toEqual(["+15105550142", "dana@example.com"]);
    const ex = { contacts: ["Dana@Example.com"], chats: [], accounts: [], folders: [] };
    expect(isExcluded(page.items[0] as SourceItem, ex)).toBe(true);
    const phone = { ...ex, contacts: ["+1 (510) 555-0142"] };
    expect(isExcluded(page.items[0] as SourceItem, phone)).toBe(true);
  });

  it("without paging (an older helper), a one-to-one chat still names its person and an unknown group is not indexed", async () => {
    const h = helperWith({
      honourOffset: false,
      messages: [
        { ...outgoing("iMessage;-;dana@example.com"), row: 1 },
        { ...outgoing("iMessage;+;chatOLD"), row: 2 },
      ],
    });
    const page = await messagesAdapter(h.deps).pull(null, { signal, limit: 100 });
    // The directory could not be listed past 200 (the same page came back), so the group is unknown.
    expect(page.items.map((i) => i.chatId)).toEqual(["iMessage;-;dana@example.com"]);
    expect(page.items[0]?.parties).toEqual(["dana@example.com"]);
    const ex = { contacts: ["dana@example.com"], chats: [], accounts: [], folders: [] };
    expect(isExcluded(page.items[0] as SourceItem, ex)).toBe(true);
  });

  it("reads the chat directory once for a pass, and again for the next", async () => {
    const h = helperWith({
      honourOffset: true,
      messages: [outgoing("iMessage;+;chatOLD")],
      hasMore: true,
    });
    const adapter = messagesAdapter(h.deps);
    const chatCalls = () => h.calls.filter((c) => c.cap === "messages.graph_chats").length;
    await adapter.pull(null, { signal, limit: 100 });
    const first = chatCalls();
    await adapter.pull({ row: 1 }, { signal, limit: 100 });
    expect(chatCalls()).toBe(first);
    // A first page again (no cursor): a new pass, a new directory.
    await adapter.pull(null, { signal, limit: 100 });
    expect(chatCalls()).toBe(first * 2);
  });
});
