import type { MethodParams, RunBudget, SpecialistJob, SpecialistRole } from "@psyche/protocol";
import { useCallback, useMemo } from "react";
import { type LoadState, useLoader, useTask } from "./hooks.ts";
import { useStore, useStoreState } from "./provider.tsx";
import { put, type UiState } from "./state.ts";
import type { GatewayStore } from "./store.ts";

/**
 * Background specialists' data layer (docs/agent/specialists-2026.md §6, #685): jobs from
 * `specialists.jobs`, kept live by `specialist.spawned / progress / result`, and the roles with
 * the owner's settings from `specialists.list`.
 */

export type SpecialistJobsFilter = Pick<MethodParams<"specialists.jobs">, "status" | "threadId">;

const EMPTY_JOBS: readonly SpecialistJob[] = [];
const EMPTY_ROLES: readonly SpecialistRole[] = [];

/** Jobs a `specialists.jobs` list returned, unless an event touched them after it was asked. */
function putJobs(s: UiState, jobs: readonly SpecialistJob[], version: number): UiState {
  const next = { ...s.specialistJobs };
  for (const job of jobs) {
    if ((s.touched[`specialistJobs:${job.taskId}`] ?? -1) > version) continue;
    next[job.taskId] = job;
  }
  return { ...s, specialistJobs: next };
}

async function loadJobs(st: GatewayStore, filter: SpecialistJobsFilter): Promise<void> {
  const version = st.version();
  const res = await st.call("specialists.jobs", filter);
  st.update((s) => putJobs(s, res.jobs, version));
}

/** Specialist jobs, newest first: all of them, or those a thread started (`threadId`). */
export function useSpecialistJobs(
  filter: SpecialistJobsFilter = {},
): LoadState & { jobs: readonly SpecialistJob[] } {
  const all = useStoreState((s) => s.specialistJobs);
  const { threadId, status } = filter;
  const statuses = status?.join(",");
  const load = useLoader(`specialistJobs:${threadId ?? "*"}:${statuses ?? "*"}`, (st) =>
    loadJobs(st, filter),
  );
  const jobs = useMemo(() => {
    const wanted = statuses?.split(",");
    const list = Object.values(all).filter(
      (j) =>
        (threadId === undefined || j.parentThreadId === threadId) &&
        (wanted === undefined || wanted.includes(j.status)),
    );
    return list.length === 0
      ? EMPTY_JOBS
      : list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [all, threadId, statuses]);
  return { ...load, jobs };
}

/** One job by its task id, with Retry (`tasks.retry`, a new attempt with the report's gaps). */
export function useSpecialistJob(taskId: string | null): LoadState & {
  job: SpecialistJob | null;
  retry: () => Promise<void>;
} {
  const store = useStore();
  const job = useStoreState((s) => (taskId === null ? undefined : s.specialistJobs[taskId]));
  const load = useLoader(taskId !== null && job === undefined ? "specialistJobs:*:*" : null, (st) =>
    loadJobs(st, {}),
  );
  const retry = useCallback(async () => {
    if (taskId === null) return;
    await store.call("tasks.retry", { taskId });
    store.update((s) => {
      const prev = s.specialistJobs[taskId];
      if (prev === undefined) return s;
      return {
        ...s,
        specialistJobs: { ...s.specialistJobs, [taskId]: { ...prev, status: "queued" } },
      };
    });
  }, [store, taskId]);
  return { ...load, job: job ?? null, retry };
}

/** The specialist roles (`specialists.list`): the skills' definitions plus the owner's settings. */
export function useSpecialistRoles(): LoadState & {
  roles: readonly SpecialistRole[];
  role: (id: string) => SpecialistRole | null;
} {
  const roles = useStoreState((s) => s.specialistRoles);
  const load = useLoader("specialistRoles", async (st) => {
    const res = await st.call("specialists.list", {});
    st.update((s) => ({ ...s, specialistRoles: res.roles }));
  });
  const list = roles ?? EMPTY_ROLES;
  const role = useCallback((id: string) => list.find((r) => r.role === id) ?? null, [list]);
  return { ...load, roles: list, role };
}

/** The limits a `tasks.update` budget asks for, in the job's own shape (minutes → wallMs). */
function limitOf(
  prev: RunBudget["limit"],
  budget: NonNullable<MethodParams<"tasks.update">["budget"]>,
): RunBudget["limit"] {
  return {
    ...prev,
    ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
    ...(budget.costUsd === undefined ? {} : { costUsd: budget.costUsd }),
    ...(budget.minutes === undefined ? {} : { wallMs: budget.minutes * 60_000 }),
  };
}

function withJob(s: UiState, taskId: string, patch: (j: SpecialistJob) => SpecialistJob): UiState {
  const job = s.specialistJobs[taskId];
  return job === undefined
    ? s
    : { ...s, specialistJobs: { ...s.specialistJobs, [taskId]: patch(job) } };
}

/**
 * The owner's controls for one running job (specialists §4.7): steer it (`tasks.steer`), pause,
 * resume or stop it (`tasks.pause / resume / cancel`), and give it more (`tasks.update`, capped by
 * the role in the Gateway). `task` is the job's Task, whose status tells paused from working.
 */
export function useSpecialistControls(taskId: string) {
  const store = useStore();
  const { task, pause, resume, cancel } = useTask(taskId);
  const steer = useCallback(
    async (text: string) => {
      const r = await store.call("tasks.steer", { taskId, text });
      store.update((s) => put(s, "tasks", r.task));
    },
    [store, taskId],
  );
  const giveMore = useCallback(
    (budget: NonNullable<MethodParams<"tasks.update">["budget"]>) =>
      store.mutate({
        optimistic: (s) =>
          withJob(s, taskId, (j) => ({
            ...j,
            budget: { ...j.budget, limit: limitOf(j.budget.limit, budget) },
          })),
        run: () => store.call("tasks.update", { taskId, budget }),
        commit: (s, r) => {
          const limit = r.task.specialist?.budget.limit;
          const next = put(s, "tasks", r.task);
          return withJob(next, taskId, (j) => ({
            ...j,
            budget: { ...j.budget, limit: limit ?? limitOf(j.budget.limit, budget) },
          }));
        },
      }),
    [store, taskId],
  );
  return {
    task,
    steer,
    giveMore,
    pause: () => pause(taskId),
    resume: () => resume(taskId),
    cancel: () => cancel(taskId),
  };
}
