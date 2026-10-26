import type { ModelEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  blocks,
  call,
  calls,
  endOf,
  harness,
  recorder,
  resultsIn,
  runTurn,
  say,
  spec,
  start,
  text,
  toolStatuses,
  turnInput,
  until,
} from "./harness.ts";

describe("text-only turn", () => {
  it("streams deltas and ends final with usage, in contract order", async () => {
    const h = harness({ script: [say("Hello there")] });
    const events = await runTurn(h, "hi");
    expect(text(events)).toBe("Hello there");
    expect(events[0]).toMatchObject({ type: "run.status", status: "running" });
    expect(events.at(-1)).toMatchObject({ type: "end", outcome: "final" });
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    expect(events.at(-2)).toMatchObject({ type: "run.status", status: "done" });
    const usage = events.findLast((e) => e.type === "usage");
    expect(usage).toMatchObject({ usage: { input: 10, output: 5 } });
    const request = h.provider.requests[0];
    expect(request?.model).toBe("fake/main");
    expect(request?.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "hi" }] }]);
  });

  it("gives the model the turn's images after the text (a pinned screen capture)", async () => {
    const h = harness({ script: [say("A chart")] });
    const input = turnInput("what is this?");
    input.input.images = [{ mime: "image/jpeg", data: "AAAA" }];
    for await (const _ of h.loop.startTurn(input)) {
      // drain
    }
    expect(h.provider.requests[0]?.messages[0]).toEqual({
      role: "user",
      parts: [
        { type: "text", text: "what is this?" },
        { type: "image", mime: "image/jpeg", data: "AAAA" },
      ],
    });
  });

  it("gives the model the attachments' extracted text after the message, not as what the owner said", async () => {
    const h = harness({ script: [say("Summary")] });
    const input = turnInput("summarize");
    input.input.attachments = [{ libraryItemId: "lib_1" }];
    input.input.attachmentText = "[attached file: a.txt]\nhello\n[end of attached file]";
    for await (const _ of h.loop.startTurn(input)) {
      // drain
    }
    expect(h.provider.requests[0]?.messages[0]).toEqual({
      role: "user",
      parts: [
        {
          type: "text",
          text: "summarize\n\n[attached file: a.txt]\nhello\n[end of attached file]",
        },
      ],
    });
  });

  it("keeps provider-native reasoning verbatim in the next request", async () => {
    const signed = { signature: "abc", thinking: "secret chain" };
    const h = harness({
      script: [
        [
          { type: "reasoning", provider: "anthropic", data: signed },
          { type: "text_delta", text: "one" },
          { type: "finish", reason: "stop" },
        ],
        say("two"),
      ],
    });
    await runTurn(h, "first");
    await runTurn(h, "second");
    const assistant = h.provider.requests[1]?.messages[1];
    expect(assistant?.parts[0]).toEqual({ type: "reasoning", provider: "anthropic", data: signed });
  });

  it("rejects a second concurrent turn on the same thread", async () => {
    const h = harness({ script: [call("c1", "ask_user", questionInput())] });
    const first = start(h, "ask me");
    await until(() => h.loop.openQuestions().length === 1, "question");
    const events = await runTurn(h, "again");
    expect(endOf(events)).toMatchObject({ outcome: "failed", error: "thread_busy" });
    await h.loop.cancel(first.runId);
    await first.done;
  });

  it("before_model_resolve can pick the model", async () => {
    const h = harness({
      script: [say("ok")],
      loop: { hooks: { before_model_resolve: () => ({ model: "fake/other" }) } },
    });
    await runTurn(h, "hi");
    expect(h.provider.requests[0]?.model).toBe("fake/other");
  });
});

describe("tool calls", () => {
  it("runs parallel tool calls and returns results in call order", async () => {
    const h = harness({
      script: [
        calls(
          { id: "a", name: "lookup", input: { q: 1 } },
          { id: "b", name: "lookup", input: { q: 2 } },
          { id: "c", name: "lookup", input: { q: 3 } },
        ),
        say("done"),
      ],
    });
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    h.loop.registry.register({
      spec: spec("lookup", "read"),
      execute: async (_id, params) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const q = (params as { q: number }).q;
        await new Promise((r) => setTimeout(r, (4 - q) * 5));
        order.push(q);
        inFlight -= 1;
        return { output: { q }, provenance: "trusted" };
      },
    });
    const events = await runTurn(h, "look up three things");
    expect(endOf(events).outcome).toBe("final");
    expect(maxInFlight).toBe(3);
    expect(order).toEqual([3, 2, 1]);
    const tool = h.provider.requests[1]?.messages[2];
    expect(tool?.role).toBe("tool");
    expect(tool?.parts.map((p) => (p.type === "tool_result" ? p.callId : ""))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(toolStatuses(events, "a")).toEqual(["pending", "running", "ok"]);
    expect(h.broker.decisions).toHaveLength(3);
  });

  it("blocks a denied tool and tells the model why, without executing it", async () => {
    const exec = recorder();
    const h = harness({
      script: [call("c1", "email.send", { to: "x@y.z" }), say("I could not send it.")],
      policy: { byTool: { "email.send": "deny" } },
    });
    h.loop.registry.register({ spec: spec("email.send", "destructive"), execute: exec.execute });
    const events = await runTurn(h, "send it");
    expect(exec.seen).toHaveLength(0);
    expect(toolStatuses(events, "c1")).toEqual(["pending", "blocked"]);
    const result = resultsIn(h.provider.requests[1]).get("c1");
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.output)).toContain("denied");
    expect(endOf(events).outcome).toBe("final");
  });

  it("a before_tool_call hook can block (and fails closed when it throws)", async () => {
    const exec = recorder();
    const h = harness({
      script: [
        calls({ id: "c1", name: "t", input: {} }, { id: "c2", name: "t", input: { boom: true } }),
        say("ok"),
      ],
      loop: {
        hooks: {
          before_tool_call: (ctx) => {
            if ((ctx.params as { boom?: boolean }).boom === true) throw new Error("hook crashed");
            return { action: "block", reason: "not today" };
          },
        },
      },
    });
    h.loop.registry.register({ spec: spec("t", "none"), execute: exec.execute });
    await runTurn(h, "go");
    expect(exec.seen).toHaveLength(0);
    const results = resultsIn(h.provider.requests[1]);
    expect(JSON.stringify(results.get("c1")?.output)).toContain("not today");
    expect(JSON.stringify(results.get("c2")?.output)).toContain("hook crashed");
    expect(h.broker.decisions).toHaveLength(0);
  });

  it("validates params before the broker sees the call", async () => {
    const h = harness({ script: [call("c1", "update_plan", { items: "nope" }), say("fixed")] });
    await runTurn(h, "plan");
    expect(h.broker.decisions).toHaveLength(0);
    expect(JSON.stringify(resultsIn(h.provider.requests[1]).get("c1")?.output)).toContain(
      "invalid params",
    );
  });

  it("suspends on ask, resumes on approval, verifies the binding and records a receipt", async () => {
    const exec = recorder();
    const h = harness({
      script: [call("c1", "calendar.create", { title: "Dentist" }), say("Booked.")],
    });
    h.loop.registry.register({ spec: spec("calendar.create", "write"), execute: exec.execute });
    const persisted: unknown[] = [];
    h.loop.hooks.on("tool_result_persist", ({ record }) => {
      persisted.push(record);
    });
    const turn = start(h, "book the dentist");
    await until(() => turn.events.some((e) => e.type === "approval_requested"), "approval");
    expect(
      turn.events.some((e) => e.type === "run.status" && e.status === "awaiting_approval"),
    ).toBe(true);
    expect(exec.seen).toHaveLength(0);
    await h.broker.decideLatest("approve", h.clock);
    const events = await turn.done;
    expect(exec.seen).toHaveLength(1);
    expect(endOf(events).outcome).toBe("final");
    expect(toolStatuses(events, "c1")).toEqual(["pending", "pending", "running", "ok"]);
    const approvalId = h.broker.issued[0]?.approval.id;
    const receipts = await h.broker.listReceipts({ toolCallId: "c1" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.approvalId).toBe(approvalId);
    expect(blocks(events).map((b) => b.type)).toEqual(["approval", "receipt"]);
    // `once` approvals are consumed: the binding cannot be reused.
    expect(
      await h.broker.verifyBinding(
        approvalId as string,
        h.broker.issued[0]?.approval.bindingHash as string,
      ),
    ).toEqual({
      ok: false,
      reason: "consumed",
    });
    expect(persisted[0]).toMatchObject({
      id: "c1",
      decision: "ask",
      approvalId,
      status: "ok",
      sideEffect: "write",
    });
  });

  it("a denied approval blocks the call", async () => {
    const exec = recorder();
    const h = harness({ script: [call("c1", "calendar.create", {}), say("Okay, not booked.")] });
    h.loop.registry.register({ spec: spec("calendar.create", "write"), execute: exec.execute });
    const turn = start(h, "book it");
    await until(() => h.broker.issued.length === 1, "approval");
    await h.broker.decideLatest("deny", h.clock);
    const events = await turn.done;
    expect(exec.seen).toHaveLength(0);
    expect(toolStatuses(events, "c1").at(-1)).toBe("blocked");
    expect(JSON.stringify(resultsIn(h.provider.requests[1]).get("c1")?.output)).toContain("denied");
  });

  it("a hook can suspend a call on its own approval", async () => {
    const exec = recorder();
    const h = harness({ script: [call("c1", "t", {}), say("ok")] });
    h.loop.registry.register({ spec: spec("t", "none"), execute: exec.execute });
    let approvalId = "";
    h.loop.hooks.on("before_tool_call", async (ctx) => {
      const issued = await h.broker.requestApproval({
        kind: "connector_action",
        summary: "plugin check",
        details: {},
        bindingHash: `sha256:${"0".repeat(64)}`,
        grantKey: "plugin",
        requestedBy: { runId: ctx.runId, taskId: null, threadId: ctx.threadId },
        sideEffect: "none",
        surfaces: ["desktop"],
        taint: false,
      });
      approvalId = issued.approval.id;
      return { action: "suspend", approvalId };
    });
    const turn = start(h, "go");
    await until(() => approvalId !== "", "hook approval");
    await h.broker.decideLatest("approve", h.clock, approvalId);
    await turn.done;
    expect(exec.seen).toHaveLength(1);
  });

  it("an executor error becomes a failed result, and oversized output is cut with a marker", async () => {
    const h = harness({
      script: [
        calls({ id: "c1", name: "bad", input: {} }, { id: "c2", name: "big", input: {} }),
        say("ok"),
      ],
      loop: { maxToolResultChars: 100 },
    });
    h.loop.registry.register({
      spec: spec("bad", "none"),
      execute: async () => {
        throw new Error("disk on fire");
      },
    });
    h.loop.registry.register({
      spec: spec("big", "none"),
      execute: async () => ({ output: "x".repeat(500), provenance: "trusted" }),
    });
    const events = await runTurn(h, "go");
    const results = resultsIn(h.provider.requests[1]);
    expect(results.get("c1")).toMatchObject({ isError: true, output: { error: "disk on fire" } });
    expect(String(results.get("c2")?.output)).toMatch(/\[truncated: result is 500 characters/);
    expect(toolStatuses(events, "c1").at(-1)).toBe("failed");
  });
});

function questionInput() {
  return {
    questions: [
      {
        question: "Which flight?",
        header: "Flight",
        multiSelect: false,
        options: [{ label: "7:05" }, { label: "9:40 (Recommended)" }],
      },
    ],
  };
}

describe("ask_user", () => {
  it("parks an attended run until the owner answers, then resumes with the answer", async () => {
    const h = harness({ script: [call("c1", "ask_user", questionInput()), say("Holding 9:40.")] });
    const turn = start(h, "find me a flight");
    await until(() => turn.events.some((e) => e.type === "question"), "question");
    const q = turn.events.find((e) => e.type === "question");
    if (q?.type !== "question") throw new Error("no question");
    expect(q.inputRequest.questions[0]?.options[0]?.label).toBe("9:40 (Recommended)");
    expect(turn.events.some((e) => e.type === "run.status" && e.status === "awaiting_input")).toBe(
      true,
    );
    expect(blocks(turn.events)).toContainEqual({
      type: "question",
      inputRequestId: q.inputRequest.id,
    });
    await expect(h.loop.answerQuestion(q.inputRequest.id, { Nope: "x" })).rejects.toThrow(
      /unknown/,
    );
    const answered = await h.loop.answerQuestion(q.inputRequest.id, {
      Flight: "9:40 (Recommended)",
    });
    expect(answered.status).toBe("answered");
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("final");
    expect(resultsIn(h.provider.requests[1]).get("c1")?.output).toEqual({
      answers: { Flight: "9:40 (Recommended)" },
    });
  });

  it("hands a background task's question to the task engine and ends awaiting_input", async () => {
    const h = harness({ script: [call("c1", "ask_user", questionInput())] });
    const task = await h.tasks.create({
      threadId: "thr_1",
      title: "Trip",
      goal: "book",
      createdFrom: "chat",
    });
    const events = await runTurn(h, "continue the task", { taskId: task.id });
    expect(endOf(events).outcome).toBe("awaiting_input");
    expect(events.at(-2)).toMatchObject({ type: "run.status", status: "awaiting_input" });
    expect((await h.tasks.get(task.id))?.status).toBe("awaiting_input");
    const q = events.find((e) => e.type === "question");
    expect(q).toMatchObject({ inputRequest: { taskId: task.id } });
  });

  it("rejects malformed questions with a message the model can fix", async () => {
    const bad = {
      questions: [
        {
          question: "Q?",
          header: "H",
          multiSelect: false,
          options: [{ label: "A" }, { label: "Other" }],
        },
      ],
    };
    const h = harness({ script: [call("c1", "ask_user", bad), say("ok")] });
    await runTurn(h, "ask");
    expect(JSON.stringify(resultsIn(h.provider.requests[1]).get("c1")?.output)).toContain(
      'adds \\"Other\\"',
    );
  });
});

describe("steer and follow-up", () => {
  it("steer skips the remaining tool calls and injects the guidance before the next model call", async () => {
    const h = harness({
      script: [
        calls({ id: "a", name: "slow", input: {} }, { id: "b", name: "write", input: {} }),
        say("Switched."),
      ],
      policy: { bySideEffect: { write: "allow" } },
    });
    let release: () => void = () => {};
    const exec = recorder();
    h.loop.registry.register({
      spec: spec("slow", "write"),
      execute: () =>
        new Promise((r) => {
          release = () => r({ output: "slow done", provenance: "trusted" });
        }),
    });
    h.loop.registry.register({ spec: spec("write", "write"), execute: exec.execute });
    const turn = start(h, "do both");
    await until(() => toolStatuses(turn.events, "a").includes("running"), "slow running");
    await h.loop.steer(turn.runId, "stop, do something else");
    release();
    const events = await turn.done;
    expect(exec.seen).toHaveLength(0);
    expect(toolStatuses(events, "b").at(-1)).toBe("blocked");
    const next = h.provider.requests[1];
    const last = next?.messages.at(-1);
    expect(last).toEqual({
      role: "user",
      parts: [{ type: "text", text: "stop, do something else" }],
    });
    expect(JSON.stringify(resultsIn(next).get("b")?.output)).toContain("new guidance");
  });

  it("runs follow-ups after the turn would end, in order, inside the same run", async () => {
    const h = harness({
      script: [call("c1", "ask_user", questionInput()), say("first"), say("second"), say("third")],
    });
    const turn = start(h, "start");
    await until(() => h.loop.openQuestions().length === 1, "question");
    await h.loop.followUp("thr_1", "follow-up one");
    await h.loop.followUp("thr_1", "follow-up two");
    const q = h.loop.openQuestions()[0];
    await h.loop.answerQuestion(q?.id as string, { Flight: "7:05" });
    const events = await turn.done;
    expect(text(events)).toBe("firstsecondthird");
    const users = (h.provider.requests[3]?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => (m.parts[0]?.type === "text" ? m.parts[0].text : ""));
    expect(users).toEqual(["start", "follow-up one", "follow-up two"]);
    expect(endOf(events).outcome).toBe("final");
  });

  it("finishTurn can continue the turn with a message", async () => {
    let n = 0;
    const h = harness({
      script: [say("draft"), say("final")],
      loop: {
        finishTurn: () => (n++ === 0 ? { action: "continue", message: "check your work" } : "end"),
      },
    });
    const events = await runTurn(h, "write");
    expect(text(events)).toBe("draftfinal");
    expect(h.provider.requests).toHaveLength(2);
  });

  it("steer on an unknown run is not_found", async () => {
    const h = harness();
    await expect(h.loop.steer("run_nope", "x")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("cancellation", () => {
  it("cancel during an approval wait ends cancelled and revokes run authority", async () => {
    const exec = recorder();
    const h = harness({ script: [call("c1", "calendar.create", {})] });
    h.loop.registry.register({ spec: spec("calendar.create", "write"), execute: exec.execute });
    const turn = start(h, "book");
    await until(() => h.broker.issued.length === 1, "approval");
    await h.loop.cancel(turn.runId);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("cancelled");
    const approval = await h.broker.get(h.broker.issued[0]?.approval.id as string);
    expect(approval?.status).toBe("invalidated");
    expect(exec.seen).toHaveLength(0);
    // The transcript stays valid: the dangling call has a result.
    const state = await h.loop.threadState("thr_1");
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({ type: "tool_result", callId: "c1" });
  });

  it("an aborted signal cancels the model stream", async () => {
    const controller = new AbortController();
    const slow: ModelEvent[] = Array.from({ length: 50 }, () => ({
      type: "text_delta",
      text: ".",
    }));
    const h = harness({ script: [slow] });
    const original = h.provider.stream.bind(h.provider);
    h.provider.stream = async function* (request, options) {
      for await (const e of original(request, options)) {
        await new Promise((r) => setTimeout(r, 1));
        yield e;
      }
    };
    const turn = start(h, "talk", { signal: controller.signal });
    await until(() => turn.events.some((e) => e.type === "chat.delta"), "delta");
    controller.abort();
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("cancelled");
  });
});

describe("budgets", () => {
  it("stops at the step budget with a visible marker", async () => {
    const h = harness({
      script: [
        call("a", "update_plan", { items: [{ text: "x", status: "pending" }] }),
        call("b", "update_plan", { advance: true }),
      ],
      loop: { maxSteps: 2 },
    });
    const events = await runTurn(h, "loop");
    expect(endOf(events)).toMatchObject({ outcome: "failed", error: "step_budget_exceeded" });
    expect(blocks(events)).toContainEqual({
      type: "text",
      md: "[stopped: step budget of 2 model calls reached]",
    });
  });

  it("stops at the token budget with a visible marker", async () => {
    const h = harness({
      script: [say("big", { input: 900, output: 200 })],
      loop: { maxRunTokens: 1_000 },
    });
    const events = await runTurn(h, "go");
    expect(endOf(events)).toMatchObject({ outcome: "failed", error: "token_budget_exceeded" });
    expect(blocks(events).some((b) => b.type === "text" && b.md.includes("token budget"))).toBe(
      true,
    );
  });
});
