import { DREAMING_PROMPT_MARKER } from "@psyche/memory";
import { parseJobMarker } from "@psyche/proactive";
import {
  type Automation,
  type AutomationRun,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type ScheduledItem,
  type ScheduledRunEntry,
  type ScheduledRunState,
} from "@psyche/protocol";
import type { SqliteScheduler } from "@psyche/scheduler";
import { WEEKLY_CARD_MARKER } from "./weekly-card.ts";

/**
 * `scheduled.*` (the Scheduled screen): everything the scheduler runs, sorted into the owner's
 * own automations and Psyche's routines. Psyche's routines are the scheduler's `system`
 * automations; each is recognised by its prompt marker (`[psyche:<job> <arg>]`, dreaming and the
 * weekly card have their own).
 *
 * Pausing a routine cannot flip the automation's `enabled`: the owners of these automations
 * (Settings → Daily, Mail & meetings, the Feed) re-write it from their settings at every start.
 * The pause is a list of routine ids kept in a setting and enforced when a scheduled run is
 * launched (`withPausedRoutines`); Run now is a manual run and still goes through.
 */

export const PAUSED_ROUTINES_KEY = "scheduled.pausedRoutines";

interface RoutineInfo {
  /** `/settings/<id>`, where the routine is switched on and configured. */
  settings?: string;
  /** Approvals the routine may need beyond what Settings already granted. */
  approvals?: readonly string[];
  /** Governed by a Settings switch: the scheduler's `enabled` is that switch, not a pause. */
  bySettings?: boolean;
}

/** The routines Psyche schedules, by job name. Unknown jobs are still routines, with no extras. */
const ROUTINES: Readonly<Record<string, RoutineInfo>> = {
  "daily-brief": { settings: "daily", bySettings: true },
  "daily-wrapup": { settings: "daily", bySettings: true },
  "mail-digest": { settings: "mail", bySettings: true },
  "mail-voice": { settings: "mail", bySettings: true },
  "mail-watch": { settings: "mail" },
  "mail-focus": { settings: "mail", bySettings: true, approvals: ["calendar_write"] },
  "meeting-prep": { settings: "mail", bySettings: true },
  "notes-folder": { settings: "mail", bySettings: true },
  "feed-brief": {},
  "feed-briefing": {},
  "ideas-mine": {},
  "ideas-deliver": {},
  "goal-checkin": {},
  "goal-watch": {},
  "memory-dreaming": { settings: "people" },
  "weekly-card": {},
  heartbeat: {},
};

/** The routine's key ("daily-brief"), and the id its pause is kept under. */
export function routineOf(a: Pick<Automation, "prompt" | "kind">): { key: string; id: string } {
  const prompt = a.prompt.trim();
  if (prompt === DREAMING_PROMPT_MARKER) return { key: "memory-dreaming", id: "memory-dreaming" };
  if (prompt === WEEKLY_CARD_MARKER) return { key: "weekly-card", id: "weekly-card" };
  if (a.kind === "heartbeat") return { key: "heartbeat", id: "heartbeat" };
  const m = parseJobMarker(prompt);
  if (m !== undefined) return { key: m.job, id: `${m.job}:${m.arg}` };
  return { key: "system", id: `system:${prompt.slice(0, 64)}` };
}

const WORKFLOW = /^\[workflow:([^\]\s]+)\]/;

/** The one line saying what an owner automation does: its own instruction, not the contract. */
export function summaryOf(prompt: string): string {
  const paragraphs = prompt
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  // A workflow run: header, the linked runs, the shared-state rules, then the run's own job.
  const own = WORKFLOW.test(prompt.trim()) ? (paragraphs[3] ?? paragraphs[0]) : paragraphs[0];
  const line = (own ?? "").split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export interface ScheduledKv {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ScheduledDeps {
  scheduler: SqliteScheduler;
  kv: ScheduledKv;
  /** The owner's IANA zone. */
  timezone: () => string;
  /** The status of a run's task, to tell a run parked on an approval from one that is working. */
  taskStatus?: (taskId: string) => Promise<string | undefined>;
  /** Whether unattended runs can count on the browser; undefined when unknown (no browser part). */
  browserAvailable?: () => { ok: boolean; reason?: string } | undefined;
  /** Open approvals per task id. */
  pendingApprovals?: () => Promise<ReadonlyMap<string, number>>;
}

/**
 * The one status a run is shown with, from the scheduler's run status (the source of truth) and,
 * while it runs, its task's: `done` is the only success; a skipped or no-reply run says why.
 */
export function runState(status: AutomationRun["status"], taskStatus?: string): ScheduledRunState {
  switch (status) {
    case "running":
      return taskStatus === "awaiting_approval" || taskStatus === "awaiting_input"
        ? "waiting"
        : "running";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "skipped";
  }
}

const NOTHING_TO_REPORT = "Nothing to report";

type ScheduledMethod = "scheduled.list" | "scheduled.pause" | "scheduled.runs";
export type ScheduledHandlers = {
  [M in ScheduledMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

export function pausedRoutines(kv: ScheduledKv): ReadonlySet<string> {
  const v = kv.get(PAUSED_ROUTINES_KEY);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
}

/** Whether an automation's instruction is likely to drive the browser (pre-flight heuristic). */
const BROWSER_USE =
  /\b(browser|website|web ?site|web ?page|canvas|portal|sign[- ]?in|log[- ]?in|https?:\/\/|[a-z0-9-]+\.(com|edu|org|net|io)\b)/i;
export const usesBrowser = (prompt: string): boolean => BROWSER_USE.test(prompt);

export function createScheduledHandlers(deps: ScheduledDeps): ScheduledHandlers {
  const { scheduler, kv } = deps;

  const build = (all: readonly Automation[]): ScheduledItem[] => {
    const system = scheduler.systemIds();
    const paused = pausedRoutines(kv);
    const groups = new Map<string, Automation[]>();
    for (const a of all) {
      const g = WORKFLOW.exec(a.prompt.trim())?.[1];
      if (g !== undefined && !system.has(a.id)) groups.set(g, [...(groups.get(g) ?? []), a]);
    }
    const items = all.map((a): ScheduledItem => {
      const isRoutine = system.has(a.id);
      const routine = isRoutine ? routineOf(a) : undefined;
      const info = routine === undefined ? undefined : (ROUTINES[routine.key] ?? {});
      const pausedHere = routine !== undefined && paused.has(routine.id);
      const state: ScheduledItem["state"] = !a.enabled
        ? info?.bySettings === true
          ? "off"
          : "paused"
        : pausedHere
          ? "paused"
          : "active";
      const g = isRoutine ? undefined : WORKFLOW.exec(a.prompt.trim())?.[1];
      const siblings = g === undefined ? [] : (groups.get(g) ?? []).filter((o) => o.id !== a.id);
      const item: ScheduledItem = {
        id: a.id,
        group: isRoutine ? "routine" : "owner",
        kind: a.kind,
        title: a.title,
        schedule: a.schedule,
        timezone: a.timezone,
        state,
        enabled: state === "active",
        nextRunAt: state === "active" ? a.nextRunAt : null,
        lastRunAt: a.lastRunAt,
        lastStatus: a.lastStatus,
        summary: isRoutine ? "" : summaryOf(a.prompt),
        approvals: isRoutine ? [...(info?.approvals ?? [])] : ["queued"],
        deletable: !isRoutine,
      };
      if (routine !== undefined) item.routine = routine.key;
      if (info?.settings !== undefined) item.settings = info.settings;
      if (!isRoutine) item.prompt = a.prompt;
      if (!isRoutine && usesBrowser(a.prompt)) {
        const availability = deps.browserAvailable?.();
        if (availability !== undefined && !availability.ok) {
          item.warnings = ["browser_not_guaranteed"];
          if (availability.reason !== undefined) item.warningReason = availability.reason;
        }
      }
      if (a.trigger !== undefined) item.trigger = a.trigger;
      if (g !== undefined && siblings.length > 0) {
        item.linked = {
          groupId: g,
          runs: siblings
            .map((o) => ({
              id: o.id,
              title: o.title,
              schedule: o.schedule,
              nextRunAt: o.nextRunAt,
            }))
            .sort((x, y) => (x.nextRunAt ?? "9").localeCompare(y.nextRunAt ?? "9")),
        };
      }
      return item;
    });
    // The owner's first, then Psyche's; each by next run, with nothing-scheduled last.
    const rank = (i: ScheduledItem) => (i.group === "owner" ? 0 : 1);
    return items.sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (x.nextRunAt ?? "9999").localeCompare(y.nextRunAt ?? "9999") ||
        x.title.localeCompare(y.title),
    );
  };

  return {
    "scheduled.list": async () => ({
      timezone: deps.timezone(),
      items: build(await scheduler.list()),
    }),
    "scheduled.runs": async ({ automationId, state, limit }) => {
      const wanted = limit ?? 100;
      // A state filter is applied after the mapping (`waiting` is a running run), so over-fetch.
      const rows = scheduler.allRuns({
        ...(automationId === undefined ? {} : { automationId }),
        limit: state === undefined ? wanted : 500,
      });
      const pending = (await deps.pendingApprovals?.()) ?? new Map<string, number>();
      const out: ScheduledRunEntry[] = [];
      for (const { run, title, system } of rows) {
        const taskStatus =
          run.status === "running" && run.taskId != null
            ? await deps.taskStatus?.(run.taskId)
            : undefined;
        const s = runState(run.status, taskStatus);
        if (state !== undefined && s !== state) continue;
        const a = system ? await scheduler.get(run.automationId) : undefined;
        const open = run.taskId == null ? 0 : (pending.get(run.taskId) ?? 0);
        const reason =
          s === "skipped"
            ? (run.summary ?? NOTHING_TO_REPORT)
            : s === "failed" || s === "cancelled"
              ? (run.summary ?? null)
              : null;
        const entry: ScheduledRunEntry = {
          id: run.id,
          automationId: run.automationId,
          title,
          group: system ? "routine" : "owner",
          trigger: run.trigger,
          state: s,
          reason,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs:
            run.endedAt == null
              ? null
              : Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)),
          summary: run.summary,
          threadId: run.threadId,
          taskId: run.taskId,
          agentRunId: run.runId,
          pendingApprovals: s === "waiting" ? open : 0,
        };
        if (a !== undefined) entry.routine = routineOf(a).key;
        out.push(entry);
        if (out.length >= wanted) break;
      }
      return { runs: out };
    },
    "scheduled.pause": async ({ id, paused }) => {
      const a = await scheduler.get(id);
      if (a === undefined) throw new PsycheError("not_found", "scheduled item not found");
      if (scheduler.systemIds().has(id)) {
        const routine = routineOf(a);
        const set = new Set(pausedRoutines(kv));
        if (paused) set.add(routine.id);
        else set.delete(routine.id);
        kv.set(PAUSED_ROUTINES_KEY, [...set].sort());
        // Resuming a routine whose own switch is off cannot turn it on from here.
      } else {
        await scheduler.update(id, { enabled: !paused });
      }
      const item = build(await scheduler.list()).find((i) => i.id === id);
      if (item === undefined) throw new PsycheError("not_found", "scheduled item not found");
      return { item };
    },
  };
}

interface LaunchLike {
  automation: Pick<Automation, "prompt" | "kind">;
  run: { trigger: string };
}

/**
 * The outermost launcher: a paused routine's scheduled run does nothing and reports `no_reply`
 * (so nothing is delivered). A manual run (Run now) is the owner asking, and goes through.
 */
export function withPausedRoutines<
  R extends LaunchLike,
  L extends { launch(request: R): Promise<unknown> },
>(inner: L, isPaused: () => ReadonlySet<string>): L {
  return {
    ...inner,
    async launch(request: R) {
      if (request.run.trigger !== "manual") {
        const routine = routineOf(request.automation);
        if (isPaused().has(routine.id)) {
          return {
            result: Promise.resolve({ status: "no_reply", summary: "Paused in Scheduled" }),
          };
        }
      }
      return inner.launch(request);
    },
  } as L;
}
