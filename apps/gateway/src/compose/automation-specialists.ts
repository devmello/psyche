import { buildSpecialistSpec, type SpecialistHost, specialistBrief } from "@psyche/agent-core";
import { getThread, type PsycheDb } from "@psyche/db";
import { PsycheError, type Task, TERMINAL_TASK_STATUSES } from "@psyche/protocol";
import type { RunLauncher, RunResult } from "@psyche/scheduler";
import type { SqliteTaskEngine } from "@psyche/tasks";

/**
 * Scheduled automations as specialists (docs/agent/specialists-2026.md §4.10). An automation
 * with a `specialist {role, budget, deliver}` runs each occurrence as an unattended specialist
 * job: the automation's prompt is the brief, the resolved session thread is the parent, and the
 * job runs in the specialist pool. Approvals wait in the queue with a notification, as for any
 * unattended run. Other automations go to `inner` unchanged.
 */

export interface AutomationSpecialistDeps {
  db: PsycheDb;
  tasks: SqliteTaskEngine;
  host: Pick<SpecialistHost, "roles" | "createJob">;
  now: () => number;
}

/** A finished job as an automation run's outcome: partial counts as delivered work. */
export function specialistRunResult(task: Task): RunResult {
  const base = { taskId: task.id };
  const report = task.specialist?.result ?? null;
  const summary = report?.summary ?? task.summary ?? null;
  if (task.status === "cancelled" || report?.outcome === "cancelled") {
    return { ...base, status: "cancelled", summary };
  }
  if (report !== null) {
    return { ...base, status: report.outcome === "failed" ? "failed" : "done", summary };
  }
  if (task.status === "done") {
    return task.outcome?.result === "no_reply"
      ? { ...base, status: "no_reply", summary: null }
      : { ...base, status: "done", summary };
  }
  return { ...base, status: "failed", summary };
}

export function withAutomationSpecialists(
  inner: RunLauncher,
  deps: AutomationSpecialistDeps,
): RunLauncher {
  const { tasks } = deps;
  const settle = (taskId: string): Promise<RunResult> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (r: RunResult) => {
        if (done) return;
        done = true;
        unsubscribe();
        resolve(r);
      };
      const unsubscribe = tasks.subscribe((e) => {
        if (e.event !== "task.updated" || e.payload.task.id !== taskId) return;
        if (TERMINAL_TASK_STATUSES.includes(e.payload.task.status)) {
          finish(specialistRunResult(e.payload.task));
        }
      });
      tasks.get(taskId).then((t) => {
        if (t === undefined) finish({ status: "failed", summary: "The job disappeared", taskId });
        else if (TERMINAL_TASK_STATUSES.includes(t.status)) finish(specialistRunResult(t));
      });
    });
  const isSpecialistJob = async (taskId: string | null | undefined) =>
    taskId != null && (await tasks.get(taskId))?.createdFrom === "subagent";

  return {
    async launch(request) {
      const want = request.automation.specialist;
      if (want === undefined) return inner.launch(request);
      const role = (await deps.host.roles()).find((r) => r.role === want.role);
      if (role === undefined) {
        throw new PsycheError("unavailable", `the ${want.role} specialist is off or not installed`);
      }
      const parent = getThread(deps.db, request.threadId);
      const taintSources = request.taintSources ?? [];
      const built = buildSpecialistSpec(
        role,
        {
          role: want.role,
          title: request.automation.title,
          brief: request.prompt,
          ...(want.budget === undefined ? {} : { budget: want.budget }),
          ...(want.deliver === undefined ? {} : { deliver: want.deliver }),
          // Nobody is there to approve a plan: unattended jobs start working (§4.10).
          planFirst: false,
        },
        {
          threadId: request.threadId,
          runId: request.run.id,
          rootRunId: null,
          permissionMode: parent?.permissionMode ?? "balanced",
          taint: taintSources.length > 0,
          taintSources,
          incognito: false,
        },
        deps.now(),
      );
      // No run spawned it: the automation did, and the card says so ("From your automation").
      const spec = { ...built, parentRunId: null, rootRunId: null };
      const job = await deps.host.createJob({
        spec,
        title: request.automation.title,
        brief: specialistBrief(request.prompt, spec),
        incognito: false,
        taint: taintSources.length > 0,
        taintSources,
        unattended: true,
      });
      return { taskId: job.taskId, result: settle(job.taskId) };
    },
    reattach(run) {
      // A restart may find a specialist job still running; it settles like any other.
      if (run.taskId == null) return inner.reattach?.(run);
      const taskId = run.taskId;
      return isSpecialistJob(taskId).then((yes) =>
        yes ? settle(taskId) : (inner.reattach?.(run) ?? settle(taskId)),
      );
    },
    async cancel(run, reason) {
      if (!(await isSpecialistJob(run.taskId))) return inner.cancel?.(run, reason);
      const task = await tasks.get(run.taskId as string);
      if (task !== undefined && !TERMINAL_TASK_STATUSES.includes(task.status)) {
        await tasks.cancel(task.id, reason);
      }
    },
  };
}
