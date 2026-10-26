import { describe, expect, it } from "vitest";
import {
  AutomationRun,
  BrowserRecording,
  buildPsycheTrace,
  createValidator,
  EMPTY_USAGE,
  methodSpec,
  PsycheTrace,
  RUN_STEP_LIMITS,
  Run,
  RunFrame,
  RunStep,
  RunSummary,
  ToolCall,
  traceMarkdown,
  validateEventPayload,
  validateParams,
  validateResult,
} from "../src/index.ts";

/** Run trace (docs/design/run-trace-2026.md §4): the step model, runs.* and run.step. */

const AT = "2026-10-25T10:00:00.000Z";
const END = "2026-10-25T10:00:02.500Z";

const run = {
  id: "run_1",
  threadId: "thr_1",
  status: "done",
  modelRef: "anthropic/claude-opus-5-5",
  attempt: 1,
  startedAt: AT,
  endedAt: END,
  error: null,
  usage: EMPTY_USAGE,
} as const;

const toolStep = {
  id: "stp_01JB0000000000000000000001",
  runId: "run_1",
  seq: 2,
  groupId: "grp_1",
  kind: "tool",
  status: "ok",
  label: "Searching flights",
  doneLabel: "Searched flights",
  target: "google.com",
  startedAt: AT,
  endedAt: END,
  attempt: 2,
  attempts: [
    {
      startedAt: AT,
      endedAt: AT,
      status: "failed",
      error: { code: "timeout", message: "timed out", retryable: true },
    },
  ],
  toolCallId: "tc_1",
  progress: { message: "3 of 5", fraction: 0.6 },
  preview: { input: '{"q":"SFO"}', output: "5 flights" },
  payloadRef: { input: "pl_1", output: "pl_2" },
  frames: { first: 1, last: 3 },
} as const;

const thinkingStep = {
  id: "rsn_1",
  runId: "run_1",
  seq: 1,
  kind: "thinking",
  status: "ok",
  label: "Thinking",
  startedAt: AT,
  endedAt: AT,
  attempt: 1,
  text: { summary: "Compare the two flights", full: "…", expiresAt: "2026-11-01T10:00:00.000Z" },
} as const;

const check = (schema: Parameters<typeof createValidator>[0], value: unknown) =>
  createValidator(schema).check(value);

describe("run trace schemas", () => {
  it("accepts a run without the new fields, and with all of them", () => {
    expect(check(Run, run)).toBe(true);
    expect(
      check(Run, {
        ...run,
        kind: "subagent",
        title: "Find flights",
        parentRunId: "run_0",
        rootRunId: "run_0",
        taskId: "tsk_1",
        automationRunId: null,
        stepCount: 4,
        currentStepId: null,
        lastStepAt: END,
        origin: "subagent",
        budget: {
          limit: { steps: 50, tokens: 100_000, wallMs: 600_000 },
          used: { steps: 4, tokens: 1200, wallMs: 2500, costUsd: null },
        },
        deadline: null,
        specialist: { role: "research" },
        note: "Some steps were folded",
      }),
    ).toBe(true);
    expect(check(Run, { ...run, kind: "job" })).toBe(false);
  });

  it("validates steps of every kind and refuses what is over the limits", () => {
    expect(check(RunStep, toolStep)).toBe(true);
    expect(check(RunStep, thinkingStep)).toBe(true);
    for (const kind of [
      "model",
      "approval",
      "question",
      "subagent",
      "text",
      "memory",
      "artifact",
    ]) {
      expect(
        check(RunStep, { ...thinkingStep, id: `stp_${kind}`, kind, text: undefined }),
        kind,
      ).toBe(true);
    }
    expect(check(RunStep, { ...toolStep, kind: "shell" })).toBe(false);
    expect(check(RunStep, { ...toolStep, status: "done" })).toBe(false);
    expect(check(RunStep, { ...toolStep, seq: 0 })).toBe(false);
    expect(check(RunStep, { ...toolStep, label: "x".repeat(RUN_STEP_LIMITS.labelChars + 1) })).toBe(
      false,
    );
    expect(
      check(RunStep, {
        ...toolStep,
        preview: { output: "x".repeat(RUN_STEP_LIMITS.previewBytes + 1) },
      }),
    ).toBe(false);
    expect(
      check(RunStep, {
        ...toolStep,
        attempts: Array.from({ length: 6 }, () => toolStep.attempts[0]),
      }),
    ).toBe(false);
    expect(check(RunStep, { ...toolStep, progress: { fraction: 1.5 } })).toBe(false);
  });

  it("validates run summaries, frames and the trace document", () => {
    expect(
      check(RunSummary, {
        ...run,
        currentStep: { label: "Searching flights", status: "running", startedAt: AT },
        activity: Array.from({ length: 12 }, () => 1),
        durationsMs: [1000, 2000],
      }),
    ).toBe(true);
    expect(check(RunSummary, { ...run, activity: [1, 2] })).toBe(false);
    expect(check(RunFrame, { seq: 1, at: AT, stepId: toolStep.id, width: 1280, height: 800 })).toBe(
      true,
    );
    expect(
      check(PsycheTrace, {
        format: "psyche-trace",
        version: 1,
        exportedAt: END,
        redacted: true,
        run: { ...run, model: run.modelRef, parentRunId: null },
        steps: [
          {
            id: toolStep.id,
            seq: 2,
            kind: "tool",
            status: "ok",
            label: "Searched flights",
            startedAt: AT,
            endedAt: END,
            attempt: 2,
            attributes: {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": "web.search",
            },
            input: { q: "SFO" },
            output: "5 flights",
          },
        ],
        children: [],
        frames: [{ seq: 1, at: AT, stepId: toolStep.id, file: "frames/1.jpg" }],
      }),
    ).toBe(true);
  });

  it("adds stepId to tool calls, runId to automation runs and recordings", () => {
    const call = {
      id: "tc_1",
      runId: "run_1",
      messageId: null,
      tool: "web.search",
      paramsRedacted: {},
      paramsHash: "sha256:x",
      sideEffect: "read",
      target: null,
      decision: null,
      decisionRule: null,
      approvalId: null,
      taintIn: false,
      taintOut: false,
      resultRef: null,
      provenanceOut: "untrusted",
      receiptId: null,
      startedAt: AT,
      endedAt: null,
      status: "running",
    };
    expect(check(ToolCall, call)).toBe(true);
    expect(check(ToolCall, { ...call, stepId: toolStep.id })).toBe(true);
    const auto = {
      id: "ar_1",
      automationId: "au_1",
      threadId: null,
      taskId: null,
      trigger: "schedule",
      scheduledFor: AT,
      coalesced: 1,
      startedAt: AT,
      endedAt: END,
      status: "done",
      summary: null,
      notificationId: null,
    };
    expect(check(AutomationRun, auto)).toBe(true);
    expect(check(AutomationRun, { ...auto, runId: "run_1", usage: EMPTY_USAGE })).toBe(true);
    const rec = {
      id: "brec_1",
      taskId: null,
      threadId: "thr_1",
      startedAt: AT,
      endedAt: null,
      frameCount: 0,
      eventCount: 0,
      bytes: 0,
      libraryItemId: null,
    };
    expect(check(BrowserRecording, { ...rec, runId: "run_1" })).toBe(true);
  });
});

describe("runs.* and run.step", () => {
  it("registers every runs method with its scope", () => {
    const reads = [
      "runs.get",
      "runs.steps",
      "runs.list",
      "runs.children",
      "runs.step",
      "runs.frames",
      "runs.frame",
      "runs.export",
    ] as const;
    for (const m of reads) expect(methodSpec(m).scope, m).toBe("operator.read");
    expect(methodSpec("runs.delete")).toMatchObject({
      scope: "operator.write",
      sideEffecting: true,
    });
  });

  it("validates params and results", () => {
    expect(validateParams("runs.steps", { runId: "run_1", afterSeq: 4, limit: 500 })).toBeTruthy();
    expect(() => validateParams("runs.steps", { runId: "run_1", limit: 501 })).toThrow();
    expect(() => validateParams("runs.list", { limit: 101 })).toThrow();
    expect(
      validateParams("runs.list", { status: ["running"], kind: "task", parentRunId: "r" }),
    ).toBeTruthy();
    expect(() => validateParams("runs.export", { runId: "run_1", format: "otlp" })).toThrow();
    expect(() => validateParams("runs.frame", { runId: "run_1", seq: 1, size: "huge" })).toThrow();
    expect(
      validateResult("runs.get", { run, steps: [thinkingStep, toolStep], children: [] }),
    ).toBeTruthy();
    expect(
      validateResult("runs.step", { step: toolStep, input: { q: "SFO" }, truncated: false }),
    ).toBeTruthy();
    expect(validateResult("runs.steps", { steps: [toolStep], nextSeq: null })).toBeTruthy();
    expect(
      validateResult("runs.export", {
        fileName: "trace.json",
        mime: "application/vnd.psyche-trace+json",
        dataBase64: "e30=",
      }),
    ).toBeTruthy();
    expect(validateResult("runs.delete", { ok: true })).toBeTruthy();
  });

  it("validates the run.step event and memory.file.changed with its run", () => {
    expect(validateEventPayload("run.step", { runId: "run_1", step: toolStep })).toBeTruthy();
    expect(() => validateEventPayload("run.step", { runId: "run_1" })).toThrow();
    expect(
      validateEventPayload("memory.file.changed", {
        path: "notes/a.md",
        etag: "e1",
        source: "tool",
        runId: "run_1",
        stepId: toolStep.id,
      }),
    ).toBeTruthy();
  });
});

describe("psyche-trace+json v1", () => {
  const modelStep = {
    ...thinkingStep,
    id: "stp_model",
    seq: 3,
    kind: "model",
    text: undefined,
    usage: { ...EMPTY_USAGE, input: 120, output: 30 },
  } as const;
  const failed = {
    ...toolStep,
    id: "stp_failed",
    seq: 4,
    status: "failed",
    error: { code: "timeout", message: "The page took too long.", retryable: false },
  } as const;
  const helperRun = { ...run, id: "run_helper", parentRunId: "run_1", title: "Helper" };
  const helperStep = { ...toolStep, id: "stp_h1", runId: "run_helper", seq: 1, groupId: undefined };

  it("builds a valid document with OTel GenAI attributes that round-trips through JSON", () => {
    const trace = buildPsycheTrace({
      exportedAt: END,
      run: { ...run, title: "Lisbon", kind: "chat" },
      steps: [
        failed,
        modelStep,
        toolStep,
        thinkingStep,
        {
          ...thinkingStep,
          id: "stp_sub",
          seq: 5,
          kind: "subagent",
          text: undefined,
          childRunId: "run_helper",
        },
      ] as unknown as RunStep[],
      tools: { [toolStep.id]: "web.search" },
      payloads: { [toolStep.id]: { input: { q: "SFO" }, output: "5 flights" } },
      thinking: { [thinkingStep.id]: "full text" },
      children: [{ run: helperRun, steps: [helperStep] as unknown as RunStep[] }],
      frames: [{ seq: 1, at: AT, stepId: toolStep.id }],
    });
    expect(check(PsycheTrace, trace)).toBe(true);
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
    expect(trace.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    const byId = Object.fromEntries(trace.steps.map((s) => [s.id, s]));
    expect(byId[toolStep.id]?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "web.search",
      "gen_ai.tool.call.id": "tc_1",
    });
    expect(byId[toolStep.id]).toMatchObject({ label: "Searched flights", input: { q: "SFO" } });
    expect(byId.stp_model?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": run.modelRef,
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
    });
    expect(byId.stp_sub?.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(byId[thinkingStep.id]?.thinking).toBe("full text");
    expect(trace.frames).toEqual([{ seq: 1, at: AT, stepId: toolStep.id, file: "frames/1.jpg" }]);

    const md = traceMarkdown(trace);
    expect(md).toContain("# Lisbon (done)");
    expect(md).toContain("2. ✓ Searched flights — google.com (3 s) · attempt 2");
    expect(md).toContain("    1. ✓ Searched flights");
    expect(md).toContain("## What went wrong");
    expect(md).toContain("The page took too long.");
  });
});
