import { createThread } from "@psyche/db";
import {
  type AgentEvent,
  createValidator,
  type PsycheTrace,
  PsycheTrace as PsycheTraceSchema,
  type Run,
  type RunStep,
  type ToolCall,
} from "@psyche/protocol";
import { SAMPLE_APPROVAL_REQUEST, type ScriptedAgentEvent } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.ts";
import { GatedAgentLoop } from "./agent.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

/**
 * Run trace T1, Gateway sink (docs/design/run-trace-2026.md §4): a scripted loop with thinking,
 * a parallel group, a helper, a retry and an approval becomes ordered, linked steps; the trace
 * is redacted at write, exported, deleted and expired.
 */

const SECRET = "hunter2-vault-value";
const redact = (text: string) => text.replaceAll(SECRET, "‹vault: bank›");
const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: input / 1e6,
});

let t: TestGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
});

async function setup(clock: { now: number } = { now: Date.parse("2026-10-25T10:00:00.000Z") }) {
  const agent = new GatedAgentLoop();
  t = await startTestGateway({ agent, traceRedact: redact, now: () => new Date(clock.now) });
  const owner = await adminClient(t.gateway);
  clients.push(owner);
  return { agent, gw: t.gateway, owner, clock };
}

async function runTurn(owner: TestClient, gw: TestGateway["gateway"], threadId: string) {
  await owner.call("chat.send", { threadId, content: "Plan Lisbon" }, ik());
  await gw.context.sessions.idle();
}

describe("run trace sink", () => {
  it("writes ordered, linked steps for thinking, a parallel group, a helper, a retry and an approval", async () => {
    const { agent, gw, owner } = await setup();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const helperInfo = (parentRunId: string) => ({
      id: "sub_1",
      runId: `${parentRunId}:sub:sub_1`,
      parentRunId,
      parentThreadId: thread.id,
      threadId: `${thread.id}:sub:sub_1`,
      context: "fresh" as const,
      title: "Compare neighbourhoods",
      status: "running" as const,
    });
    const sink = gw.context.runTrace;
    let parentRun = "";
    const helper = (event: ScriptedAgentEvent) => ({
      type: "do" as const,
      fn: () =>
        sink.subagent(helperInfo(parentRun), {
          ...event,
          runId: helperInfo(parentRun).runId,
        } as AgentEvent),
    });
    const target = { kind: "origin" as const, value: "https://google.com/flights?token=abc" };
    agent.script([
      { type: "do", fn: () => (parentRun = agent.turns.at(-1)?.runId ?? "") },
      {
        type: "reasoning",
        messageId: "m1",
        stepId: "rsn_trace_1",
        delta: `Plan using ${SECRET}. `,
      },
      {
        type: "reasoning",
        messageId: "m1",
        stepId: "rsn_trace_1",
        delta: "Then book.",
        done: true,
      },
      { type: "usage", usage: usage(1000, 50) },
      // A parallel group: two reads dispatched together.
      {
        type: "tool_call",
        toolCallId: "tc_a",
        tool: "web.search",
        status: "running",
        level1: "Searching flights",
        details: { target, paramsRedacted: { q: "SFO" } },
      },
      {
        type: "tool_call",
        toolCallId: "tc_b",
        tool: "web.search",
        status: "running",
        level1: "Searching hotels",
      },
      {
        type: "tool_call",
        toolCallId: "tc_a",
        tool: "web.search",
        status: "running",
        level1: "Searching flights",
        update: { message: "page 2", progress: 0.5 },
      },
      {
        type: "tool_call",
        toolCallId: "tc_a",
        tool: "web.search",
        status: "ok",
        level1: "Searching flights",
      },
      {
        type: "tool_call",
        toolCallId: "tc_b",
        tool: "web.search",
        status: "ok",
        level1: "Searching hotels",
      },
      // A helper: its own run with its own steps.
      {
        type: "tool_call",
        toolCallId: "tc_sub",
        tool: "subagent.spawn",
        status: "running",
        level1: "Subagent: Compare neighbourhoods",
      },
      helper({
        type: "tool_call",
        toolCallId: "tc_h1",
        tool: "web.fetch",
        status: "running",
        level1: "Reading about Alfama",
      }),
      helper({
        type: "tool_call",
        toolCallId: "tc_h1",
        tool: "web.fetch",
        status: "ok",
        level1: "Reading about Alfama",
      }),
      helper({ type: "usage", usage: usage(300, 20) }),
      helper({ type: "end", outcome: "final" }),
      {
        type: "tool_call",
        toolCallId: "tc_sub",
        tool: "subagent.spawn",
        status: "ok",
        level1: "Subagent: Compare neighbourhoods",
      },
      // A retry: the same call fails, then runs again and succeeds.
      {
        type: "tool_call",
        toolCallId: "tc_r",
        tool: "calendar.read",
        status: "running",
        level1: "Reading your calendar",
      },
      {
        type: "tool_call",
        toolCallId: "tc_r",
        tool: "calendar.read",
        status: "failed",
        level1: "Reading your calendar",
      },
      {
        type: "tool_call",
        toolCallId: "tc_r",
        tool: "calendar.read",
        status: "running",
        level1: "Reading your calendar",
      },
      {
        type: "tool_call",
        toolCallId: "tc_r",
        tool: "calendar.read",
        status: "ok",
        level1: "Reading your calendar",
      },
      // An approval, then the call it was for.
      { type: "approval_requested", approval: { ...SAMPLE_APPROVAL_REQUEST, id: "ap_trace_1" } },
      {
        type: "tool_call",
        toolCallId: "tc_mail",
        tool: "email.send",
        status: "running",
        level1: "Sending the email",
        details: { approvalId: "ap_trace_1" },
      },
      {
        type: "tool_call",
        toolCallId: "tc_mail",
        tool: "email.send",
        status: "ok",
        level1: "Sending the email",
        details: { approvalId: "ap_trace_1" },
      },
      { type: "usage", usage: usage(2500, 300) },
      { type: "chat.delta", messageId: "m2", delta: "Here is the plan." },
      { type: "end", outcome: "final" },
    ]);
    await runTurn(owner, gw, thread.id);
    const runId = parentRun;
    const got = await owner.call<{ run: Run; steps: RunStep[]; children: Run[] }>("runs.get", {
      runId,
    });

    expect(got.steps.map((s) => [s.seq, s.kind, s.status])).toEqual([
      [1, "thinking", "ok"],
      [2, "model", "ok"],
      [3, "tool", "ok"],
      [4, "tool", "ok"],
      [5, "subagent", "ok"],
      [6, "tool", "ok"],
      [7, "approval", "ok"],
      [8, "tool", "ok"],
      [9, "model", "ok"],
      [10, "text", "ok"],
    ]);
    const [thinking, model1, a, b, spawn, retried, approval, mail, model2] = got.steps as RunStep[];
    // The thinking step is the chat.reasoning step; its kept text is redacted and only in runs.step.
    expect(thinking?.id).toBe("rsn_trace_1");
    expect(thinking?.text?.full).toBeUndefined();
    const detail = await owner.call<{ step: RunStep }>("runs.step", {
      runId,
      stepId: "rsn_trace_1",
    });
    expect(detail.step.text?.full).toBe("Plan using ‹vault: bank›. Then book.");
    expect(JSON.stringify(got)).not.toContain(SECRET);
    // Tool steps get stp_ ids, carried on their tool calls.
    expect(a?.id).toMatch(/^stp_/);
    const calls = owner.events
      .filter((e) => e.event === "tool_call.updated")
      .map((e) => (e.payload as { toolCall: ToolCall }).toolCall);
    expect(calls.find((c) => c.id === "tc_a")?.stepId).toBe(a?.id);
    // The parallel group shares a groupId.
    expect(a?.groupId).toBeDefined();
    expect(b?.groupId).toBe(a?.groupId);
    expect(model1?.usage).toMatchObject({ input: 1000, output: 50 });
    expect(model2?.usage).toMatchObject({ input: 1500, output: 250 });
    // The helper: its own run, linked both ways.
    expect(got.children).toHaveLength(1);
    const child = got.children[0] as Run;
    expect(child).toMatchObject({
      kind: "subagent",
      parentRunId: runId,
      rootRunId: runId,
      status: "done",
    });
    expect(child.id).not.toContain(":sub:");
    expect(spawn?.childRunId).toBe(child.id);
    const childSteps = await owner.call<{ steps: RunStep[] }>("runs.steps", { runId: child.id });
    expect(childSteps.steps.map((s) => [s.kind, s.parentStepId])).toEqual([
      ["tool", spawn?.id],
      ["model", spawn?.id],
    ]);
    // The retry stacks on its step.
    expect(retried).toMatchObject({ attempt: 2, status: "ok" });
    expect(retried?.attempts?.map((x) => x.status)).toEqual(["failed"]);
    // The approval waited, then the call it was for went ahead.
    expect(approval).toMatchObject({ approvalId: "ap_trace_1", status: "ok" });
    expect(mail?.approvalId).toBe("ap_trace_1");
    // Progress streamed on run.step; run.updated carries the step count.
    const progress = owner.events.filter(
      (e) => e.event === "run.step" && (e.payload as { step: RunStep }).step.progress !== undefined,
    );
    expect(progress.length).toBeGreaterThan(0);
    const run = await owner.call<{ run: Run }>("runs.get", { runId });
    expect(run.run).toMatchObject({ kind: "chat", origin: "owner", stepCount: 10 });
    // run.step never carries retained thinking text.
    for (const e of owner.events.filter((x) => x.event === "run.step")) {
      expect((e.payload as { step: RunStep }).step.text?.full).toBeUndefined();
    }
    // Lists: the run and its helper.
    const list = await owner.call<{ runs: Run[] }>("runs.list", { threadId: thread.id });
    expect(list.runs.map((r) => r.id).sort()).toEqual([runId, child.id].sort());
    const kids = await owner.call<{ runs: Run[] }>("runs.children", { runId });
    expect(kids.runs.map((r) => r.id)).toEqual([child.id]);

    // Export round-trips as psyche-trace+json v1 and Markdown.
    const json = await owner.call<{ fileName: string; dataBase64: string }>("runs.export", {
      runId,
      format: "psyche-trace+json",
    });
    const trace = JSON.parse(
      Buffer.from(json.dataBase64, "base64").toString("utf8"),
    ) as PsycheTrace;
    expect(createValidator(PsycheTraceSchema).check(trace)).toBe(true);
    expect(trace.steps).toHaveLength(10);
    expect(trace.children.map((c) => c.run.id)).toEqual([child.id]);
    expect(trace.steps.find((s) => s.id === a?.id)?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "web.search",
    });
    expect(trace.steps[0]?.thinking).toBe("Plan using ‹vault: bank›. Then book.");
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    const md = await owner.call<{ dataBase64: string; mime: string }>("runs.export", {
      runId,
      format: "markdown",
    });
    expect(md.mime).toBe("text/markdown");
    expect(Buffer.from(md.dataBase64, "base64").toString("utf8")).toContain(
      "Reading your calendar",
    );

    // Delete trace: the steps go, the run stays.
    await owner.call("runs.delete", { runId }, ik());
    expect((await owner.call<{ steps: RunStep[] }>("runs.get", { runId })).steps).toEqual([]);
    expect((await owner.call<{ run: Run }>("runs.get", { runId })).run.id).toBe(runId);
  }, 20_000);

  it("expires kept thinking text on data.reasoningRetentionDays and keeps the summary", async () => {
    const { agent, gw, owner, clock } = await setup();
    await owner.call("settings.set", { key: "data.reasoningRetentionDays", value: 1 }, ik());
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    agent.script([
      { type: "reasoning", messageId: "m1", stepId: "rsn_exp", delta: "Short plan", done: true },
      { type: "end", outcome: "final" },
    ]);
    await runTurn(owner, gw, thread.id);
    const runId = agent.turns.at(-1)?.runId as string;
    const before = await owner.call<{ step: RunStep }>("runs.step", { runId, stepId: "rsn_exp" });
    expect(before.step.text?.full).toBe("Short plan");
    clock.now += 2 * 86_400_000;
    expect(runRetention(gw.context).thinking).toBe(1);
    const after = await owner.call<{ step: RunStep }>("runs.step", { runId, stepId: "rsn_exp" });
    expect(after.step.text).toMatchObject({ summary: "Short plan" });
    expect(after.step.text?.full).toBeUndefined();
    expect(after.step.text?.expiresAt).toBeDefined();
  });

  it("keeps only the summary when reasoning retention is off, and never writes incognito", async () => {
    const { agent, gw, owner } = await setup();
    await owner.call("settings.set", { key: "data.reasoningRetentionDays", value: 0 }, ik());
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    agent.script([
      { type: "reasoning", messageId: "m1", stepId: "rsn_off", delta: "Not kept", done: true },
      { type: "end", outcome: "final" },
    ]);
    await runTurn(owner, gw, thread.id);
    const runId = agent.turns.at(-1)?.runId as string;
    const step = await owner.call<{ step: RunStep }>("runs.step", { runId, stepId: "rsn_off" });
    expect(step.step.text).toEqual({ summary: "Not kept" });

    const incognito = createThread(gw.context.db, {
      kind: "incognito",
      sessionKey: "incognito:1",
      title: "Private",
    });
    agent.script([
      {
        type: "tool_call",
        toolCallId: "tc_i",
        tool: "web.search",
        status: "running",
        level1: "Searching",
      },
      {
        type: "tool_call",
        toolCallId: "tc_i",
        tool: "web.search",
        status: "ok",
        level1: "Searching",
      },
      { type: "end", outcome: "final" },
    ]);
    await runTurn(owner, gw, incognito.id);
    const incognitoRun = agent.turns.at(-1)?.runId as string;
    expect(
      (await owner.call<{ steps: RunStep[] }>("runs.get", { runId: incognitoRun })).steps,
    ).toEqual([]);
    // It still streamed, for the live step log.
    expect(
      owner.events.some(
        (e) => e.event === "run.step" && (e.payload as { runId: string }).runId === incognitoRun,
      ),
    ).toBe(true);
  });

  it("stores tool inputs and outputs as redacted payloads with previews, capped at 1 MB", async () => {
    const { agent, gw, owner } = await setup();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const sink = gw.context.runTrace;
    const record = (runId: string, id: string): ToolCall => ({
      id,
      runId,
      messageId: null,
      tool: "web.fetch",
      paramsRedacted: { url: "https://bank.example/statements", password: SECRET },
      paramsHash: "sha256:x",
      sideEffect: "read",
      target: null,
      decision: null,
      decisionRule: null,
      approvalId: null,
      taintIn: false,
      taintOut: true,
      resultRef: null,
      provenanceOut: "untrusted",
      receiptId: null,
      startedAt: "2026-10-25T10:00:00.000Z",
      endedAt: "2026-10-25T10:00:01.000Z",
      status: "ok",
    });
    const big = "x".repeat(1_200_000);
    agent.script([
      {
        type: "tool_call",
        toolCallId: "tc_p",
        tool: "web.fetch",
        status: "running",
        level1: "Reading statements",
      },
      {
        type: "tool_call",
        toolCallId: "tc_p",
        tool: "web.fetch",
        status: "ok",
        level1: "Reading statements",
      },
      {
        type: "do",
        fn: () =>
          sink.toolResult(record(agent.turns.at(-1)?.runId as string, "tc_p"), {
            output: `Balance for ${SECRET}: $12. ${big}`,
            provenance: "untrusted",
          }),
      },
      { type: "end", outcome: "final" },
    ]);
    await runTurn(owner, gw, thread.id);
    const runId = agent.turns.at(-1)?.runId as string;
    const { steps } = await owner.call<{ steps: RunStep[] }>("runs.get", { runId });
    const step = steps[0] as RunStep;
    expect(step.preview?.input).toContain("bank.example");
    expect(step.preview?.output?.length).toBeLessThanOrEqual(2048);
    expect(step.payloadRef?.input).toBeDefined();
    const detail = await owner.call<{
      input: { password: string };
      output: string;
      truncated: boolean;
    }>("runs.step", { runId, stepId: step.id });
    expect(detail.input.password).toBe("‹vault: bank›");
    expect(detail.truncated).toBe(true);
    expect(detail.output.startsWith("Balance for ‹vault: bank›")).toBe(true);
    expect(Buffer.byteLength(detail.output)).toBeLessThanOrEqual(1024 * 1024);
    expect(JSON.stringify(steps)).not.toContain(SECRET);
  });
});
