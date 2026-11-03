import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  getAgentThreadState,
  getSetting,
  getThread,
  listAllMessages,
  setSetting,
  updateRun,
} from "@psyche/db";
import type { ModelEvent, ModelProvider, ModelRequest, Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** `threads.clear`: the owner's "Clear chat" empties a thread in place. */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function start(provider: ModelProvider = new FakeModelProvider()) {
  home = mkdtempSync(join(tmpdir(), "psyche-clear-"));
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
  return { composed, owner };
}

const mainThread = async (owner: TestClient) =>
  (await owner.call<{ thread: Thread }>("threads.create", { kind: "main" }, ik())).thread;

async function turn(owner: TestClient, threadId: string, content: string) {
  await owner.call("chat.send", { threadId, content }, ik());
  await composed?.gateway.context.sessions.idle();
}

const reply: ModelEvent[] = [
  { type: "text_delta", text: "Noted." },
  {
    type: "usage",
    usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

describe("threads.clear", () => {
  it("empties the thread but keeps its row, title, pin, receipts and audit entries", async () => {
    const provider = new FakeModelProvider();
    const { composed: c, owner } = await start(provider);
    const main = await mainThread(owner);
    await owner.call("threads.rename", { threadId: main.id, title: "Home base" }, ik());
    await owner.call("threads.pin", { threadId: main.id, pinned: true }, ik());
    await turn(owner, main.id, "remember the blue door");
    await turn(owner, main.id, "and the red window");
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThanOrEqual(4);
    expect(getAgentThreadState(c.db, main.id)).toBeDefined();
    setSetting(c.db, `context.usage.${main.id}`, { promptTokens: 9 });
    c.db.sqlite
      .prepare(
        "INSERT INTO receipts (id, short_id, kind, outcome, summary, created_at, updated_at) VALUES ('r1', 'R1', 'k', 'ok', 'sent a thing', 't', 't')",
      )
      .run();
    const auditBefore = (await c.audit.list()).length;
    owner.events.length = 0;

    expect(await owner.call("threads.clear", { threadId: main.id }, ik())).toEqual({ ok: true });

    // Transcript and the agent's model-side state are gone; the meter starts over.
    expect(listAllMessages(c.db, main.id)).toEqual([]);
    expect(getAgentThreadState(c.db, main.id)).toBeUndefined();
    expect(getSetting(c.db, `context.usage.${main.id}`)).toBeUndefined();
    expect(
      (await owner.call<{ messages: unknown[] }>("chat.history", { threadId: main.id })).messages,
    ).toEqual([]);
    // The thread is the same one, with its id, session key, title and pin.
    const kept = getThread(c.db, main.id) as Thread;
    expect(kept).toMatchObject({
      id: main.id,
      sessionKey: main.sessionKey,
      kind: "main",
      title: "Home base",
      pinned: true,
      lastMessageAt: null,
    });
    const again = await mainThread(owner);
    expect(again.id).toBe(main.id);
    // Receipts stay; the clear is audited (and audit entries are never removed).
    expect(c.db.sqlite.prepare("SELECT count(*) AS n FROM receipts").get()).toEqual({ n: 1 });
    const entries = await c.audit.list();
    expect(entries.length).toBe(auditBefore + 1);
    expect(entries.at(-1)).toMatchObject({
      kind: "thread.cleared",
      subject: { threadId: main.id },
      data: { alsoForget: false },
    });
    // Open windows hear about it.
    const names = owner.events.map((e) => e.event);
    expect(names).toContain("thread.cleared");
    expect(names).toContain("thread.updated");

    // The agent starts fresh: the next turn's request carries no earlier history.
    provider.requests.length = 0;
    await turn(owner, main.id, "who are you?");
    const sent = JSON.stringify(provider.requests.at(-1)?.messages);
    expect(sent).toContain("who are you?");
    expect(sent).not.toContain("blue door");
    expect(sent).not.toContain("red window");
  });

  it("stages memory retraction only when alsoForget is set", async () => {
    const { composed: c, owner } = await start();
    const main = await mainThread(owner);
    await turn(owner, main.id, "hello");
    const forget = vi.spyOn(c.memory, "forget");

    await owner.call("threads.clear", { threadId: main.id }, ik());
    expect(forget).not.toHaveBeenCalled();

    await turn(owner, main.id, "hello again");
    await owner.call("threads.clear", { threadId: main.id, alsoForget: true }, ik());
    expect(forget).toHaveBeenCalledWith(`thread:${main.id}`, { dryRun: true });
    expect((await c.audit.list()).at(-1)).toMatchObject({
      kind: "thread.cleared",
      data: { alsoForget: true },
    });
  });

  it("is idempotent for a retried key and refuses the same key with other params", async () => {
    const { composed: c, owner } = await start();
    const main = await mainThread(owner);
    await turn(owner, main.id, "hello");
    const key = ik();
    await owner.call("threads.clear", { threadId: main.id }, key);
    const auditAfterFirst = (await c.audit.list()).length;
    await turn(owner, main.id, "something new");
    // The retry returns the stored result and does not clear the new message.
    expect(await owner.call("threads.clear", { threadId: main.id }, key)).toEqual({ ok: true });
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThan(0);
    expect((await c.audit.list()).length).toBe(auditAfterFirst);
    await expect(
      owner.call("threads.clear", { threadId: main.id, alsoForget: true }, key),
    ).rejects.toThrow(/idempotency_conflict/);
    // A request without a key is refused.
    await expect(owner.call("threads.clear", { threadId: main.id })).rejects.toThrow(
      /idempotencyKey/,
    );
  });

  it("answers not_found for an unknown thread", async () => {
    const { owner } = await start();
    await expect(owner.call("threads.clear", { threadId: "nope" }, ik())).rejects.toThrow(
      /not_found/,
    );
  });

  it("works on a side thread too, leaving other threads alone", async () => {
    const { composed: c, owner } = await start();
    const main = await mainThread(owner);
    const side = (await owner.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;
    await turn(owner, main.id, "main words");
    await turn(owner, side.id, "side words");
    await owner.call("threads.clear", { threadId: side.id }, ik());
    expect(listAllMessages(c.db, side.id)).toEqual([]);
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThan(0);
    expect(getThread(c.db, side.id)).toBeDefined();
  });

  it("is a conflict while the thread is running, and clears once the turn ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: ModelProvider = {
      id: "slow",
      capabilities: async () => ({ contextWindow: 16_000 }) as never,
      async *stream(_req: ModelRequest) {
        await gate;
        yield* reply;
      },
    };
    const { composed: c, owner } = await start(slow);
    const main = await mainThread(owner);
    await owner.call("chat.send", { threadId: main.id, content: "work on it" }, ik());
    await vi.waitFor(() => expect(c.loop.isBusy(main.id)).toBe(true));

    await expect(owner.call("threads.clear", { threadId: main.id }, ik())).rejects.toThrow(
      /conflict/,
    );
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThan(0);

    release();
    await c.gateway.context.sessions.idle();
    await owner.call("threads.clear", { threadId: main.id }, ik());
    expect(listAllMessages(c.db, main.id)).toEqual([]);
  });

  it("is a conflict while the thread waits on an approval or a question", async () => {
    const { composed: c, owner } = await start();
    const main = await mainThread(owner);
    await turn(owner, main.id, "hello");

    const run = createRun(c.db, { threadId: main.id, modelRef: "fake/model" });
    updateRun(c.db, run.id, { status: "awaiting_approval" });
    await expect(owner.call("threads.clear", { threadId: main.id }, ik())).rejects.toThrow(
      /conflict.*approval/s,
    );
    updateRun(c.db, run.id, { status: "awaiting_input" });
    await expect(owner.call("threads.clear", { threadId: main.id }, ik())).rejects.toThrow(
      /conflict.*question/s,
    );
    expect(listAllMessages(c.db, main.id).length).toBeGreaterThan(0);

    updateRun(c.db, run.id, { status: "cancelled" });
    await owner.call("threads.clear", { threadId: main.id }, ik());
    expect(listAllMessages(c.db, main.id)).toEqual([]);
  });
});
