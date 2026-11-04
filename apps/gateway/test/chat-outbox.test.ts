import { listAllMessages } from "@psyche/db";
import type { Thread } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/**
 * The chat outbox's guarantee (remote-gateway design §4.5, acceptance 6): a client that queued a
 * message offline sends it with the key it queued it under, and the Gateway runs it once, even
 * when the first attempt reached it and only the answer was lost with the connection.
 */

let t: TestGateway;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
});

describe("chat.send retried after a reconnect", () => {
  it("is delivered exactly once under the key it was queued with", async () => {
    t = await startTestGateway({
      agent: new GatedAgentLoop(),
      broker: new RecordingBroker({ armDelayMs: 0 }),
    });
    const key = newDeviceKey();
    const deviceId = "remote-mac-1";
    const first = await desktopClient(t.gateway, key, deviceId);
    clients.push(first);
    const thread = (await first.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;

    const outboxKey = `outbox:${ik()}`;
    const params = { threadId: thread.id, content: "sent from the train" };
    const a = await first.request("chat.send", params, outboxKey);
    expect(a).toMatchObject({ ok: true });
    // The connection drops; the client never saw the answer and sends again on reconnect.
    first.close();
    const second = await desktopClient(t.gateway, key, deviceId);
    clients.push(second);
    const b = await second.request("chat.send", params, outboxKey);
    expect(b).toMatchObject({ ok: true, payload: (a as { payload: unknown }).payload });

    const mine = listAllMessages(t.gateway.context.db, thread.id).filter((m) => m.role === "user");
    expect(mine).toHaveLength(1);
  });
});
