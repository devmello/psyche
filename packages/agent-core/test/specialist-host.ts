import type { SpecialistJob, SpecialistResult, SpecialistSpec } from "@psyche/protocol";
import {
  type BudgetDecision,
  buildSpecialistSpec,
  type SpecialistHost,
  type SpecialistJobInput,
  type SpecialistReportInput,
  type SpecialistRoleDef,
} from "../src/index.ts";
import { harness } from "./harness.ts";

/** Shared fixtures for the specialist tests: a role, a fake Gateway host, a child task. */

export const researcher: SpecialistRoleDef = {
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
export class FakeHost implements SpecialistHost {
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
  readonly specs = new Map<string, SpecialistSpec>();
  readonly decisions = new Map<string, BudgetDecision>();
  async updateSpec(taskId: string, patch: (s: SpecialistSpec) => SpecialistSpec) {
    const current = this.specs.get(taskId) ?? (await this.tasks.get(taskId))?.specialist;
    if (current === undefined) throw new Error(`no spec for ${taskId}`);
    const next = patch(structuredClone(current));
    this.specs.set(taskId, next);
    return next;
  }
  async budgetDecision(taskId: string) {
    return this.decisions.get(taskId);
  }
  async promptSection() {
    return "Specialists run a job in the background with specialist.spawn.";
  }
}

export function withHost(script: NonNullable<Parameters<typeof harness>[0]>["script"]) {
  // The host must share the loop's task engine, so build the harness first, then the loop.
  const base = harness({ script });
  const host = new FakeHost(base.tasks);
  const h = harness({ script, loop: { specialists: host, tasks: base.tasks } });
  return { h, host, tasks: base.tasks };
}

export async function childTask(
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
