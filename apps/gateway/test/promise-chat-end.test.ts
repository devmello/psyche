import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThread, listAllMessages } from "@psyche/db";
import type { LaneItem } from "@psyche/memory";
import type { ModelEvent, Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { ownChatText, promiseChatOnThreadEnd, snapshotThread } from "../src/compose/thread-end.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The chat source of the promise lane at thread end, through the real thread store and the real
 * `threads.clear` and `threads.delete` handlers (review #1683, findings 3 and 4).
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const reply: ModelEvent[] = [
  { type: "text_delta", text: "I'll send the summary tomorrow." },
  {
    type: "usage",
    usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

async function start() {
  home = mkdtempSync(join(tmpdir(), "psyche-chat-end-"));
  const provider = new FakeModelProvider();
  for (let i = 0; i < 8; i++) provider.enqueue(reply);
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const runs: LaneItem[][] = [];
  const hook = promiseChatOnThreadEnd({
    enabled: () => true,
    snapshot: (id) => (composed ? snapshotThread(composed.db, id) : undefined),
    run: async (items) => {
      runs.push(items);
    },
  });
  composed.gateway.context.threadEnding.add(hook.ending);
  composed.gateway.context.threadEnded.add(hook.ended);
  return { composed, owner, runs };
}

async function turn(owner: TestClient, threadId: string, content: string) {
  await owner.call("chat.send", { threadId, content }, ik());
  await composed?.gateway.context.sessions.idle();
}
const settle = () => new Promise((r) => setTimeout(r, 20));

const PASTED_MAIL =
  "Forwarding this:\n\nFrom: Eve Park <eve@example.com>\nSubject: Deposit\nDate: Mon, 23 Nov 2026\n\n" +
  "Hi, I'll wire the deposit Friday.\nThanks,\nEve";

describe("promise lane at thread end, through the real thread store", () => {
  it("Clear chat: the owner's typed turn reaches the lane although the messages are deleted next", async () => {
    const { composed: c, owner, runs } = await start();
    const main = (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik()))
      .thread;
    await turn(owner, main.id, "I told Dana I'll send the budget on Monday.");
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThanOrEqual(2);
    await owner.call("threads.clear", { threadId: main.id }, ik());
    await settle();
    // The control: the transcript really is gone by the time the ended listener runs.
    expect(listAllMessages(c.db, main.id)).toEqual([]);
    expect(snapshotThread(c.db, main.id)?.turns).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.map((i) => [i.source, i.author, i.text])).toEqual([
      ["chat", "owner", "I told Dana I'll send the budget on Monday."],
    ]);
  });

  it("a plain clear extracts, and never reads the assistant's own promise", async () => {
    const { owner, runs } = await start();
    const side = (await owner.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;
    await turn(owner, side.id, "I'll review the draft tonight.");
    await owner.call("threads.clear", { threadId: side.id, alsoForget: false }, ik());
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.map((i) => i.text)).toEqual(["I'll review the draft tonight."]);
    expect(JSON.stringify(runs)).not.toContain("summary");
  });

  it("deleting the chat skips it: the owner chose to remove it", async () => {
    const { owner, runs } = await start();
    const side = (await owner.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;
    await turn(owner, side.id, "I'll review the draft tonight.");
    await owner.call("threads.delete", { threadId: side.id }, ik());
    await settle();
    expect(runs).toEqual([]);
  });

  it("Clear chat with 'also forget' skips it", async () => {
    const { owner, runs } = await start();
    const main = (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik()))
      .thread;
    await turn(owner, main.id, "I'll review the draft tonight.");
    await owner.call("threads.clear", { threadId: main.id, alsoForget: true }, ik());
    await settle();
    expect(runs).toEqual([]);
  });

  it("the snapshot holds only the last 30 of the owner's turns", async () => {
    const { composed: c, owner } = await start();
    const main = (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik()))
      .thread;
    for (let i = 0; i < 34; i++) {
      c.db.sqlite
        .prepare(
          "INSERT INTO messages (id, thread_id, seq, role, blocks, provenance, created_at) VALUES (?, ?, ?, 'user', ?, 'owner', ?)",
        )
        .run(
          `m${i}`,
          main.id,
          i,
          JSON.stringify([{ type: "text", md: `note ${i}` }]),
          "2026-11-24T09:00:00.000Z",
        );
    }
    const turns = snapshotThread(c.db, main.id)?.turns ?? [];
    expect(turns).toHaveLength(30);
    expect(turns[0]?.text).toBe("note 4");
    expect(turns.at(-1)?.text).toBe("note 33");
  });

  it("a channel thread's user turn is ignored", async () => {
    const { composed: c, owner, runs } = await start();
    const channel = createThread(c.db, { kind: "channel", sessionKey: "group-x" }).id;
    await turn(owner, channel, "I'll send the deck on Friday.");
    await owner.call("threads.delete", { threadId: channel }, ik());
    await settle();
    expect(runs).toEqual([]);
  });

  it("a pasted mail in a user turn does not reach the lane; the owner's own words around it do", async () => {
    const { owner, runs } = await start();
    const main = (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik()))
      .thread;
    await turn(owner, main.id, PASTED_MAIL);
    await turn(owner, main.id, "And I'll call Eve about it on Tuesday.");
    await owner.call("threads.clear", { threadId: main.id }, ik());
    await settle();
    const texts = runs.flat().map((i) => i.text);
    expect(texts.join(" ")).not.toContain("wire the deposit");
    expect(texts).toContain("And I'll call Eve about it on Tuesday.");
  });

  it("disabled: nothing is read at all", async () => {
    const { composed: c, owner } = await start();
    const snapshot = vi.fn(() => undefined);
    const off = promiseChatOnThreadEnd({ enabled: () => false, snapshot, run: async () => {} });
    c.gateway.context.threadEnding.add(off.ending);
    const main = (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik()))
      .thread;
    await turn(owner, main.id, "I'll send the deck on Friday.");
    await owner.call("threads.clear", { threadId: main.id }, ik());
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("ownChatText", () => {
  it.each([
    [PASTED_MAIL, "Forwarding this:"],
    ["> I'll wire the money today\nthanks", "thanks"],
    ["```\nI'll send the deck tomorrow\n```", ""],
    ["I'll send the deck on Friday.", "I'll send the deck on Friday."],
  ])("%j", (input, expected) => {
    expect(ownChatText(input)).toBe(expected);
  });
});

describe("hook failures", () => {
  it("a failing snapshot or lane is logged and swallowed, never an unhandled rejection", async () => {
    const log = { log: vi.fn() };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const snap = {
      kind: "main" as const,
      turns: [{ id: "a", text: "I'll send it Friday.", at: "2026-11-24T09:00:00Z" }],
    };
    const a = promiseChatOnThreadEnd({
      enabled: () => true,
      snapshot: () => {
        throw new Error("db closed");
      },
      run: async () => {},
      log: log as never,
    });
    a.ending("t1");
    a.ended("t1");
    const b = promiseChatOnThreadEnd({
      enabled: () => true,
      snapshot: () => snap,
      run: async () => Promise.reject(new Error("model offline")),
      log: log as never,
    });
    b.ending("t2");
    b.ended("t2");
    await settle();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(2);
  });
});
