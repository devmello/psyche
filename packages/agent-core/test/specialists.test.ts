import type { SpecialistJob, SpecialistResult, SpecialistSpec } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  buildSpecialistSpec,
  clampBudget,
  minMode,
  type SpecialistHost,
  type SpecialistJobInput,
  type SpecialistReportInput,
  type SpecialistRoleDef,
} from "../src/index.ts";
import { call, endOf, harness, recorder, resultsIn, runTurn, say, spec } from "./harness.ts";

const researcher: SpecialistRoleDef = {
  role: "researcher",
  label: "Researcher",
  description: "Multi-source research into a cited brief.",
  prompt: "You are the researcher. Find sources, cite them, and report.",
  model: "fake/research",
  maxMode: "balanced",
  tools: ["web_search", "web_fetch", "update_plan", "schedule", "specialist.spawn"],
  memory: "none",
  result: "findings",
  planFirst: false,
  budget: { tokens: 400_000, costUsd: 2, minutes: 30 },
  caps: { tokens: 1_000_000, costUsd: 10, minutes: 240, maxHours: 24 },
  approvals: ["new_origin"],
};

/** An in-memory Gateway side: jobs become FakeTaskEngine tasks; reports are recorded. */
class FakeHost implements SpecialistHost {
  readonly created: SpecialistJobInput[] = [];
  readonly reports: { taskId: string; report: SpecialistReportInput; tainted: boolean }[] = [];
  readonly tasks: ReturnType<typeof harness>["tasks"];
  readonly roleList: SpecialistRoleDef[];
  constructor(
    tasks: ReturnType<typeof harness>["tasks"],
    roleList: SpecialistRoleDef[] = [researcher],
  ) {
    this.tasks = tasks;
    this.roleList = roleList;
  }
  async roles() {
    return this.roleList;
  }
  async createJob(input: SpecialistJobInput) {
    this.created.push(structuredClone(input));
    const task = await this.tasks.create({
      threadId: `thr_child_${this.created.length}`,
      title: input.title,
      goal: input.brief,
      createdFrom: "subagent",
      taint: input.taint,
      specialist: input.spec,
    });
    return { taskId: task.id, threadId: task.threadId, queuePosition: null };
  }
  async jobs(): Promise<SpecialistJob[]> {
    return [];
  }
  async report(taskId: string, report: SpecialistReportInput, meta: { tainted: boolean }) {
    this.reports.push({ taskId, report, tainted: meta.tainted });
    const result: SpecialistResult = {
      outcome: report.outcome,
      summary: report.summary,
      findings: report.findings ?? [],
      artifacts: report.artifacts ?? [],
      next: report.next ?? [],
      gaps: report.gaps ?? [],
      receipts: [],
      tainted: meta.tainted,
    };
    return result;
  }
  async promptSection() {
    return "Specialists run a job in the background with specialist.spawn.";
  }
}

function withHost(script: NonNullable<Parameters<typeof harness>[0]>["script"]) {
  // The host must share the loop's task engine, so build the harness first, then the loop.
  const base = harness({ script });
  const host = new FakeHost(base.tasks);
  const h = harness({ script, loop: { specialists: host, tasks: base.tasks } });
  return { h, host, tasks: base.tasks };
}

describe("spec building (specialists §4.1)", () => {
  it("clamps budget to the role's caps and the mode to the stricter one", () => {
    expect(clampBudget(researcher, { tokens: 5_000_000, minutes: 10 })).toEqual({
      tokens: 1_000_000,
      costUsd: 2,
      wallMs: 600_000,
    });
    expect(minMode("auto", "balanced")).toBe("balanced");
    expect(minMode("manual", "balanced")).toBe("manual");
    const s = buildSpecialistSpec(
      researcher,
      { role: "researcher", title: "t", brief: "b", deadline: "2099-01-01T00:00:00Z" },
      {
        threadId: "thr_1",
        runId: "run_1",
        rootRunId: null,
        permissionMode: "auto",
        taint: false,
        taintSources: [],
        incognito: false,
      },
      Date.UTC(2026, 9, 26),
    );
    expect(s.permissionMode).toBe("balanced");
    // Withheld whatever the allowlist says (§4.3).
    expect(s.tools).toEqual(["web_search", "web_fetch", "update_plan"]);
    // Deadline capped at maxHours (24 h).
    expect(s.deadline).toBe("2026-10-27T00:00:00.000Z");
    expect(s.rootRunId).toBe("run_1");
    expect(s.preflight).toEqual([
      { kind: "new_origin", label: "Will ask before opening new sites" },
    ]);
  });
});

describe("specialist.spawn", () => {
  it("returns at once with a pre-flight, emits the subagent step and the parent continues", async () => {
    const { h, host } = withHost([
      call("s1", "specialist.spawn", {
        role: "researcher",
        title: "Apartments near the office",
        brief: "Find three under $2,500.",
        budget: { tokens: 100_000 },
        inputs: { urls: ["https://example.com/listings"] },
      }),
      say("I've asked the researcher; the result will be in your Inbox."),
    ]);
    const events = await runTurn(h, "find apartments", { permissionMode: "auto" });
    expect(endOf(events).outcome).toBe("final");
    expect(host.created).toHaveLength(1);
    const job = host.created[0] as SpecialistJobInput;
    expect(job.spec).toMatchObject({
      role: "researcher",
      parentThreadId: "thr_1",
      permissionMode: "balanced",
      model: "fake/research",
      budget: { limit: { tokens: 100_000, costUsd: 2, wallMs: 1_800_000 } },
      inputs: { urls: ["https://example.com/listings"] },
    });
    expect(job.brief).toContain("Find three under $2,500.");
    expect(job.brief).toContain("- https://example.com/listings");
    expect(job.brief).toContain("specialist.report");
    const step = events.find((e) => e.type === "subagent");
    expect(step).toMatchObject({
      toolCallId: "s1",
      status: "working",
      label: "Researcher · Apartments near the office",
    });
    const out = resultsIn(h.provider.requests[1]).get("s1")?.output as {
      preflight: unknown[];
      status: string;
    };
    expect(out.status).toBe("running");
    expect(out.preflight).toEqual([
      { kind: "new_origin", label: "Will ask before opening new sites" },
    ]);
  });

  it("puts the Specialists section in the owner's prompt", async () => {
    const { h } = withHost([say("ok")]);
    await runTurn(h, "hi");
    expect(h.provider.requests[0]?.system).toContain("Specialists run a job in the background");
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).toContain("specialist.spawn");
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("specialist.report");
  });

  it("is withheld in plan mode and unattended runs, and refused to non-owners and unknown roles", async () => {
    const { h, host } = withHost([
      say("plan"),
      say("heartbeat"),
      call("s1", "specialist.spawn", { role: "researcher", title: "x", brief: "y" }),
      say("no"),
      call("s2", "specialist.spawn", { role: "astrologer", title: "x", brief: "y" }),
      say("no"),
    ]);
    await runTurn(h, "plan it", { permissionMode: "plan", threadId: "thr_a" });
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("specialist.spawn");
    await runTurn(h, "beat", { mode: "unattended", threadId: "thr_b" });
    expect(h.provider.requests[1]?.tools?.map((t) => t.name)).not.toContain("specialist.spawn");
    await runTurn(h, "do it", {
      threadId: "thr_c",
      requester: { role: "designated", channel: "telegram", senderId: "42" },
    });
    expect(JSON.stringify(resultsIn(h.provider.requests[3]).get("s1")?.output)).toContain(
      "only the owner",
    );
    await runTurn(h, "do it", { threadId: "thr_d" });
    expect(JSON.stringify(resultsIn(h.provider.requests[5]).get("s2")?.output)).toContain(
      "off or unknown",
    );
    expect(host.created).toHaveLength(0);
  });
});

async function childTask(
  tasks: ReturnType<typeof harness>["tasks"],
  over: Partial<SpecialistSpec> = {},
) {
  const s = buildSpecialistSpec(
    researcher,
    { role: "researcher", title: "Apartments", brief: "Find three." },
    {
      threadId: "thr_parent",
      runId: "run_parent",
      rootRunId: null,
      permissionMode: "manual",
      taint: false,
      taintSources: [],
      incognito: false,
    },
    Date.UTC(2026, 9, 26),
  );
  return tasks.create({
    threadId: "thr_child",
    title: "Apartments",
    goal: "Find three.",
    createdFrom: "subagent",
    specialist: { ...s, ...over },
  });
}

describe("a specialist's run (specialists §4.2–§4.3)", () => {
  it("runs on the role's model with the role prompt, its allowlist and a clamped mode", async () => {
    const { h, tasks } = withHost([
      call("r1", "specialist.report", { outcome: "done", summary: "Three found." }),
      say("Reported."),
    ]);
    h.loop.registry.register({ spec: spec("web_search", "read"), execute: recorder().execute });
    h.loop.registry.register({
      spec: spec("mail_send", "destructive"),
      execute: recorder().execute,
    });
    const task = await childTask(tasks);
    await runTurn(h, "Task: Apartments\n\nFind three.", {
      threadId: "thr_child",
      taskId: task.id,
      permissionMode: "auto",
    });
    const req = h.provider.requests[0];
    expect(req?.model).toBe("fake/research");
    expect(req?.system).toContain("You are the researcher.");
    expect(req?.system).not.toContain('id="skills"');
    expect(req?.system).not.toContain("Specialists run a job");
    const names = req?.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(["web_search", "update_plan", "ask_user", "specialist.report"]),
    );
    for (const n of ["mail_send", "specialist.spawn", "specialist.status", "schedule", "memory"]) {
      expect(names).not.toContain(n);
    }
    // min(auto, manual) = manual.
    expect(h.broker.decisions[0]?.ctx.permissionMode).toBe("manual");
  });

  it("delivers exactly one report; a second one is refused", async () => {
    const { h, host, tasks } = withHost([
      call("r1", "specialist.report", { outcome: "done", summary: "Three found." }),
      call("r2", "specialist.report", { outcome: "done", summary: "Again." }),
      say("done"),
    ]);
    const task = await childTask(tasks);
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports).toHaveLength(1);
    expect(host.reports[0]).toMatchObject({
      taskId: task.id,
      report: { summary: "Three found." },
      tainted: false,
    });
    expect(JSON.stringify(resultsIn(h.provider.requests[2]).get("r2")?.output)).toContain(
      "already reported",
    );
  });

  it("a run that ends without a report still delivers a partial one from its last message", async () => {
    const { h, host, tasks } = withHost([say("I found two listings but ran out of ideas.")]);
    const task = await childTask(tasks);
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports).toEqual([
      {
        taskId: task.id,
        report: {
          outcome: "partial",
          summary: "I found two listings but ran out of ideas.",
          gaps: ["It ended without calling specialist.report."],
        },
        tainted: false,
      },
    ]);
  });

  it("a tainted child reports as tainted", async () => {
    const { h, host, tasks } = withHost([
      call("f1", "web_fetch", {}),
      call("r1", "specialist.report", { outcome: "done", summary: "Read it." }),
      say("ok"),
    ]);
    h.loop.registry.register({
      spec: spec("web_fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    const task = await childTask(tasks, { permissionMode: "balanced" });
    await runTurn(h, "go", { threadId: "thr_child", taskId: task.id });
    expect(host.reports[0]?.tainted).toBe(true);
  });
});
