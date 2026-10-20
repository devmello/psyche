import { MessagesReadResult, MessagesWatchEvent } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { FakeMessagesNode } from "../src/index.ts";

describe("FakeMessagesNode", () => {
  it("reads recent rows and rows after a cursor, in schema shape", async () => {
    const node = new FakeMessagesNode();
    node.receive({ from: "+15550001111", text: "one" });
    node.receive({ from: "+15550001111", text: "two" });
    node.receive({ from: "a@example.com", text: "other" });
    const recent = await node.invoke("messages.read", { handle: "+15550001111", limit: 1 });
    expect(Value.Check(MessagesReadResult, recent.result)).toBe(true);
    expect((recent.result as MessagesReadResult).messages.map((m) => m.text)).toEqual(["two"]);
    const after = await node.invoke("messages.read", { sinceCursor: 1 });
    expect((after.result as MessagesReadResult).messages.map((m) => m.cursor)).toEqual([2, 3]);
  });

  it("streams new rows to a watcher until aborted", async () => {
    const node = new FakeMessagesNode();
    const events: unknown[] = [];
    const ac = new AbortController();
    const done = node.invoke(
      "messages.watch",
      {},
      { signal: ac.signal, onEvent: (e) => events.push(e.data) },
    );
    await Promise.resolve();
    node.receive({ from: "+15550001111", text: "hi" });
    expect(events).toHaveLength(1);
    expect(Value.Check(MessagesWatchEvent, events[0])).toBe(true);
    ac.abort();
    expect((await done).error?.code).toBe("cancelled");
    expect(node.openWatches).toBe(0);
  });

  it("refuses a send without an approval and records an approved one", async () => {
    const node = new FakeMessagesNode();
    const refused = await node.invoke("messages.send", { to: "+15550001111", text: "x" });
    expect(refused.error?.code).toBe("approval_required");
    const ok = await node.invoke(
      "messages.send",
      { to: "+15550001111", text: "x" },
      { approvalId: "apr_1" },
    );
    expect(ok.ok).toBe(true);
    expect(node.sends).toEqual([{ to: "+15550001111", text: "x", approvalId: "apr_1" }]);
  });
});
