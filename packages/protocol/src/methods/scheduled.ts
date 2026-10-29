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
  "scheduled.pause": defineMethod({
    params: Type.Object({ id: Id, paused: Type.Boolean() }),
    result: Type.Object({ item: ScheduledItem }),
    scope: "operator.write",
    description:
      "Pauses or resumes one scheduled item. The owner's automations are switched off and on; a routine of Psyche's skips its scheduled runs while paused (Run now still works) and keeps the pause across restarts.",
  }),
} as const;
