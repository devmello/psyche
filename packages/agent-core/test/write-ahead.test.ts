import type { AgentEvent, DispatchIntent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createAgentLoop } from "../src/index.ts";
import {
  call,
  harness,
  recorder,
  resultsIn,
  say,
  spec,
  start,
  turnInput,
  until,
} from "./harness.ts";

describe("write-ahead dispatch hook (#63)", () => {
  it("awaits beforeDispatch before the executor runs, with the call's facts", async () => {
    const h = harness({
      script: [call("s1", "email.send", { to: "ana@example.com" }), say("done")],
      policy: { bySideEffect: { write: "allow" } },
    });
    const order: string[] = [];
    h.loop.registry.register({
      spec: spec("email.send", "write"),
      execute: async () => {
        order.push("execute");
        return { output: { ok: true }, provenance: "trusted" };
      },
    });
    const seen: DispatchIntent[] = [];
    const input = {
      ...turnInput("email ana@example.com"),
      beforeDispatch: async (c: DispatchIntent) => {
        await new Promise<void>((r) => setImmediate(r));
        seen.push(c);
        order.push("checkpoint");
      },
    };
    for await (const _ of h.loop.startTurn(input)) {
      // drain
    }
    expect(order).toEqual(["checkpoint", "execute"]);
    expect(seen).toEqual([{ toolCallId: "s1", tool: "email.send", sideEffect: "write" }]);
  });

  it("a hook that cannot record the step blocks the call: nothing is dispatched", async () => {
    const h = harness({
      script: [call("s1", "email.send", { to: "ana@example.com" }), say("done")],
      policy: { bySideEffect: { write: "allow" } },
    });
    const exec = recorder();
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: exec.execute });
    const input = {
      ...turnInput("email ana@example.com"),
      beforeDispatch: async () => {
        throw new Error("disk full");
      },
    };
    for await (const _ of h.loop.startTurn(input)) {
      // drain
    }
    expect(exec.seen).toEqual([]);
    const result = resultsIn(h.provider.requests.at(-1)).get("s1");
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.output)).toContain("could not be recorded");
  });
});

describe("a card re-issued after a restart is reused by the recovered turn (#64)", () => {
  it("the owner sees one card: the new process waits on the re-issued one", async () => {
    const h = harness({
      script: [call("s1", "email.send", { to: "ana@example.com" })],
      policy: { bySideEffect: { write: "ask" } },
    });
    const exec = recorder();
    const tool = { spec: spec("email.send", "write"), execute: exec.execute };
    h.loop.registry.register(tool);
    // Process 1 asks, then dies while the card is open.
    const dead = start(h, "email ana@example.com", { taskId: "task_1", threadId: "thr_task" });
    await until(() => h.broker.issued.length === 1, "first card");
    const first = h.broker.issued[0]?.approval;
    // Process 2 boots: the broker re-issues the card for the dead run's call.
    h.clock.advance(30_000);
    const [reissued] = await h.broker.reissue();
    expect(reissued?.approval.requestedBy.runId).toBe(dead.runId);
    const loop2 = createAgentLoop({
      provider: h.provider,
      model: "fake/main",
      utilityModel: "fake/utility",
      broker: h.broker,
      memory: h.memory,
      tasks: h.tasks,
      clock: h.clock,
      ids: h.ids,
    });
    loop2.registry.register(tool);
    h.provider.script([call("s2", "email.send", { to: "ana@example.com" }), say("Sent.")]);
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of loop2.startTurn(
        turnInput("resume", { taskId: "task_1", threadId: "thr_task" }),
      ))
        events.push(e);
    })();
    await until(() => events.some((e) => e.type === "approval_requested"), "recovered card");
    const asked = events.find((e) => e.type === "approval_requested");
    expect(asked?.type === "approval_requested" ? asked.approval.id : undefined).toBe(
      reissued?.approval.id,
    );
    expect(h.broker.issued).toHaveLength(1); // no second requestApproval
    expect(reissued?.approval.bindingHash).toBe(first?.bindingHash);
    h.broker.issued.push(reissued as NonNullable<typeof reissued>);
    await h.broker.decideLatest("approve", h.clock);
    await done;
    expect(exec.seen).toEqual([{ callId: "s2", params: { to: "ana@example.com" } }]);
    expect(await h.broker.list({ status: "pending" })).toEqual([]);
  });

  it("a card from a run of this same process is never reused", async () => {
    const h = harness({
      script: [call("s1", "email.send", { to: "ana@example.com" })],
      policy: { bySideEffect: { write: "ask" } },
    });
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: recorder().execute });
    const first = start(h, "email ana@example.com", { taskId: "task_1", threadId: "thr_task" });
    await until(() => h.broker.issued.length === 1, "first card");
    await h.broker.decideLatest("approve", h.clock);
    await h.loop.cancel(first.runId, "test");
    await first.done.catch(() => undefined);
    h.provider.script([call("s2", "email.send", { to: "ana@example.com" })]);
    const second = start(h, "again", { taskId: "task_1", threadId: "thr_task" });
    await until(() => h.broker.issued.length === 2, "a fresh card");
    expect(h.broker.issued[1]?.approval.requestedBy.toolCallId).toBe("s2");
    await h.loop.cancel(second.runId, "test");
  });

  it("a card from another task or with other arguments is not reused", async () => {
    const h = harness({
      script: [call("s1", "email.send", { to: "ana@example.com" })],
      policy: { bySideEffect: { write: "ask" } },
    });
    h.loop.registry.register({ spec: spec("email.send", "write"), execute: recorder().execute });
    start(h, "email ana@example.com", { taskId: "task_1", threadId: "thr_task" });
    await until(() => h.broker.issued.length === 1, "first card");
    h.clock.advance(30_000);
    await h.broker.reissue();
    const loop2 = createAgentLoop({
      provider: h.provider,
      model: "fake/main",
      broker: h.broker,
      clock: h.clock,
      ids: h.ids,
    });
    loop2.registry.register({ spec: spec("email.send", "write"), execute: recorder().execute });
    h.provider.script([call("s2", "email.send", { to: "bob@example.com" })]);
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const e of loop2.startTurn(
        turnInput("resume", { taskId: "task_1", threadId: "thr_task" }),
      ))
        events.push(e);
    })();
    await until(() => h.broker.issued.length === 2, "a fresh card");
    expect(h.broker.issued[1]?.approval.requestedBy.toolCallId).toBe("s2");
    await loop2.cancel(events.find((e) => e.type === "run.status")?.runId ?? "", "test");
  });
});
