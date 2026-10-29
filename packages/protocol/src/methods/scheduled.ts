import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { AutomationKind } from "../schemas/integrations.ts";
import { AutomationTrigger } from "../schemas/workflows.ts";
import { defineMethod } from "./define.ts";

/**
 * `scheduled.*`: the Scheduled screen's one read. Everything the Gateway scheduler runs, grouped
 * as the owner's own automations and Psyche's routines. Pause, resume, run now, edit, delete and
 * run history use `automations.*`; a run's audit records use `audit.changes` with its `runId`.
 */

/** Another run of the same task → automation workflow ("9am add" ↔ "11:30pm check"). */
export const ScheduledLinkedRun = Type.Object(
  {
    id: Id,
    title: Type.String(),
    schedule: Type.String(),
    nextRunAt: Nullable(IsoDateTime),
  },
  { $id: "ScheduledLinkedRun" },
);

export const ScheduledLink = Type.Object(
  {
    groupId: Type.String({ maxLength: 200 }),
    /** The other runs of the group, soonest first (not this one). */
    runs: Type.Array(ScheduledLinkedRun, { maxItems: 24 }),
  },
  { $id: "ScheduledLink" },
);

export const ScheduledGroup = StringEnum(["owner", "routine"], { $id: "ScheduledGroup" });

export const ScheduledState = StringEnum(["active", "paused", "off"], {
  $id: "ScheduledState",
  description:
    "`paused`: stopped here and resumable here. `off`: a routine whose feature is switched off in its Settings section, which is where it is turned on",
});

/**
 * A pre-flight warning on an automation. `browser_not_guaranteed`: its plan uses the browser and
 * Psyche cannot promise one when it runs (the app is not running and cannot be started).
 */
export const ScheduledWarning = StringEnum(["browser_not_guaranteed"], {
  $id: "ScheduledWarning",
});

export const ScheduledItem = Type.Object(
  {
    /** The automation's id (what `automations.*` take). */
    id: Id,
    group: ScheduledGroup,
    /**
     * `routine` items: which built-in it is ("daily-brief", "memory-dreaming", "mail-digest", …),
     * so a client can name and explain it. Absent for the owner's own automations.
     */
    routine: Type.Optional(Type.String({ maxLength: 64 })),
    kind: AutomationKind,
    title: Type.String(),
    /** Cron expression, ISO-8601 duration or instant, as stored. */
    schedule: Type.String(),
    timezone: Type.String(),
    state: ScheduledState,
    /** `state` is `active`. */
    enabled: Type.Boolean(),
    /** Null when it is not active, or an event automation. */
    nextRunAt: Nullable(IsoDateTime),
    lastRunAt: Nullable(IsoDateTime),
    lastStatus: Nullable(Type.String()),
    /** Owner automations: what it does in one line (its prompt's first line). Empty for routines. */
    summary: Type.String({ maxLength: 300 }),
    /** The full instruction of an owner automation (for editing); absent for routines. */
    prompt: Type.Optional(Type.String()),
    /**
     * The approvals the run may need, as ids ("queued", "calendar_write"); empty means none.
     * `queued`: anything that needs approval waits in the approvals queue (unattended runs).
     */
    approvals: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 8 }),
    linked: Type.Optional(ScheduledLink),
    /** Owner automations: problems found before the run (see `ScheduledWarning`). */
    warnings: Type.Optional(Type.Array(ScheduledWarning, { maxItems: 4 })),
    /** With `browser_not_guaranteed`: why, in a sentence (for the details line). */
    warningReason: Type.Optional(Type.String({ maxLength: 300 })),
    /** False for Psyche's routines: they can be paused and run, not deleted. */
    deletable: Type.Boolean(),
    /** Where the routine is configured (`/settings/<id>`). */
    settings: Type.Optional(Type.String({ maxLength: 32 })),
    /** `kind: "event"`: what starts a run; such items have no next time. */
    trigger: Type.Optional(AutomationTrigger),
  },
  { $id: "ScheduledItem" },
);
export type ScheduledItem = Static<typeof ScheduledItem>;

export const ScheduledRunState = StringEnum(
  ["running", "waiting", "succeeded", "failed", "skipped", "cancelled"],
  {
    $id: "ScheduledRunState",
    description:
      "The one status a run is shown with. `waiting`: the run's task is parked on an approval or an answer. `skipped`: nothing was done, and `reason` says why (paused, previous run still going, nothing to report). `succeeded` only when the run finished `done`",
  },
);
export type ScheduledRunState = Static<typeof ScheduledRunState>;

/** One run of the scheduler, with the job it belongs to: the Runs view's row. */
export const ScheduledRunEntry = Type.Object(
  {
    /** The scheduler run's id (`automation_runs`). */
    id: Id,
    automationId: Id,
    /** The job's title as stored. */
    title: Type.String(),
    group: ScheduledGroup,
    /** Routines: which built-in ("daily-brief", "memory-dreaming", …). */
    routine: Type.Optional(Type.String({ maxLength: 64 })),
    trigger: StringEnum(["schedule", "manual", "event"]),
    state: ScheduledRunState,
    /** Why a run was skipped, failed or is waiting. */
    reason: Nullable(Type.String()),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    /** Null while it runs. */
    durationMs: Nullable(Type.Integer({ minimum: 0 })),
    /** What the run produced (or the failure message). */
    summary: Nullable(Type.String()),
    threadId: Nullable(Id),
    taskId: Nullable(Id),
    /** The agent run that did the work (its Timeline: `runs.get`). */
    agentRunId: Nullable(Id),
    /** `waiting`: the open approvals of the run's task, to decide in the approvals queue. */
    pendingApprovals: Type.Integer({ minimum: 0 }),
  },
  { $id: "ScheduledRunEntry" },
);
export type ScheduledRunEntry = Static<typeof ScheduledRunEntry>;

export const ScheduledMethods = {
  "scheduled.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      /** The owner's IANA zone (USER.md), for showing times. */
      timezone: Type.String(),
      items: Type.Array(ScheduledItem),
    }),
    scope: "operator.read",
    description:
      "Lists everything the scheduler runs (the owner's automations, then Psyche's routines) with next and last run, what each does, the approvals it may need and its linked runs.",
  }),
  "scheduled.runs": defineMethod({
    params: Type.Object({
      automationId: Type.Optional(Id),
      state: Type.Optional(ScheduledRunState),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({ runs: Type.Array(ScheduledRunEntry) }),
    scope: "operator.read",
    description:
      "Every run of everything the scheduler runs, newest first, in progress ones included: the owner's automations and Psyche's routines (brief, wrap-up, nightly memory, proactive jobs), whether started by the schedule, by an event or by Run now. Filter by job and by state.",
  }),
  "scheduled.pause": defineMethod({
    params: Type.Object({ id: Id, paused: Type.Boolean() }),
    result: Type.Object({ item: ScheduledItem }),
    scope: "operator.write",
    description:
      "Pauses or resumes one scheduled item. The owner's automations are switched off and on; a routine of Psyche's skips its scheduled runs while paused (Run now still works) and keeps the pause across restarts.",
  }),
} as const;
