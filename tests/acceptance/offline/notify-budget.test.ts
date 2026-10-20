import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../../packages/testing/src/scenarios/index.ts";
import type { Stack } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Scenario, ScriptTurn } from "../../../packages/testing/src/scenarios/types.ts";
import { m2Overrides } from "../src/m2-world.ts";
import { M2_SCENARIOS_DIR } from "../src/scenario-scripts.ts";

/**
 * #307 on the real stack (agent loop, Permission Broker with its `owner_inbox` rule, the scheduler
 * fake that fires V9's automation unattended): an automation run that loops on `notify` delivers
 * the loop's budget of notifications without a card, then raises one deferred card and is
 * blocked from there on, with no further cards and no further "Approval needed" notices.
 */

const LOOPS = 6;

/** V9's first Friday run, with the model calling `notify` six times before its answer. */
function loopingNotify(sc: Scenario): void {
  const step = sc.steps.find((s) => s.id === "s3-friday-review");
  const turns = step?.script?.turns;
  if (step === undefined || turns === undefined) throw new Error("V9 changed: no s3 script");
  const notify: ScriptTurn[] = Array.from({ length: LOOPS }, (_, i) => ({
    toolCalls: [
      {
        id: `c_v9_notify_${i + 1}`,
        tool: "notify",
        sideEffect: "write",
        targetKind: "recipient",
        target: "owner",
        args: { title: "Weekly review", body: `Your weekly review is ready (${i + 1}).` },
      },
    ],
  }));
  turns.splice(turns.length - 1, 0, ...notify);
  // This variant checks the loop breaker below; the step's own "no card" checks do not apply.
  step.assertions = [];
}

describe("#307: an automation's notify loop stops at the budget", () => {
  it("delivers three, defers one card, blocks the rest without cards", async () => {
    const { overrides } = m2Overrides("v9-weekly-review");
    let stack: Stack | undefined;
    await runScenario(join(M2_SCENARIOS_DIR, "v9-weekly-review"), {
      mutate: loopingNotify,
      stack: {
        ...overrides,
        impls: (world, s) => {
          stack = s;
          return overrides.impls?.(world, s) ?? {};
        },
      },
    });
    if (stack === undefined) throw new Error("the Stack was never built");
    const calls = [...stack.calls.values()].filter((c) => c.tool === "notify");
    expect(calls).toHaveLength(LOOPS);
    // The broker allows each one (owner_inbox); the loop's budget decides past three.
    expect(calls.map((c) => c.record?.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(calls.slice(0, 3).every((c) => c.record?.decisionRule === "owner_inbox")).toBe(true);
    const cards = (await stack.broker.list({})).filter(
      (a) => a.requestedBy.toolCallId?.startsWith("c_v9_notify_") === true,
    );
    // One card for the whole loop; calls 5 and 6 were blocked while it waited. (The scenario's
    // approver policy denies leftover cards once the step settles.)
    expect(cards.map((a) => [a.requestedBy.toolCallId, a.scopesOffered])).toEqual([
      ["c_v9_notify_4", ["once"]],
    ]);
    // The loop's one "Approval needed" notice (the broker also notifies a surface per card).
    const notices = (await stack.notifier.list()).filter(
      (n) =>
        n.kind === "approval" &&
        n.title.startsWith("Approval needed") &&
        n.taskId === cards[0]?.requestedBy.taskId,
    );
    expect(notices.map((n) => n.approvalId)).toEqual([cards[0]?.id]);
  });
});
