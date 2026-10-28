import type {
  Automation,
  DailyAutomationDraft,
  ModelProvider,
  ModelRef,
} from "@psyche/protocol";
import { complete, extractJson } from "../feed/model.ts";
import type { SchedulerLike } from "../jobs.ts";

/**
 * Plain-language automations: "Every Friday at 5, summarise what I shipped this week" becomes
 * a draft (schedule + prompt) for a confirmation card, and only the confirmed draft becomes an
 * automation, created through the same scheduler as the `schedule` tool. Parsing creates nothing.
 */

export const AUTOMATION_TEMPLATES = [
  { id: "friday-shipped", text: "Every Friday at 5pm, summarise what I shipped this week" },
  { id: "monday-plan", text: "Every Monday at 9am, help me plan the week from my calendar and tasks" },
  { id: "daily-inbox", text: "Every weekday at 4pm, list the mail that still needs a reply" },
  { id: "weekly-review", text: "Every Sunday at 7pm, review open tasks and follow-ups and suggest what to drop" },
  { id: "hourly-focus", text: "Every 2 hours on weekdays, remind me to stand up and drink water" },
] as const;

export type ValidateSchedule = (kind: "cron" | "interval", schedule: string, timezone: string) => void;

const CRON_FIELD = /^[\d*,/\-A-Za-z]+$/;

/** Fallback check when the scheduler's parser is not injected. */
export const basicValidate: ValidateSchedule = (kind, schedule) => {
  if (kind === "interval") {
    if (!/^P(?=\d|T)(\d+D)?(T(\d+H)?(\d+M)?)?$/.test(schedule)) throw new Error("bad interval");
    return;
  }
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5 || !f.every((x) => CRON_FIELD.test(x))) throw new Error("bad cron");
};

export interface ParseOptions {
  provider: Pick<ModelProvider, "stream"> | undefined;
  model: ModelRef | undefined;
  timezone: string;
  now: () => number;
  validate?: ValidateSchedule;
}

const SYSTEM = `You turn a plain-language request for a recurring task into JSON. Reply with one JSON object and nothing else:
{"title": short name, "kind": "cron" or "interval", "schedule": a 5-field cron expression (minute hour day-of-month month day-of-week; Sunday is 0) or an ISO-8601 duration such as PT2H, "prompt": the instruction the assistant will follow each time, written in the second person to the assistant, "humanSchedule": the schedule in words}
If the request names no recurring time, reply {"error": "short reason"}. The request is the owner's own words; the prompt must not contain anything that was not asked for.`;

export async function parseAutomation(
  text: string,
  o: ParseOptions,
): Promise<{ draft?: DailyAutomationDraft; error?: string }> {
  if (o.provider === undefined || o.model === undefined) {
    return { error: "no_model" };
  }
  let raw: unknown;
  try {
    const r = await complete(o.provider, {
      model: o.model,
      system: `${SYSTEM}\nThe owner's timezone is ${o.timezone}.`,
      messages: [{ role: "user", parts: [{ type: "text", text: text.slice(0, 1000) }] }],
      maxOutputTokens: 400,
      temperature: 0,
    });
    raw = extractJson(r.text);
  } catch {
    return { error: "model_failed" };
  }
  const j = raw as Record<string, unknown> | null;
  if (j === null || typeof j !== "object") return { error: "unparsed" };
  if (typeof j.error === "string") return { error: "no_schedule" };
  const kind = j.kind === "interval" ? "interval" : j.kind === "cron" ? "cron" : undefined;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;
  const title = str(j.title, 120);
  const schedule = str(j.schedule, 120);
  const prompt = str(j.prompt, 8000);
  if (kind === undefined || title === undefined || schedule === undefined || prompt === undefined) {
    return { error: "unparsed" };
  }
  try {
    (o.validate ?? basicValidate)(kind, schedule, o.timezone);
  } catch {
    return { error: "bad_schedule" };
  }
  return {
    draft: {
      title,
      kind,
      schedule,
      timezone: o.timezone,
      prompt,
      humanSchedule: str(j.humanSchedule, 200) ?? schedule,
    },
  };
}

/** Creates the automation for a draft the owner confirmed. Same scheduler as the `schedule` tool. */
export function confirmAutomation(
  scheduler: SchedulerLike,
  draft: DailyAutomationDraft,
  validate: ValidateSchedule = basicValidate,
): Promise<Automation> {
  validate(draft.kind, draft.schedule, draft.timezone);
  return scheduler.create({
    kind: draft.kind,
    title: draft.title,
    schedule: draft.schedule,
    timezone: draft.timezone,
    sessionTarget: "isolated",
    delivery: {},
    prompt: draft.prompt,
    scratch: null,
    enabled: true,
  } as never);
}
