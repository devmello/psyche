import { listAllMessages } from "@psyche/db";
import type { Block, Message, Thread } from "@psyche/protocol";
import { SAMPLE_APPROVAL_REQUEST } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/**
 * QA item 9: the loop announces a card twice (an `approval_requested` event, then its own
 * `approval` block). The transcript must keep one `approval` block per card, and `chat.block` is
 * sent once for it.
 */

let t: TestGateway;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
});

const approvals = (messages: Message[]): string[] =>
  messages.flatMap((m) =>
    m.blocks.flatMap((b: Block) => (b.type === "approval" ? [b.approvalId] : [])),
  );

async function turn(
  script: object[],
): Promise<{ client: TestClient; thread: Thread; blocks: string[] }> {
  const agent = new GatedAgentLoop();
  t = await startTestGateway({ agent, broker: new RecordingBroker({ armDelayMs: 0 }) });
  const client = await desktopClient(t.gateway);
  clients.push(client);
  const thread = (await client.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
    .thread;
  agent.script(script as never);
  await client.call("chat.send", { threadId: thread.id, content: "do it" }, ik());
  await t.gateway.context.sessions.idle();
  const blocks = client.events
    .filter((e) => e.event === "chat.block")
    .flatMap((e) => {
      const b = (e.payload as { block: Block }).block;
      return b.type === "approval" ? [b.approvalId] : [];
    });
  return { client, thread, blocks };
}

describe("one approval block per card", () => {
  it("keeps one block when the loop emits approval_requested and then its own block", async () => {
    const card = { ...SAMPLE_APPROVAL_REQUEST, id: "ap_dup_1" };
    const { thread, blocks } = await turn([
      { type: "chat.delta", messageId: "a1", delta: "Asking." },
      { type: "approval_requested", approval: card },
      { type: "block", messageId: "a1", block: { type: "approval", approvalId: "ap_dup_1" } },
      { type: "end", outcome: "final" },
    ]);
    expect(approvals(listAllMessages(t.gateway.context.db, thread.id))).toEqual(["ap_dup_1"]);
    // Live clients hear about the block once as well.
    expect(blocks).toEqual(["ap_dup_1"]);
  });

  it("two different cards keep one block each (positive control)", async () => {
    const { thread } = await turn([
      { type: "chat.delta", messageId: "a1", delta: "Asking." },
      { type: "approval_requested", approval: { ...SAMPLE_APPROVAL_REQUEST, id: "ap_a" } },
      { type: "block", messageId: "a1", block: { type: "approval", approvalId: "ap_a" } },
      { type: "approval_requested", approval: { ...SAMPLE_APPROVAL_REQUEST, id: "ap_b" } },
      { type: "block", messageId: "a1", block: { type: "approval", approvalId: "ap_b" } },
      { type: "end", outcome: "final" },
    ]);
    expect(approvals(listAllMessages(t.gateway.context.db, thread.id))).toEqual(["ap_a", "ap_b"]);
  });

  it("a card announced by the event alone still gets its block", async () => {
    const { thread } = await turn([
      { type: "chat.delta", messageId: "a1", delta: "Asking." },
      { type: "approval_requested", approval: { ...SAMPLE_APPROVAL_REQUEST, id: "ap_solo" } },
      { type: "end", outcome: "final" },
    ]);
    expect(approvals(listAllMessages(t.gateway.context.db, thread.id))).toEqual(["ap_solo"]);
  });
});
