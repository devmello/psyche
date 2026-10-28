import { appendMessage, createRun, createThread, getThread, putAgentThreadState } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CHAT_TTL_MS, runRetention } from "../src/retention.ts";
import { desktopClient, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway;
let clock = Date.parse("2026-10-27T12:00:00.000Z");

afterEach(async () => {
  await t?.cleanup();
});

async function setup() {
  clock = Date.parse("2026-10-27T12:00:00.000Z");
  t = await startTestGateway({ now: () => new Date(clock) });
  return t.gateway.context;
}

interface Chat {
  thread: { id: string; userCreated?: boolean };
  reused: boolean;
}

describe("empty chats", () => {
  it("New chat creates a marked chat, then reuses it while it is empty", async () => {
    await setup();
    const desk = await desktopClient(t.gateway);
    const first = await desk.call<Chat>("threads.newChat", { kind: "side" });
    expect(first.reused).toBe(false);
    expect(first.thread.userCreated).toBe(true);
    const again = await desk.call<Chat>("threads.newChat", { kind: "side" });
    expect(again.reused).toBe(true);
    expect(again.thread.id).toBe(first.thread.id);
    // Each kind keeps its own: an incognito chat is not a side chat.
    const incognito = await desk.call<Chat>("threads.newChat", { kind: "incognito" });
    expect(incognito.reused).toBe(false);
    expect(incognito.thread.id).not.toBe(first.thread.id);
    expect((await desk.call<Chat>("threads.newChat", { kind: "incognito" })).thread.id).toBe(
      incognito.thread.id,
    );
    desk.close();
  });

  it("prefers the empty chat on screen, and makes a new one once it has a message", async () => {
    const ctx = await setup();
    const desk = await desktopClient(t.gateway);
    const a = await desk.call<Chat>("threads.newChat", { kind: "side" });
    // A second empty chat (an older client, a race): New chat goes to the one on screen.
    const b = createThread(ctx.db, {
      kind: "side",
      sessionKey: "owner:side:b",
      userCreated: true,
    });
    const picked = await desk.call<Chat>("threads.newChat", {
      kind: "side",
      preferThreadId: a.thread.id,
    });
    expect(picked.thread.id).toBe(a.thread.id);
    expect(
      (await desk.call<Chat>("threads.newChat", { kind: "side", preferThreadId: b.id })).thread.id,
    ).toBe(b.id);
    for (const id of [a.thread.id, b.id])
      appendMessage(
        ctx.db,
        { threadId: id, role: "user", blocks: [{ type: "text", md: "hi" }], provenance: "owner" },
        { expectedWriterRunId: null },
      );
    const fresh = await desk.call<Chat>("threads.newChat", { kind: "side" });
    expect(fresh.reused).toBe(false);
    expect([a.thread.id, b.id]).not.toContain(fresh.thread.id);
    desk.close();
  });

  it("does not list empty chats, and lists them once they hold a message", async () => {
    const ctx = await setup();
    const desk = await desktopClient(t.gateway);
    const { thread } = await desk.call<Chat>("threads.newChat", { kind: "side" });
    const ids = async () =>
      (await desk.call<{ threads: { thread: { id: string } }[] }>("threads.list", {})).threads.map(
        (x) => x.thread.id,
      );
    expect(await ids()).not.toContain(thread.id);
    // The chat itself is still readable by id (it is the one on screen).
    expect(
      (await desk.call<{ thread: { id: string } }>("threads.get", { threadId: thread.id })).thread
        .id,
    ).toBe(thread.id);
    appendMessage(
      ctx.db,
      {
        threadId: thread.id,
        role: "user",
        blocks: [{ type: "text", md: "hello" }],
        provenance: "owner",
      },
      { expectedWriterRunId: null },
    );
    expect(await ids()).toContain(thread.id);
    desk.close();
  });

  it("discardEmpty deletes an empty chat, its state, and tells every window", async () => {
    const ctx = await setup();
    const desk = await desktopClient(t.gateway);
    const other = await desktopClient(t.gateway);
    const { thread } = await desk.call<Chat>("threads.newChat", { kind: "side" });
    putAgentThreadState(ctx.db, thread.id, { note: "x" } as never);
    expect(await desk.call("threads.discardEmpty", { threadId: thread.id })).toEqual({
      deleted: true,
    });
    expect(getThread(ctx.db, thread.id)).toBeUndefined();
    await other.waitForEvent(
      (e) =>
        e.event === "thread.deleted" && (e.payload as { threadId: string }).threadId === thread.id,
    );
    expect(ctx.db.sqlite.prepare("SELECT count(*) AS n FROM agent_thread_state").get()).toEqual({
      n: 0,
    });
    desk.close();
    other.close();
  });

  it("discardEmpty keeps what is not an empty New chat", async () => {
    const ctx = await setup();
    const desk = await desktopClient(t.gateway);
    const mk = (kind: "side" | "main" | "channel" | "automation" | "subagent", over = {}) =>
      createThread(ctx.db, { kind, sessionKey: `k:${kind}:${Math.random()}`, ...over });
    const withMessage = createThread(ctx.db, {
      kind: "side",
      sessionKey: "owner:side:m",
      userCreated: true,
    });
    appendMessage(
      ctx.db,
      {
        threadId: withMessage.id,
        role: "user",
        blocks: [{ type: "text", md: "hi" }],
        provenance: "owner",
      },
      { expectedWriterRunId: null },
    );
    const withRun = createThread(ctx.db, {
      kind: "side",
      sessionKey: "owner:side:r",
      userCreated: true,
    });
    createRun(ctx.db, { threadId: withRun.id, modelRef: "fake/model" });
    const keep = [
      withMessage,
      withRun,
      // Not made by New chat: empty, but never the owner's to lose.
      mk("side"), // a fork or "Ask about" before its first message
      mk("channel", { userCreated: false }),
      mk("automation"),
      mk("subagent"),
      mk("main"),
      createThread(ctx.db, {
        kind: "side",
        sessionKey: "owner:side:p",
        userCreated: true,
        pinned: true,
      }),
    ];
    for (const thread of keep)
      expect(await desk.call("threads.discardEmpty", { threadId: thread.id })).toEqual({
        deleted: false,
      });
    for (const thread of keep) expect(getThread(ctx.db, thread.id)).toBeDefined();
    desk.close();
  });

  describe("sweep", () => {
    it("deletes an old empty New chat and tells clients", async () => {
      const ctx = await setup();
      const desk = await desktopClient(t.gateway);
      const { thread } = await desk.call<Chat>("threads.newChat", { kind: "side" });
      clock += EMPTY_CHAT_TTL_MS - 1000;
      expect(runRetention(ctx).emptyChats).toEqual([]);
      clock += 2000;
      expect(runRetention(ctx).emptyChats).toEqual([thread.id]);
      expect(getThread(ctx.db, thread.id)).toBeUndefined();
      await desk.waitForEvent(
        (e) =>
          e.event === "thread.deleted" &&
          (e.payload as { threadId: string }).threadId === thread.id,
      );
      desk.close();
    });

    it("keeps an old empty chat that was opened again since", async () => {
      const ctx = await setup();
      const desk = await desktopClient(t.gateway);
      const { thread } = await desk.call<Chat>("threads.newChat", { kind: "side" });
      clock += EMPTY_CHAT_TTL_MS - 1000;
      await desk.call("threads.newChat", { kind: "side" });
      clock += 2000;
      expect(runRetention(ctx).emptyChats).toEqual([]);
      expect(getThread(ctx.db, thread.id)).toBeDefined();
      desk.close();
    });

    it("keeps old empty task, channel, specialist and other threads, and chats with a message", async () => {
      const ctx = await setup();
      const owned = (kind: "side" | "main" | "channel" | "automation" | "subagent") =>
        createThread(ctx.db, { kind, sessionKey: `x:${kind}:${Math.random()}` });
      const kept = [
        owned("subagent"), // specialist / task helper
        owned("channel"), // Messages and other channel conversations
        owned("automation"),
        owned("main"),
        owned("side"), // a fork, an "Ask about" thread, a btw chat: never marked
      ];
      const withMessage = createThread(ctx.db, {
        kind: "side",
        sessionKey: "owner:side:w",
        userCreated: true,
      });
      appendMessage(
        ctx.db,
        {
          threadId: withMessage.id,
          role: "user",
          blocks: [{ type: "text", md: "hi" }],
          provenance: "owner",
        },
        { expectedWriterRunId: null },
      );
      const running = createThread(ctx.db, {
        kind: "side",
        sessionKey: "owner:side:run",
        userCreated: true,
      });
      createRun(ctx.db, { threadId: running.id, modelRef: "fake/model" });
      const doomed = createThread(ctx.db, {
        kind: "incognito",
        sessionKey: "owner:incognito:d",
        userCreated: true,
      });
      clock += 3 * EMPTY_CHAT_TTL_MS;
      expect(runRetention(ctx).emptyChats).toEqual([doomed.id]);
      for (const thread of [...kept, withMessage, running])
        expect(getThread(ctx.db, thread.id)).toBeDefined();
    });
  });
});
