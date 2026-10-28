import type { DailyAutomationDraft, ModelProvider, ModelRef } from "@psyche/protocol";
import type { SchedulerLike } from "../jobs.ts";
import {
  AUTOMATION_TEMPLATES,
  confirmAutomation,
  parseAutomation,
  type ValidateSchedule,
} from "./automations.ts";
import type { FollowupStore } from "./followups.ts";
import type { DailyService } from "./service.ts";
import type { DailySettings } from "./settings.ts";

export interface DailyHandlerDeps {
  daily: DailyService | undefined;
  followups: FollowupStore;
  settings: () => DailySettings;
  scheduler: SchedulerLike;
  provider: ModelProvider | undefined;
  model: ModelRef | undefined;
  timezone: string;
  now: () => number;
  validate?: ValidateSchedule;
}

/** The `daily.*` methods (params only; the Gateway mounts them). */
export function createDailyHandlers(d: DailyHandlerDeps) {
  return {
    "daily.run": async (p: { kind: "morning" | "evening" }) => {
      if (d.daily === undefined) return { skipped: "unavailable" };
      return d.daily.run(p.kind);
    },
    "daily.followups.list": async (p: { status?: string[] }) => ({
      followups: d.followups.list(p.status as never),
    }),
    "daily.followups.update": async (p: {
      id: string;
      action: "done" | "snooze" | "dismiss" | "reopen";
      until?: string;
    }) => {
      const f = d.followups.update(
        p.id,
        p.action,
        p.until === undefined ? undefined : Date.parse(p.until),
      );
      if (f === undefined) throw new Error("not_found");
      return { followup: f };
    },
    "daily.followups.ingest": async (p: {
      text: string;
      source: "sent_mail" | "message" | "chat";
      sourceLink?: string;
    }) => {
      const s = d.settings().followups;
      if (!s.enabled) return { added: [] };
      return {
        added: d.followups.ingestOwnerText(p.text, p.source, {
          sensitivity: s.sensitivity,
          timezone: d.timezone,
          ...(p.sourceLink === undefined ? {} : { sourceLink: p.sourceLink }),
        }),
      };
    },
    "daily.carryOver": async (p: { ids: string[] }) => ({
      followups: d.daily?.carryOver(p.ids) ?? [],
    }),
    "daily.automations.templates": async () => ({ templates: [...AUTOMATION_TEMPLATES] }),
    "daily.automations.parse": async (p: { text: string }) =>
      parseAutomation(p.text, {
        provider: d.provider,
        model: d.model,
        timezone: d.timezone,
        now: d.now,
        ...(d.validate === undefined ? {} : { validate: d.validate }),
      }),
    "daily.automations.confirm": async (p: { draft: DailyAutomationDraft }) => ({
      automation: await confirmAutomation(d.scheduler, p.draft, d.validate),
    }),
  };
}
