import type { Run, RunStep, ToolCall } from "@psyche/protocol";
import { SAMPLE_APPROVAL_REQUEST } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GatedAgentLoop } from "./agent.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

/**
 * Timeline truthfulness: a model call keeps its input and output, a failing tool or run says
 * why on a failed step, a denied approval is denied (never green), and a reload keeps all of it.
 */

const SECRET = "hunter2-vault-value";
const redact = (text: string) => text.replaceAll(SECRET, "‹vault: bank›");
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001 };

let t: TestGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
});

async function setup() {
  const agent = new GatedAgentLoop();
  t = await startTestGateway({ agent, traceRedact: redact });
  const owner = await adminClient(t.gateway);
  clients.push(owner);
  const { thread } = await owner.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    ik(),
  );
  const turn = async () => {
    await owner.call("chat.send", { threadId: thread.id, content: "Go" }, ik());
    await t?.gateway.context.sessions.idle();
    return agent.turns.at(-1)?.runId as string;
  };
  const get = (runId: string) => owner.call<{ run: Run; steps: RunStep[] }>("runs.get", { runId });
  return { agent, gw: t.gateway, owner, turn, get };
}

const record = (runId: string, id: string): ToolCall => ({
  id,
  runId,
  messageId: null,
  tool: "web.fetch",
  paramsRedacted: { url: "https://bank.example" },
  paramsHash: "sha256:x",
  sideEffect: "read",
  target: null,
  decision: null,
  decisionRule: null,
  approvalId: null,
  taintIn: false,
  taintOut: false,
  resultRef: null,
  provenanceOut: "trusted",
  receiptId: null,
  startedAt: "2026-10-25T10:00:00.000Z",
  endedAt: "2026-10-25T10:00:01.000Z",
  status: "failed",
});

describe("model call input and output", () => {
  it("records the prompt, tools and reply (masked, taint kept) and caps a huge prompt", async () => {
    const { agent, gw, owner, turn, get } = await setup();
    const huge = "y".repeat(400_000);
    agent.script([
      { type: "usage", usage },
      {
        type: "do",
        fn: () =>
          gw.context.runTrace.modelCall({
            runId: agent.turns.at(-1)?.runId as string,
            system: "You are Psyche.",
            messages: [
              { role: "user", parts: [{ type: "text", text: `My pin is ${SECRET}` }] },
              { role: "user", parts: [{ type: "text", text: huge }] },
            ],
            tools: [{ name: "web.fetch", description: "Fetch a page" }] as never,
            output: {
              text: "Done.",
              calls: [{ id: "c1", name: "web.fetch", input: { url: "https://x.example" } }],
              finish: "stop",
            },
            taint: true,
          }),
      },
      { type: "end", outcome: "final" },
    ]);
    const runId = await turn();
    const { steps } = await get(runId);
    const model = steps.find((s) => s.kind === "model") as RunStep;
    expect(model.status).toBe("ok");
    expect(model.preview?.input).toContain("2 messages, 1 tools");
    expect(model.preview?.output).toBe("Done.");
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    const detail = await owner.call<{
      input: string;
      output: {
        text: string;
        stopReason: string;
        toolCalls: unknown[];
        taint: boolean;
        usage: unknown;
      };
      truncated: boolean;
    }>("runs.step", { runId, stepId: model.id });

    expect(detail.truncated).toBe(true);
    expect(detail.input).toContain("You are Psyche.");
    expect(detail.input).toContain("‹vault: bank›");
    expect(detail.input).not.toContain(SECRET);
    expect(Buffer.byteLength(detail.input)).toBeLessThanOrEqual(130 * 1024);
    expect(detail.output).toMatchObject({ text: "Done.", stopReason: "stop", taint: true });
    expect(detail.output.toolCalls).toHaveLength(1);
    expect(detail.output.usage).toMatchObject({ input: 100, output: 20 });
  });

  it("marks a model call that ended in an error as failed, with the error", async () => {
    const { agent, gw, turn, get } = await setup();
    agent.script([
      { type: "usage", usage },
      {
        type: "do",
        fn: () =>
          gw.context.runTrace.modelCall({
            runId: agent.turns.at(-1)?.runId as string,
            system: "",
            messages: [],
            tools: [],
            output: { text: "", calls: [], finish: "error", error: `rate limited ${SECRET}` },
            taint: false,
          }),
      },
      { type: "end", outcome: "failed", error: "rate limited" },
    ]);
    const { steps } = await get(await turn());
    const model = steps.find((s) => s.kind === "model") as RunStep;
    expect(model.status).toBe("failed");
    expect(model.error).toMatchObject({
      code: "model_error",
      message: "rate limited ‹vault: bank›",
    });
  });
});

describe("truthful status", () => {
  it("a tool that returns an error fails its step with the tool's message, and the run", async () => {
    const { agent, gw, turn, get } = await setup();
    agent.script([
      {
        type: "tool_call",
        toolCallId: "tc_e",
        tool: "web.fetch",
        status: "running",
        level1: "Reading",
      },
      {
        type: "tool_call",
        toolCallId: "tc_e",
        tool: "web.fetch",
        status: "failed",
        level1: "Reading",
      },
      {
        type: "do",
        fn: () =>
          gw.context.runTrace.toolResult(record(agent.turns.at(-1)?.runId as string, "tc_e"), {
            output: { error: "403 Forbidden by the site" },
            isError: true,
            provenance: "trusted",
          }),
      },
      { type: "end", outcome: "failed", error: "The page refused us" },
    ]);
    const { run, steps } = await get(await turn());
    const tool = steps.find((s) => s.kind === "tool") as RunStep;
    expect(tool.status).toBe("failed");
    expect(tool.error?.message).toBe("403 Forbidden by the site");
    expect(run.status).toBe("failed");
    expect(steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("a run that failed with no failing step gets a failed step that says why", async () => {
    const { agent, turn, get } = await setup();
    agent.script([
      { type: "usage", usage },
      { type: "end", outcome: "failed", error: "token_budget_exceeded" },
    ]);
    const { run, steps } = await get(await turn());
    expect(run.status).toBe("failed");
    const failed = steps.filter((s) => s.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error?.message).toBe("token_budget_exceeded");
    expect(steps.some((s) => s.status === "ok" && s.kind === "model")).toBe(true);
  });

  it("a declined approval and the call it blocked are denied, not green", async () => {
    const { agent, gw, owner, turn, get } = await setup();
    const events = [
      { type: "approval_requested", approval: { ...SAMPLE_APPROVAL_REQUEST, id: "ap_no" } },
      {
        type: "tool_call",
        toolCallId: "tc_mail",
        tool: "email.send",
        status: "blocked",
        level1: "Sending the email",
        details: { approvalId: "ap_no" },
      },
    ] as const;
    agent.script([
      {
        type: "do",
        fn: () => {
          const turnInput = agent.turns.at(-1);
          for (const e of events)
            gw.context.runTrace.apply(
              turnInput?.runId as string,
              turnInput?.threadId as string,
              { ...e, runId: turnInput?.runId } as never,
            );
        },
      },
      { type: "end", outcome: "final" },
    ]);
    const runId = await turn();
    const { steps } = await get(runId);
    expect(steps.find((s) => s.kind === "approval")?.status).toBe("denied");
    expect(steps.find((s) => s.kind === "tool")?.status).toBe("denied");
    // A reload (a fresh read) keeps the statuses.
    const again = await get(runId);
    expect(again.steps.map((s) => s.status)).toEqual(steps.map((s) => s.status));
    void owner;
  });
});
