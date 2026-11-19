import type { Automation, AutomationKind } from "@psyche/protocol";
import type { useCall } from "../../data/hooks.ts";

/**
 * The automation form's logic, without React: the owner's schedule choice mapped to the Gateway's
 * `schedule` string (and the kind it needs), back again for editing, the next runs preview, and
 * the create / update calls. The Gateway reads the string, not the choice: a 5-field cron
 * (`minute hour day month weekday`) in the automation's time zone, an ISO-8601 duration
 * (`PT6H`, interval) or an ISO-8601 instant with an offset (`reminder`, one-shot).
 */

/** The Gateway's delivery target (a schema value, so its type is read off the automation). */
type Delivery = Automation["delivery"];

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** What the owner picked. `custom` is a schedule the picker cannot express; it is kept as stored. */
export type ScheduleChoice =
  | { type: "once"; date: string; time: string }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; days: Weekday[]; time: string }
  | { type: "interval"; hours: number }
  | { type: "custom"; schedule: string };

export type ScheduleError = "date" | "time" | "past" | "days" | "hours" | "switch";

export interface GatewaySchedule {
  kind: AutomationKind;
  schedule: string;
}

/** Where the result goes: the inbox (no thread), a chat thread, or nowhere. */
export type DeliveryChoice =
  | { type: "inbox" }
  | { type: "thread"; threadId: string }
  | { type: "none" };

export interface AutomationFormValues {
  /** Empty means "from the first line of the instructions". */
  title: string;
  prompt: string;
  schedule: ScheduleChoice;
  delivery: DeliveryChoice;
  enabled: boolean;
}

export interface FormContext {
  /** The zone the schedule is written in: the system zone for a new automation. */
  zone: string;
  /** Clock for the past check and the preview. */
  now: number;
  /** The automation being edited; its kind decides whether a one-time schedule is allowed. */
  editing?: Pick<Automation, "kind">;
}

export interface FormErrors {
  prompt?: true;
  title?: true;
  schedule?: ScheduleError;
  delivery?: true;
}

export const MAX_TITLE = 200;
export const MAX_PROMPT = 20_000;
const MAX_HOURS = 168;
const HOUR_MS = 3_600_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The system's IANA zone: what a new automation's times are written in. */
export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ── zones ─────────────────────────────────────────────────────────────────────────────────

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in a zone. */
export function wallParts(ms: number, zone: string): Wall {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return {
    year: p.year ?? 1970,
    month: p.month ?? 1,
    day: p.day ?? 1,
    hour: p.hour ?? 0,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in ms (east is positive). */
function offsetMs(ms: number, zone: string): number {
  const w = wallParts(ms, zone);
  const wallUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the zone's wall clock reads y-mo-d h:mi (DST-aware, two passes). */
export function instantForWall(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  zone: string,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - offsetMs(wall, zone);
  return wall - offsetMs(first, zone);
}

/** `2026-11-20T09:00:00-08:00`: an instant as the Gateway's ISO-8601 reminder string. */
export function isoWithOffset(ms: number, zone: string): string {
  const w = wallParts(ms, zone);
  const off = Math.round(offsetMs(ms, zone) / 60_000);
  const abs = Math.abs(off);
  const sign = off < 0 ? "-" : "+";
  const date = `${String(w.year).padStart(4, "0")}-${pad2(w.month)}-${pad2(w.day)}`;
  const clock = `${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
  return `${date}T${clock}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function validDate(date: string): { y: number; mo: number; d: number } | null {
  const m = DATE.exec(date);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, mo, d };
}

function parseTime(time: string): { h: number; mi: number } | null {
  const m = TIME.exec(time);
  return m === null ? null : { h: Number(m[1]), mi: Number(m[2]) };
}

// ── choice <-> Gateway ────────────────────────────────────────────────────────────────────

/** Days a recurring choice runs on (0 = Sunday, as cron counts them). */
function recurringDays(choice: ScheduleChoice): Weekday[] | null {
  switch (choice.type) {
    case "daily":
      return [0, 1, 2, 3, 4, 5, 6];
    case "weekdays":
      return [1, 2, 3, 4, 5];
    case "weekly":
      return choice.days.length === 0 ? null : choice.days;
    default:
      return null;
  }
}

/**
 * The Gateway's kind and schedule string for a choice, or the reason it is not valid. `past` is
 * a one-time time that has already gone; `switch` is a change between one-time and repeating,
 * which the Gateway does not allow on an existing automation.
 */
export function toGateway(
  choice: ScheduleChoice,
  ctx: Pick<FormContext, "now" | "zone" | "editing">,
): GatewaySchedule | ScheduleError {
  if (choice.type === "custom") {
    return { kind: ctx.editing?.kind ?? "cron", schedule: choice.schedule };
  }
  if (ctx.editing !== undefined) {
    const wasOneTime = ctx.editing.kind === "reminder";
    if (wasOneTime !== (choice.type === "once")) return "switch";
  }
  if (choice.type === "interval") {
    if (!Number.isInteger(choice.hours) || choice.hours < 1 || choice.hours > MAX_HOURS) {
      return "hours";
    }
    return { kind: "interval", schedule: `PT${choice.hours}H` };
  }
  if (choice.type === "once") {
    const date = validDate(choice.date);
    if (date === null) return "date";
    const hm = parseTime(choice.time);
    if (hm === null) return "time";
    const at = instantForWall(date.y, date.mo, date.d, hm.h, hm.mi, ctx.zone);
    if (at <= ctx.now) return "past";
    return { kind: "reminder", schedule: isoWithOffset(at, ctx.zone) };
  }
  const hm = parseTime(choice.time);
  if (hm === null) return "time";
  if (choice.type === "daily") return { kind: "cron", schedule: `${hm.mi} ${hm.h} * * *` };
  if (choice.type === "weekdays") return { kind: "cron", schedule: `${hm.mi} ${hm.h} * * 1-5` };
  const days = recurringDays(choice);
  if (days === null) return "days";
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return { kind: "cron", schedule: `${hm.mi} ${hm.h} * * ${sorted.join(",")}` };
}

/** The choice an existing automation's kind and schedule string stand for, in its zone. */
export function fromGateway(kind: AutomationKind, schedule: string, zone: string): ScheduleChoice {
  const text = schedule.trim();
  if (kind === "reminder") {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return { type: "custom", schedule: text };
    const w = wallParts(ms, zone);
    return {
      type: "once",
      date: `${w.year}-${pad2(w.month)}-${pad2(w.day)}`,
      time: `${pad2(w.hour)}:${pad2(w.minute)}`,
    };
  }
  const iv = /^PT(\d+)H$/.exec(text);
  if (iv !== null) {
    const hours = Number(iv[1]);
    if (hours >= 1 && hours <= MAX_HOURS) return { type: "interval", hours };
    return { type: "custom", schedule: text };
  }
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(text);
  if (cron !== null) {
    const mi = Number(cron[1]);
    const h = Number(cron[2]);
    if (mi < 60 && h < 24) {
      const time = `${pad2(h)}:${pad2(mi)}`;
      const dows = cron[3] ?? "*";
      if (dows === "*") return { type: "daily", time };
      if (dows === "1-5") return { type: "weekdays", time };
      const days = [...new Set(dows.split(",").map(Number))]
        .sort((a, b) => a - b)
        .filter((n): n is Weekday => n >= 0 && n <= 6);
      return { type: "weekly", days, time };
    }
  }
  return { type: "custom", schedule: text };
}

/**
 * The next runs of a choice (up to `count`), as epoch ms in the zone. `null` when the choice has
 * no preview (invalid, or a custom schedule the picker cannot read).
 */
export function nextRuns(
  choice: ScheduleChoice,
  zone: string,
  now: number,
  count = 3,
): number[] | null {
  if (choice.type === "custom") return null;
  if (choice.type === "interval") {
    if (!Number.isInteger(choice.hours) || choice.hours < 1 || choice.hours > MAX_HOURS) {
      return null;
    }
    return Array.from({ length: count }, (_, k) => now + (k + 1) * choice.hours * HOUR_MS);
  }
  if (choice.type === "once") {
    const date = validDate(choice.date);
    const hm = parseTime(choice.time);
    if (date === null || hm === null) return null;
    const at = instantForWall(date.y, date.mo, date.d, hm.h, hm.mi, zone);
    return at > now ? [at] : [];
  }
  const hm = parseTime(choice.time);
  const days = recurringDays(choice);
  if (hm === null || days === null) return null;
  const start = wallParts(now, zone);
  const out: number[] = [];
  for (let i = 0; i < 400 && out.length < count; i += 1) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!days.includes(day.getUTCDay() as Weekday)) continue;
    const at = instantForWall(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hm.h,
      hm.mi,
      zone,
    );
    if (at > now) out.push(at);
  }
  return out;
}

/** A starting choice for a type the owner switches to, keeping the time and days they had. */
export function withType(
  current: ScheduleChoice,
  type: Exclude<ScheduleChoice["type"], "custom">,
  zone: string,
  now: number,
): ScheduleChoice {
  const time = "time" in current ? current.time : "09:00";
  switch (type) {
    case "once": {
      const tomorrow = wallParts(now + 24 * HOUR_MS, zone);
      const date = `${tomorrow.year}-${pad2(tomorrow.month)}-${pad2(tomorrow.day)}`;
      return { type, date, time };
    }
    case "daily":
      return { type, time };
    case "weekdays":
      return { type, time };
    case "weekly":
      return { type, days: current.type === "weekly" ? current.days : [1], time };
    case "interval":
      return { type, hours: current.type === "interval" ? current.hours : 6 };
  }
}

// ── delivery ──────────────────────────────────────────────────────────────────────────────

export function deliveryChoice(delivery: Delivery): DeliveryChoice {
  if (delivery.none === true) return { type: "none" };
  if (delivery.thread !== undefined) return { type: "thread", threadId: delivery.thread };
  return { type: "inbox" };
}

/** The Delivery to save. Channel and webhook targets the form does not show are kept. */
export function toDelivery(choice: DeliveryChoice, existing: Delivery = {}): Delivery {
  if (choice.type === "none") return { none: true };
  const kept: Delivery = {};
  if (existing.channel !== undefined) kept.channel = existing.channel;
  if (existing.webhook !== undefined) kept.webhook = existing.webhook;
  if (choice.type === "thread") return { ...kept, thread: choice.threadId };
  return kept;
}

// ── validation and writes ─────────────────────────────────────────────────────────────────

export function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split("\n")[0] ?? "";
  const line = first.trim().slice(0, 80).trim();
  return line === "" ? "Automation" : line;
}

/** The form's errors, or the Gateway schedule to save. */
export function validateForm(
  values: AutomationFormValues,
  ctx: FormContext,
): { ok: true; schedule: GatewaySchedule } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const prompt = values.prompt.trim();
  if (prompt === "" || prompt.length > MAX_PROMPT) errors.prompt = true;
  if (values.title.trim().length > MAX_TITLE) errors.title = true;
  if (values.delivery.type === "thread" && values.delivery.threadId === "") errors.delivery = true;
  const schedule = toGateway(values.schedule, ctx);
  if (typeof schedule === "string") errors.schedule = schedule;
  if (typeof schedule === "string" || errors.prompt || errors.title || errors.delivery) {
    return { ok: false, errors };
  }
  return { ok: true, schedule };
}

export type AutomationWrite =
  | {
      method: "automations.create";
      params: {
        kind: AutomationKind;
        title: string;
        schedule: string;
        prompt: string;
        timezone: string;
        delivery: Delivery;
        enabled: boolean;
      };
    }
  | {
      method: "automations.update";
      params: {
        automationId: string;
        title: string;
        schedule: string;
        prompt: string;
        delivery: Delivery;
        enabled: boolean;
      };
    };

/** The create or update call for a valid form. Edit keeps the automation's own zone. */
export function automationWrite(
  values: AutomationFormValues,
  ctx: FormContext,
  automation?: Pick<Automation, "id" | "delivery">,
): AutomationWrite {
  const checked = validateForm(values, ctx);
  if (!checked.ok) throw new RangeError("the automation form has errors");
  const prompt = values.prompt.trim();
  const title = (values.title.trim() || titleFromPrompt(prompt)).slice(0, MAX_TITLE);
  const delivery = toDelivery(values.delivery, automation?.delivery ?? {});
  if (automation !== undefined) {
    return {
      method: "automations.update",
      params: {
        automationId: automation.id,
        title,
        schedule: checked.schedule.schedule,
        prompt,
        delivery,
        enabled: values.enabled,
      },
    };
  }
  return {
    method: "automations.create",
    params: {
      kind: checked.schedule.kind,
      title,
      schedule: checked.schedule.schedule,
      prompt,
      timezone: ctx.zone,
      delivery,
      enabled: values.enabled,
    },
  };
}

/** Saves the form through the Gateway: `automations.create`, or `automations.update` when editing. */
export async function saveAutomation(
  call: ReturnType<typeof useCall>,
  values: AutomationFormValues,
  ctx: FormContext,
  automation?: Pick<Automation, "id" | "delivery">,
): Promise<unknown> {
  const write = automationWrite(values, ctx, automation);
  return write.method === "automations.create"
    ? call("automations.create", write.params)
    : call("automations.update", write.params);
}

/** The form's starting values: an automation's own, or a new one's defaults. */
export function initialValues(
  automation: Automation | undefined,
  initialPrompt: string | undefined,
): AutomationFormValues {
  if (automation !== undefined) {
    return {
      title: automation.title,
      prompt: automation.prompt,
      schedule: fromGateway(automation.kind, automation.schedule, automation.timezone),
      delivery: deliveryChoice(automation.delivery),
      enabled: automation.enabled,
    };
  }
  return {
    title: "",
    prompt: initialPrompt ?? "",
    schedule: { type: "daily", time: "09:00" },
    delivery: { type: "inbox" },
    enabled: true,
  };
}
