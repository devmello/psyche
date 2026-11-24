import { describe, expect, it } from "vitest";
import {
  queueViewOpen,
  takeViewOpens,
  VIEW_OPEN_HANDOFF_MAX,
  VIEW_OPEN_HANDOFF_TTL_MS,
  viewOpenFromCommand,
} from "../../src/main/view-open-handoff.ts";

const open = (pane: unknown, target?: unknown) => ({
  commandId: "c1",
  command: "open",
  args: target === undefined ? { pane } : { pane, target },
});

describe("viewOpenFromCommand: which gateway commands can be handed to a new window", () => {
  it("accepts every protocol pane, with or without a short target", () => {
    expect(viewOpenFromCommand(open("computer-watch", "machine-1"))).toEqual({
      pane: "computer-watch",
      target: "machine-1",
    });
    expect(viewOpenFromCommand(open("chat"))).toEqual({ pane: "chat" });
    expect(viewOpenFromCommand(open("sidechat", "thread-9"))).toEqual({
      pane: "sidechat",
      target: "thread-9",
    });
  });

  it("refuses anything that is not an open", () => {
    expect(viewOpenFromCommand({ command: "close", args: { pane: "chat" } })).toBeNull();
    expect(viewOpenFromCommand({ command: "focus", args: { pane: "chat" } })).toBeNull();
  });

  it("refuses a pane that is not in the protocol's ViewPane list", () => {
    expect(viewOpenFromCommand(open("not-a-pane"))).toBeNull();
    expect(viewOpenFromCommand(open("Computer-Watch"))).toBeNull();
    expect(viewOpenFromCommand(open(undefined))).toBeNull();
    expect(viewOpenFromCommand(open(42))).toBeNull();
  });

  it("refuses targets that are not short printable strings", () => {
    expect(viewOpenFromCommand(open("computer-watch", ""))).toBeNull();
    expect(viewOpenFromCommand(open("computer-watch", "x".repeat(201)))).toBeNull();
    expect(viewOpenFromCommand(open("computer-watch", "a\nb"))).toBeNull();
    expect(viewOpenFromCommand(open("computer-watch", "a\u0000b"))).toBeNull();
    expect(viewOpenFromCommand(open("computer-watch", 7))).toBeNull();
    expect(viewOpenFromCommand(open("computer-watch", "x".repeat(200)))).not.toBeNull();
  });

  it("refuses payloads that are not objects", () => {
    expect(viewOpenFromCommand(null)).toBeNull();
    expect(viewOpenFromCommand("open")).toBeNull();
    expect(viewOpenFromCommand({ command: "open" })).toBeNull();
  });
});

describe("queueViewOpen and takeViewOpens: the hand-off to a window that is loading", () => {
  const req = { pane: "computer-watch" as const, target: "m1" };

  it("delivers an open queued just before the window loads", () => {
    const queue = queueViewOpen([], req, 1_000);
    expect(takeViewOpens(queue, 1_500)).toEqual([req]);
  });

  it("drops an open whose window never came up in time", () => {
    const queue = queueViewOpen([], req, 1_000);
    expect(takeViewOpens(queue, 1_000 + VIEW_OPEN_HANDOFF_TTL_MS + 1)).toEqual([]);
    // Right at the edge it is still valid.
    expect(takeViewOpens(queue, 1_000 + VIEW_OPEN_HANDOFF_TTL_MS)).toEqual([req]);
  });

  it("keeps only the newest few, so a flood cannot grow the queue", () => {
    let queue: ReturnType<typeof queueViewOpen> = [];
    for (let i = 0; i < VIEW_OPEN_HANDOFF_MAX + 3; i++) {
      queue = queueViewOpen(queue, { pane: "computer-watch", target: `m${i}` }, 1_000 + i);
    }
    const taken = takeViewOpens(queue, 1_100);
    expect(taken).toHaveLength(VIEW_OPEN_HANDOFF_MAX);
    expect(taken.at(-1)).toEqual({
      pane: "computer-watch",
      target: `m${VIEW_OPEN_HANDOFF_MAX + 2}`,
    });
  });

  it("prunes expired entries when a new one is queued", () => {
    const old = queueViewOpen([], { pane: "chat" }, 0);
    const queue = queueViewOpen(old, req, VIEW_OPEN_HANDOFF_TTL_MS + 5);
    expect(takeViewOpens(queue, VIEW_OPEN_HANDOFF_TTL_MS + 5)).toEqual([req]);
  });

  it("positive control: a fresh open is taken, a stale one next to it is not", () => {
    const queue = queueViewOpen(queueViewOpen([], { pane: "chat" }, 0), req, 20_000);
    expect(takeViewOpens(queue, 20_000)).toEqual([req]);
  });
});
