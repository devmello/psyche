import type { AgentEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  blocks,
  call,
  calls,
  endOf,
  harness,
  resultsIn,
  runTurn,
  say,
  start,
  until,
} from "./harness.ts";

/**
 * #307: `notify` to the owner needs no card (the broker's `owner_inbox` rule), so a run that
 * loops on it would flood the owner's inbox. Past a per-Task budget the loop asks once; an
 * unattended run's card is deferred, and further calls are blocked while it waits.
 */

/** Ids of the `notify` calls that ran (their final status is `ok`). */
const sent = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === "tool_call" && e.tool === "notify" && e.status === "ok" ? [e.toolCallId] : [],
  );

const note = (id: string, n: number) =>
  call(id, "notify", { title: `Update ${n}`, body: `Step ${n} is done.` });

describe("notify budget (#307)", () => {
  it("delivers the first notifications without a card and says what it will do", async () => {
    const h = harness({ script: [note("n1", 1), note("n2", 2), say("done")] });
    const events = await runTurn(h, "tell me when each step is done");
    expect(endOf(events).outcome).toBe("final");
    expect(h.broker.issued).toHaveLength(0);
    expect(h.broker.decisions.map((d) => d.result.rule)).toEqual(["owner_inbox", "owner_inbox"]);
    expect(sent(events)).toEqual(["n1", "n2"]);
    const lines = events.flatMap((e) =>
      e.type === "tool_call" && e.tool === "notify" && e.level1 !== undefined ? [e.level1] : [],
    );
    // Never "Notified" for a call that has not run yet.
    expect(lines).toContain("Notify the owner: Update 1");
    expect(lines.some((l) => l.startsWith("Notified"))).toBe(false);
  });

  it("asks once the budget is spent in an attended turn; an approval sends it", async () => {
    const h = harness({
      script: [note("n1", 1), note("n2", 2), note("n3", 3), note("n4", 4), say("done")],
      loop: { notifyBudget: 3 },
    });
    const turn = start(h, "keep me posted");
    await until(() => h.broker.issued.length === 1, "budget card");
    const card = h.broker.issued[0]?.approval;
    expect(card?.summary).toBe(
      "Notify the owner: Update 4 (this run already sent 3 notifications)",
    );
    expect(card?.scopesOffered).toEqual(["once"]);
    expect(card?.requestedBy.toolCallId).toBe("n4");
    await h.broker.decideLatest("approve", h.clock);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("final");
    expect(sent(events)).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("breaks an unattended loop: one deferred card, then blocked without another", async () => {
    const h = harness({
      script: [
        calls(
          { id: "n1", name: "notify", input: { title: "Update 1", body: "1" } },
          { id: "n2", name: "notify", input: { title: "Update 2", body: "2" } },
        ),
        note("n3", 3),
        note("n4", 4),
        note("n5", 5),
        note("n6", 6),
        say("NO_REPLY"),
      ],
      loop: { notifyBudget: 3 },
    });
    const events = await runTurn(h, "weekly review", { taskId: "task_auto_1", mode: "unattended" });
    expect(endOf(events).outcome).not.toBe("failed");
    // One card for the whole loop, deferred to the queue.
    expect(h.broker.issued).toHaveLength(1);
    expect(h.broker.issued[0]?.approval.requestedBy).toMatchObject({
      taskId: "task_auto_1",
      toolCallId: "n4",
    });
    expect(h.broker.issued[0]?.approval.status).toBe("pending");
    expect(sent(events)).toEqual(["n1", "n2", "n3"]);
    // One "Approval needed" notice for the deferred card, none for the blocked calls.
    const notes = await h.notifier.list();
    expect(notes.filter((n) => n.kind === "approval")).toHaveLength(1);
    // The model is told why, so it can stop.
    const last = resultsIn(h.provider.requests.at(-1)).get("n6") as { error?: string } | undefined;
    expect(JSON.stringify(last)).toContain("notification budget reached");
    expect(blocks(events).filter((b) => b.type === "approval")).toHaveLength(1);
  });

  it("counts per Task: a new automation run starts with a fresh budget", async () => {
    const h = harness({
      script: [note("a1", 1), note("a2", 2), say("NO_REPLY"), note("b1", 1), say("NO_REPLY")],
      loop: { notifyBudget: 2 },
    });
    const first = await runTurn(h, "first", { taskId: "task_auto_1", mode: "unattended" });
    const second = await runTurn(h, "second", { taskId: "task_auto_2", mode: "unattended" });
    expect(h.broker.issued).toHaveLength(0);
    expect([...sent(first), ...sent(second)]).toEqual(["a1", "a2", "b1"]);
  });
});
