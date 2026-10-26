import type { RunBudget } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  BUDGET_OPTIONS,
  budgetBreach,
  budgetDecisionOf,
  budgetShares,
  raiseLimits,
} from "../src/index.ts";
import { blocks, call, endOf, recorder, runTurn, say, spec, start, until } from "./harness.ts";
import { childTask, researcher, withHost } from "./specialist-host.ts";

/** docs/agent/specialists-2026.md §4.1 (plan first) and §4.6 (budgets, pause, wrap-up). */

const budget = (limit: RunBudget["limit"], used: Partial<RunBudget["used"]> = {}): RunBudget => ({
  limit,
  used: { steps: 0, tokens: 0, wallMs: 0, costUsd: 0, ...used },
});

describe("budget arithmetic", () => {
  it("shares, breaches and +50% raises within the role's caps; unpriced cost never counts", () => {
    const b = budget(
      { tokens: 100, costUsd: 1, wallMs: 60_000 },
      { tokens: 90, costUsd: null, wallMs: 30_000 },
    );
    expect(budgetShares(b)).toEqual({ tokens: 0.9, wallMs: 0.5 });
    expect(budgetBreach(b)).toBeUndefined();
    expect(budgetBreach(budget({ tokens: 100 }, { tokens: 100 }))).toBe("tokens");
    expect(
      raiseLimits(budget({ tokens: 800_000, costUsd: 2, wallMs: 1_800_000 }), researcher.caps),
    ).toEqual({
      tokens: 1_000_000,
      costUsd: 3,
      wallMs: 2_700_000,
    });
    expect(budgetDecisionOf(BUDGET_OPTIONS.more)).toBe("more");
    expect(budgetDecisionOf("Stop it")).toBe("stop");
    expect(budgetDecisionOf("whatever you think")).toBe("finish");
  });
});

/** Every scripted model call reports 15 tokens (10 in, 5 out). */
const work = (n: number) => Array.from({ length: n }, (_, i) => call(`w${i}`, "web_search", {}));

function setup(script: Parameters<typeof withHost>[0]) {
  const t = withHost(script);
  t.h.loop.registry.register({ spec: spec("web_search", "read"), execute: recorder().execute });
  return t;
}

describe("a job at its budget (§4.6)", () => {
  it("marks 80% once, then pauses on the owner's question with nothing more run", async () => {
    const { h, host, tasks } = setup([...work(3), say("never reached")]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budget: budget({ tokens: 36 }),
    });
    const events = await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(endOf(events).outcome).toBe("awaiting_input");
    const texts = blocks(events).flatMap((b) => (b.type === "text" ? [b.md] : []));
    expect(texts.filter((t) => t === "[80% of the token budget used]")).toHaveLength(1);
    expect(texts).toContain("[stopped: token budget reached]");
    const q = events.find((e) => e.type === "question");
    expect(q).toMatchObject({ inputRequest: { questions: [{ header: "Budget" }] } });
    const s = host.specs.get(task.id);
    expect(s?.budget.used).toMatchObject({ tokens: 45, steps: 3 });
    expect(s?.budgetPause).toMatchObject({ reason: "token budget" });
    expect((await tasks.get(task.id))?.status).toBe("awaiting_input");
    // The third call's tools never ran, and the transcript stays valid for the next turn.
    expect(h.provider.requests).toHaveLength(3);
  });

  it("unattended jobs never pause: they write a partial report at once", async () => {
    const { h, host, tasks } = setup([...work(1), say("Found two of three.")]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budget: budget({ tokens: 10 }),
    });
    const events = await runTurn(h, "go", {
      threadId: "thr_child",
      taskId: task.id,
      mode: "unattended",
    });
    expect(endOf(events).outcome).toBe("final");
    const wrap = h.provider.requests[1];
    expect(wrap?.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(wrap?.messages.at(-1))).toContain("Stop working now");
    expect(host.reports[0]?.report).toMatchObject({
      outcome: "partial",
      summary: "Found two of three.",
      gaps: ["It stopped at its token budget."],
    });
  });

  it("“Give it more” raises the limits by half and goes on", async () => {
    const { h, host, tasks } = setup([
      call("r1", "specialist.report", { outcome: "done", summary: "Three." }),
      say("ok"),
    ]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budget: budget({ tokens: 40 }, { tokens: 30 }),
      budgetPause: { inputRequestId: "inp_1", reason: "token budget" },
    });
    host.decisions.set(task.id, "more");
    await runTurn(h, "Continue task", { threadId: "thr_child", taskId: task.id });
    const s = host.specs.get(task.id);
    expect(s?.budgetPause).toBeNull();
    expect(s?.budget.limit.tokens).toBe(60);
    expect(host.reports[0]?.report.outcome).toBe("done");
  });

  it("“raised” (tasks.update) goes on without adding its own +50%", async () => {
    const { h, host, tasks } = setup([
      call("r1", "specialist.report", { outcome: "done", summary: "Three." }),
      say("ok"),
    ]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budget: budget({ tokens: 100 }, { tokens: 45 }),
      budgetPause: { inputRequestId: "inp_1", reason: "token budget", raised: true },
    });
    host.decisions.set(task.id, "raised");
    await runTurn(h, "Continue task", { threadId: "thr_child", taskId: task.id });
    expect(host.specs.get(task.id)?.budget.limit.tokens).toBe(100);
  });

  it("“Finish with what it has” runs the tool-free wrap-up turn", async () => {
    const { h, host, tasks } = setup([say("Two listings so far: A and B.")]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budget: budget({ tokens: 40 }, { tokens: 45 }),
      budgetPause: { inputRequestId: "inp_1", reason: "token budget" },
    });
    host.decisions.set(task.id, "finish");
    await runTurn(h, "Continue task", { threadId: "thr_child", taskId: task.id });
    expect(h.provider.requests).toHaveLength(1);
    expect(h.provider.requests[0]?.tools ?? []).toHaveLength(0);
    expect(host.reports[0]?.report).toMatchObject({
      outcome: "partial",
      summary: "Two listings so far: A and B.",
    });
  });

  it("“Stop it” ends without a model call", async () => {
    const { h, host, tasks } = setup([say("unused")]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      budgetPause: { inputRequestId: "inp_1", reason: "token budget" },
    });
    host.decisions.set(task.id, "stop");
    const events = await runTurn(h, "Continue task", { threadId: "thr_child", taskId: task.id });
    expect(endOf(events).outcome).toBe("final");
    expect(h.provider.requests).toHaveLength(0);
    expect(host.reports[0]?.report).toMatchObject({
      outcome: "partial",
      summary: "Stopped at its budget.",
    });
  });

  it("a passed deadline wraps up before any work", async () => {
    const { h, host, tasks } = setup([say("Out of time; here is what I have.")]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      deadline: "2000-01-01T00:00:00.000Z",
    });
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(h.provider.requests[0]?.tools ?? []).toHaveLength(0);
    expect(host.reports[0]?.report.gaps).toEqual(["It reached its deadline."]);
  });
});

describe("plan first (§4.1)", () => {
  it("researches read-only, then continues in the job's own mode once the plan is approved", async () => {
    const write = recorder();
    const { h, host, tasks } = setup([
      call("p1", "exit_plan_mode", { title: "Find flats", plan: "1. Search 2. Compare" }),
      call("r1", "specialist.report", { outcome: "done", summary: "Done." }),
      say("ok"),
    ]);
    h.loop.registry.register({ spec: spec("edit_file", "write"), execute: write.execute });
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      planFirst: true,
      tools: ["web_search", "edit_file"],
      budget: budget({ tokens: 10_000 }),
    });
    const turn = start(h, "go", { threadId: "thr_child", taskId: task.id });
    await until(() => h.broker.issued.length === 1, "plan card");
    const first = h.provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(first).toContain("exit_plan_mode");
    expect(first).not.toContain("edit_file");
    await h.broker.decideLatest("approve", h.clock);
    await turn.done;
    expect(host.specs.get(task.id)?.planApproved).toBe(true);
    expect(h.provider.requests[1]?.tools?.map((t) => t.name)).toContain("edit_file");
  });

  it("a declined plan ends the job with the plan as its report", async () => {
    const { h, host, tasks } = setup([
      call("p1", "exit_plan_mode", { title: "Find flats", plan: "1. Search" }),
      say("never"),
    ]);
    const task = await childTask(tasks, {
      permissionMode: "balanced",
      planFirst: true,
      budget: budget({ tokens: 10_000 }),
    });
    const turn = start(h, "go", { threadId: "thr_child", taskId: task.id });
    await until(() => h.broker.issued.length === 1, "plan card");
    await h.broker.decideLatest("deny", h.clock);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("final");
    expect(host.reports[0]?.report).toMatchObject({
      outcome: "partial",
      summary: "Plan not approved: Find flats",
    });
    expect(h.provider.requests).toHaveLength(1);
  });
});
