import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import { Automation, AutomationKind, Delivery } from "../schemas/integrations.ts";
import { defineMethod, OkResult } from "./define.ts";

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
} as const;
