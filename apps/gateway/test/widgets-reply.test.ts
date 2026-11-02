import { insertWidget } from "@psyche/db";
import type { Message, TaintSource } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

describe("chat.send from a widget (D10, §7.3)", () => {
  let t: TestGateway;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await t?.cleanup();
  });

  async function setup() {
    const agent = new GatedAgentLoop();
    t = await startTestGateway({ agent, broker: new RecordingBroker({ armDelayMs: 0 }) });
    const c = await desktopClient(t.gateway);
    clients.push(c);
    const make = async () =>
      (
        await c.call<{ thread: { id: string } }>(
          "threads.create",
          { kind: "side", title: "t" },
          ik(),
        )
      ).thread;
    const widgetIn = (threadId: string, taint: TaintSource[]) =>
      insertWidget(t.gateway.context.db, {
        threadId,
        messageId: "m",
        spec: {
          v: 1,
          title: "W",
          fallbackText: "w",
          root: { id: "root", type: "text", text: "hi" },
        },
        taint,
        owner: { kind: "run", runId: "r" },
      });
    return { agent, c, make, widgetIn };
  }

  it("stores the reply with via widget (the chip) and starts a clean turn from a clean widget", async () => {
    const { agent, c, make, widgetIn } = await setup();
    const thread = await make();
    const w = widgetIn(thread.id, []);
    await c.call(
      "chat.send",
      { threadId: thread.id, content: "Draft the replies now", fromWidget: { widgetId: w.id } },
      ik(),
    );
    await t.gateway.context.sessions.idle();
    expect(agent.turns[0]?.taintSources ?? []).toEqual([]);
    const { messages } = await c.call<{ messages: Message[] }>("chat.history", {
      threadId: thread.id,
    });
    const user = messages.find((m) => m.role === "user");
    expect(user?.via).toBe("widget");
    expect(user?.blocks[0]).toEqual({ type: "text", md: "Draft the replies now" });
  });

  it("a reply from an untrusted widget starts a tainted turn: the click does not launder it", async () => {
    const { agent, c, make, widgetIn } = await setup();
    const thread = await make();
    const taint = [{ sourceKind: "web", origin: "https://evil.example" }];
    const w = widgetIn(thread.id, taint);
    await c.call(
      "chat.send",
      { threadId: thread.id, content: "yes, send it", fromWidget: { widgetId: w.id } },
      ik(),
    );
    await t.gateway.context.sessions.idle();
    expect(agent.turns[0]?.taintSources).toEqual(taint);
  });

  it("refuses another chat's widget (same answer as a missing one) and a repeat within a second", async () => {
    const { c, make, widgetIn } = await setup();
    const a = await make();
    const b = await make();
    const foreign = widgetIn(b.id, []);
    await expect(
      c.call(
        "chat.send",
        { threadId: a.id, content: "x", fromWidget: { widgetId: foreign.id } },
        ik(),
      ),
    ).rejects.toThrow(/"code":"not_found"/);
    await expect(
      c.call("chat.send", { threadId: a.id, content: "x", fromWidget: { widgetId: "nope" } }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
    const mine = widgetIn(a.id, []);
    await c.call(
      "chat.send",
      { threadId: a.id, content: "one", fromWidget: { widgetId: mine.id } },
      ik(),
    );
    await t.gateway.context.sessions.idle();
    await expect(
      c.call(
        "chat.send",
        { threadId: a.id, content: "two", fromWidget: { widgetId: mine.id } },
        ik(),
      ),
    ).rejects.toThrow(/"code":"rate_limited"/);
  });
});
