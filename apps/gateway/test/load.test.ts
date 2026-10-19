import { listAllMessages } from "@psyche/db";
import type { AgentEvent, AgentLoop, StartTurnInput, Thread } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

const THREADS = 10;
const DELTAS = 40;

/** Streams `DELTAS` deltas tagged with the thread id, yielding to the event loop between them. */
class TaggingLoop implements AgentLoop {
  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    for (let i = 0; i < DELTAS; i++) {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      yield {
        type: "chat.delta",
        runId: input.runId,
        messageId: `m_${input.runId}`,
        delta: `${input.threadId}:${i};`,
      };
    }
    yield { type: "end", runId: input.runId, outcome: "final" };
  }
  async steer() {}
  async followUp() {}
  async cancel() {}
}

let t: TestGateway;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t.cleanup();
});

describe("load", () => {
  it(`streams ${THREADS} threads concurrently without cross-talk`, async () => {
    t = await startTestGateway({ agent: new TaggingLoop() });
    const sender = await desktopClient(t.gateway);
    clients.push(sender);
    const threads: Thread[] = [];
    for (let i = 0; i < THREADS; i++) {
      threads.push(
        (await sender.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik())).thread,
      );
    }
    // One watcher per thread, each filtered to its thread.
    const watchers = await Promise.all(
      threads.map(async (thread) => {
        const w = await desktopClient(t.gateway);
        clients.push(w);
        await w.call("events.subscribe", {
          filters: { events: ["chat.delta"], threadIds: [thread.id] },
        });
        return w;
      }),
    );
    await Promise.all(
      threads.map((thread) =>
        sender.call("chat.send", { threadId: thread.id, content: "go" }, ik()),
      ),
    );
    await t.gateway.context.sessions.idle();
    await new Promise((r) => setTimeout(r, 50));

    const expected = (id: string) => Array.from({ length: DELTAS }, (_, i) => `${id}:${i};`);
    threads.forEach((thread, i) => {
      const watcher = watchers[i] as TestClient;
      const deltas = watcher
        .eventsNamed("chat.delta")
        .map((e) => e.payload as { threadId: string; delta: string });
      expect(deltas.every((d) => d.threadId === thread.id)).toBe(true);
      expect(deltas.map((d) => d.delta)).toEqual(expected(thread.id));
      const messages = listAllMessages(t.gateway.context.db, thread.id);
      expect(messages.map((m) => m.role)).toEqual(["user", "agent"]);
      expect(messages[1]?.blocks).toEqual([{ type: "text", md: expected(thread.id).join("") }]);
    });
    // The unfiltered sender saw every delta, in seq order.
    const all = sender.eventsNamed("chat.delta");
    expect(all).toHaveLength(THREADS * DELTAS);
    const seqs = all.map((e) => e.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  }, 30_000);
});
