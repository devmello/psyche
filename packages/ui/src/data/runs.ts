import type {
  MethodParams,
  MethodResult,
  Run,
  RunFrame,
  RunStep,
  RunSummary,
  RunTraceFormat,
} from "@psyche/protocol";
import { useCallback, useMemo } from "react";
import { type LoadState, useGatewayQuery, useLoader } from "./hooks.ts";
import { useStore, useStoreState } from "./provider.tsx";
import { put, putMany, type RunStepDetail, upsertRunSteps } from "./state.ts";
import type { GatewayStore } from "./store.ts";

/**
 * The run trace's data layer (docs/design/run-trace-2026.md §4.4, T1): the chat's step log and
 * the agent sheet's Timeline and Activity read steps only through these hooks. Loads fill the
 * store; `run.step` and `run.updated` keep it live; after a gap or reconnect each hook reloads
 * (a run's steps from the last seq it has).
 */

const EMPTY_STEPS: readonly RunStep[] = [];
const EMPTY_FRAMES: readonly RunFrame[] = [];
const EMPTY_RUNS: readonly Run[] = [];
/** runs.steps pages up to the per-run cap (§4.5). */
const STEP_PAGE = 500;
const MAX_PAGES = 4;

/** Loads a run's steps after the last seq the store has, page by page. */
async function loadSteps(store: GatewayStore, runId: string): Promise<void> {
  const version = store.version();
  let afterSeq = (store.getState().runSteps[runId] ?? EMPTY_STEPS).at(-1)?.seq ?? 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await store.call("runs.steps", { runId, afterSeq, limit: STEP_PAGE });
    store.update((s) => upsertRunSteps(s, runId, res.steps, version));
    if (res.nextSeq == null || res.steps.length === 0) return;
    afterSeq = res.nextSeq;
  }
}

/** Downloads (or opens in the Library) a run's exported trace. */
export type ExportRun = (
  format: RunTraceFormat,
  options?: { includeFrames?: boolean },
) => Promise<MethodResult<"runs.export">>;

/**
 * One run with its steps and helper runs (`runs.get`), live. `exportTrace` and `deleteTrace`
 * act on it ("Delete trace" keeps receipts).
 */
export function useRun(runId: string | null): LoadState & {
  run: Run | null;
  steps: readonly RunStep[];
  children: readonly Run[];
  exportTrace: ExportRun;
  deleteTrace: () => Promise<void>;
} {
  const store = useStore();
  const run = useStoreState((s) => (runId === null ? undefined : s.runs[runId]));
  const steps = useStoreState((s) =>
    runId === null ? EMPTY_STEPS : (s.runSteps[runId] ?? EMPTY_STEPS),
  );
  const runs = useStoreState((s) => s.runs);
  const load = useLoader(runId === null ? null : `run:${runId}`, async (st) => {
    if (runId === null) return;
    const version = st.version();
    const res = await st.call("runs.get", { runId });
    st.update((s) =>
      upsertRunSteps(
        putMany(s, "runs", [res.run, ...res.children], version),
        runId,
        res.steps,
        version,
      ),
    );
    // runs.get returns the first 500; the rest page in.
    if (res.steps.length >= STEP_PAGE) await loadSteps(st, runId);
  });
  const children = useMemo(
    () =>
      runId === null
        ? EMPTY_RUNS
        : Object.values(runs)
            .filter((r) => r.parentRunId === runId)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [runs, runId],
  );
  const exportTrace = useCallback<ExportRun>(
    (format, options = {}) => {
      if (runId === null) return Promise.reject(new Error("no run"));
      return store.call("runs.export", {
        runId,
        format,
        ...(options.includeFrames === undefined ? {} : { includeFrames: options.includeFrames }),
      });
    },
    [store, runId],
  );
  const deleteTrace = useCallback(async () => {
    if (runId === null) return;
    await store.mutate({
      optimistic: (s) => {
        const { [runId]: _steps, ...runSteps } = s.runSteps;
        const { [runId]: _frames, ...runFrames } = s.runFrames;
        return { ...s, runSteps, runFrames };
      },
      run: () => store.call("runs.delete", { runId }),
      commit: (s) => {
        const { [runId]: _steps, ...runSteps } = s.runSteps;
        const { [runId]: _frames, ...runFrames } = s.runFrames;
        const prefix = `${runId}/`;
        const runStepDetails = Object.fromEntries(
          Object.entries(s.runStepDetails).filter(([k]) => !k.startsWith(prefix)),
        );
        return { ...s, runSteps, runFrames, runStepDetails };
      },
    });
  }, [store, runId]);
  return { ...load, run: run ?? null, steps, children, exportTrace, deleteTrace };
}

/** A run's steps in seq order, live (`run.step`), catching up from the last seq after a gap. */
export function useRunSteps(runId: string | null): LoadState & { steps: readonly RunStep[] } {
  const steps = useStoreState((s) =>
    runId === null ? EMPTY_STEPS : (s.runSteps[runId] ?? EMPTY_STEPS),
  );
  const load = useLoader(runId === null ? null : `runSteps:${runId}`, (st) =>
    runId === null ? Promise.resolve() : loadSteps(st, runId),
  );
  return { ...load, steps };
}

export type RunsFilter = MethodParams<"runs.list">;

function matches(run: Run, f: RunsFilter): boolean {
  if (f.status !== undefined && !f.status.includes(run.status)) return false;
  if (f.kind !== undefined && run.kind !== f.kind) return false;
  if (f.threadId !== undefined && run.threadId !== f.threadId) return false;
  if (f.taskId !== undefined && run.taskId !== f.taskId) return false;
  if (f.parentRunId !== undefined && run.parentRunId !== f.parentRunId) return false;
  if (f.rootRunId !== undefined && run.rootRunId !== f.rootRunId) return false;
  if (f.since !== undefined && run.startedAt < f.since) return false;
  // An automation is known only from the list's join; a new run shows on the next load.
  return f.automationId === undefined;
}

/**
 * Runs for Activity and mission control (`runs.list`), newest first. Live `run.updated` changes
 * win over the list, and runs that started after it appear when they match the filter.
 */
export function useRunsList(filter: RunsFilter = {}): LoadState & {
  runs: readonly RunSummary[];
  nextCursor: string | null;
} {
  const query = useGatewayQuery("runs.list", filter);
  const live = useStoreState((s) => s.runs);
  const runs = useMemo(() => {
    const listed = query.data?.runs ?? [];
    const ids = new Set(listed.map((r) => r.id));
    const merged: RunSummary[] = listed.map((r) => ({ ...r, ...live[r.id] }));
    if (filter.cursor === undefined) {
      for (const r of Object.values(live)) if (!ids.has(r.id) && matches(r, filter)) merged.push(r);
    }
    return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [query.data, live, filter]);
  return {
    loading: query.loading,
    error: query.error,
    reload: query.reload,
    runs,
    nextCursor: query.data?.nextCursor ?? null,
  };
}

/** One step's retained thinking text and its tool input and output (`runs.step`). */
export function useRunStep(
  runId: string | null,
  stepId: string | null,
): LoadState & { detail: RunStepDetail | null } {
  const key = runId === null || stepId === null ? null : `${runId}/${stepId}`;
  const detail = useStoreState((s) => (key === null ? undefined : s.runStepDetails[key]));
  const load = useLoader(
    key !== null && detail === undefined ? `runStep:${key}` : null,
    async (st) => {
      if (runId === null || stepId === null || key === null) return;
      const res = await st.call("runs.step", { runId, stepId });
      st.update((s) => ({
        ...upsertRunSteps(s, runId, [res.step]),
        runStepDetails: { ...s.runStepDetails, [key]: res },
      }));
    },
  );
  return { ...load, detail: detail ?? null };
}

/**
 * The frames Psyche saw during a run (or one step), and `image(seq, size)` to read one. Frame
 * images are not kept in the store: the viewer caches what it shows.
 */
export function useRunFrames(
  runId: string | null,
  stepId?: string,
): LoadState & {
  frames: readonly RunFrame[];
  image: (seq: number, size: "thumb" | "full") => Promise<MethodResult<"runs.frame">>;
} {
  const store = useStore();
  const all = useStoreState((s) =>
    runId === null ? EMPTY_FRAMES : (s.runFrames[runId] ?? EMPTY_FRAMES),
  );
  const load = useLoader(runId === null ? null : `runFrames:${runId}`, async (st) => {
    if (runId === null) return;
    const res = await st.call("runs.frames", { runId });
    st.update((s) => ({ ...s, runFrames: { ...s.runFrames, [runId]: res.frames } }));
  });
  const frames = useMemo(
    () => (stepId === undefined ? all : all.filter((f) => f.stepId === stepId)),
    [all, stepId],
  );
  const image = useCallback(
    (seq: number, size: "thumb" | "full") => {
      if (runId === null) return Promise.reject(new Error("no run"));
      return store.call("runs.frame", { runId, seq, size });
    },
    [store, runId],
  );
  return { ...load, frames, image };
}

/** Puts a run the caller already has (a story, a `runs.list` row) into the store. */
export function seedRun(store: GatewayStore, run: Run, steps: readonly RunStep[] = []): void {
  store.update((s) => upsertRunSteps(put(s, "runs", run), run.id, steps));
}
