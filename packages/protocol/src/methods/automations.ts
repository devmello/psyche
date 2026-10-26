import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import {
  Automation,
  AutomationKind,
  AutomationRun,
  AutomationSpecialist,
  Delivery,
  UpcomingItem,
  WatchConfig,
} from "../schemas/integrations.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/** `automations.*` (architecture §4: scheduler; data model §8). */

export const AutomationResult = Type.Object(
  { automation: Automation },
  { $id: "AutomationResult" },
);

const automationFields = {
  title: Type.String({ minLength: 1, maxLength: 200 }),
  schedule: Type.String({
    minLength: 1,
    description: "cron expression, ISO-8601 duration or watch interval",
  }),
  timezone: Type.String({ minLength: 1, description: "IANA zone; defaults to the Gateway's" }),
  sessionTarget: Type.String({ description: "main | isolated | named:<id>" }),
  delivery: Delivery,
  prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
  enabled: Type.Boolean(),
};

export const AutomationsMethods = {
  "automations.list": defineMethod({
    params: Type.Object({ kind: Type.Optional(AutomationKind) }),
    result: Type.Object({ automations: Type.Array(Automation) }),
    scope: "operator.read",
    description: "Lists automations with their next and last run.",
  }),
  "automations.create": defineMethod({
    params: Type.Object({
      kind: AutomationKind,
      title: automationFields.title,
      schedule: automationFields.schedule,
      prompt: automationFields.prompt,
      timezone: Type.Optional(automationFields.timezone),
      sessionTarget: Type.Optional(automationFields.sessionTarget),
      delivery: Type.Optional(automationFields.delivery),
      enabled: Type.Optional(automationFields.enabled),
      watch: Type.Optional(WatchConfig),
      lightContext: Type.Optional(Type.Boolean()),
      /** Run each occurrence as a background specialist job (specialists §4.10). */
      specialist: Type.Optional(AutomationSpecialist),
    }),
    result: AutomationResult,
    scope: "operator.write",
    sideEffecting: true,
    description: "Creates an automation (enabled by default). Side-effecting.",
  }),
  "automations.update": defineMethod({
    params: Type.Object({
      automationId: Id,
      title: Type.Optional(automationFields.title),
      schedule: Type.Optional(automationFields.schedule),
      prompt: Type.Optional(automationFields.prompt),
      timezone: Type.Optional(automationFields.timezone),
      sessionTarget: Type.Optional(automationFields.sessionTarget),
      delivery: Type.Optional(automationFields.delivery),
      enabled: Type.Optional(automationFields.enabled),
      watch: Type.Optional(WatchConfig),
      lightContext: Type.Optional(Type.Boolean()),
      scratch: Type.Optional(Nullable(Type.String({ maxLength: 20_000 }))),
      /** null runs it as a plain automation again. */
      specialist: Type.Optional(Nullable(AutomationSpecialist)),
    }),
    result: AutomationResult,
    scope: "operator.write",
    description: "Updates the given fields of an automation.",
  }),
  "automations.delete": defineMethod({
    params: Type.Object({ automationId: Id }),
    result: OkResult,
    scope: "operator.write",
    description: "Deletes an automation.",
  }),
  "automations.run": defineMethod({
    params: Type.Object({ automationId: Id }),
    result: Type.Object({ runId: Nullable(Id), taskId: Nullable(Id) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Runs an automation now, outside its schedule. Side-effecting: a duplicate would run it twice.",
  }),
  "automations.runs": defineMethod({
    params: Type.Object({ automationId: Id, ...pageParams }),
    result: Type.Object({ runs: Type.Array(AutomationRun), ...nextCursor }),
    scope: "operator.read",
    description: "Run history of one automation, newest first.",
  }),
  "automations.upcoming": defineMethod({
    params: Type.Object({
      horizonHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 * 366 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({ items: Type.Array(UpcomingItem) }),
    scope: "operator.read",
    description:
      "Everything scheduled (automations, reminders, briefings, heartbeat, watches) with next run times, soonest first; open input requests last (Upcoming view, O4).",
  }),
} as const;
