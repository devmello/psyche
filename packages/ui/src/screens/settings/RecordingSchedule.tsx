import type { ScheduledItem } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { itemSchedule } from "../scheduled/format.ts";

type Reason = { code: string; step?: number | undefined };

type Freq = "daily" | "weekly" | "monthly";

/** The cron the owner's choice means: a fixed minute and hour, so at most one run a day. */
export function recordingCron(freq: Freq, time: string, weekday: number, monthday: number): string {
  const [h = "9", m = "0"] = time.split(":");
  const hour = Math.min(23, Math.max(0, Number.parseInt(h, 10) || 0));
  const minute = Math.min(59, Math.max(0, Number.parseInt(m, 10) || 0));
  const day =
    freq === "monthly" ? String(Math.min(28, Math.max(1, Math.trunc(monthday) || 1))) : "*";
  const dow = freq === "weekly" ? String(Math.min(6, Math.max(0, Math.trunc(weekday) || 0))) : "*";
  return `${minute} ${hour} ${day} * ${dow}`;
}

function reasonText(r: Reason): string {
  switch (r.code) {
    case "sensitive":
      return t("settings.recording.reason.sensitive", { step: r.step ?? 0 });
    case "input":
      return t("settings.recording.reason.input", { step: r.step ?? 0 });
    case "browser_only":
      return t("settings.recording.reason.browserOnly");
    case "off":
      return t("settings.recording.reason.off");
    case "not_recording":
      return t("settings.recording.reason.notRecording");
    default:
      return t("settings.recording.reason.unreadable");
  }
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const dayName = (d: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2023, 0, 1 + d)),
  );

/**
 * "Run it every week" on the page of a skill made from a recording. The owner picks the day and
 * time. A skill with a sensitive step, or a value asked for each run, cannot run with nobody
 * there to answer: it says which steps and offers no schedule. Once it is scheduled, the skill
 * shows when it runs and points to Scheduled, where pausing, removing and the history are.
 */
export function RecordingSchedule({ name }: { name: string }): ReactElement {
  const id = useId();
  const call = useCall();
  const scheduled = useGatewayQuery("scheduled.list", {});
  const existing: ScheduledItem | undefined = scheduled.data?.items.find(
    (i) => i.recordedSkill === name,
  );
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<{ eligible: boolean; reasons: Reason[] } | null>(null);
  const [freq, setFreq] = useState<Freq>("weekly");
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (existing !== undefined) {
    return (
      <p className="text-callout" data-testid={`recording-schedule-${name}`}>
        <span className="text-label-secondary">{t("settings.recording.runs")} </span>
        {itemSchedule(existing)}
        {existing.state === "paused" ? ` · ${t("scheduled.state.paused")}` : ""}
        <span className="text-label-secondary"> · {t("settings.recording.seeScheduled")}</span>
      </p>
    );
  }

  const start = async () => {
    setOpen(true);
    setProblem(null);
    try {
      const r = await call("skills.recording.unattended", { name });
      setCheck({ eligible: r.eligible, reasons: r.reasons });
    } catch (err) {
      setProblem(describeError(err));
    }
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await call("skills.recording.schedule", {
        name,
        schedule: recordingCron(freq, time, weekday, monthday),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setOpen(false);
      scheduled.reload();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid={`recording-schedule-open-${name}`}
          onClick={() => void start()}
        >
          {t("settings.recording.open")}
        </Button>
      </div>
    );
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2 rounded-md border-0 bg-fill-quaternary p-3"
      data-testid={`recording-schedule-form-${name}`}
    >
      <legend className="text-body text-label-primary">{t("settings.recording.title")}</legend>
      {check === null && problem === null ? (
        <p className="text-callout text-label-secondary">{t("settings.recording.checking")}</p>
      ) : null}
      {check !== null && !check.eligible ? (
        <div role="note" className="flex flex-col gap-1 text-callout">
          <p>{t("settings.recording.cannot")}</p>
          <ul className="list-disc ps-5">
            {check.reasons.map((r) => (
              <li key={`${r.code}-${r.step ?? 0}`}>{reasonText(r)}</li>
            ))}
          </ul>
          <p className="text-label-secondary">{t("settings.recording.cannotWhy")}</p>
        </div>
      ) : null}
      {check?.eligible === true ? (
        <>
          <p className="text-callout text-label-secondary">{t("settings.recording.rules")}</p>
          <div className="flex flex-wrap items-center gap-2 text-callout">
            <label htmlFor={`${id}-freq`}>{t("settings.recording.every")}</label>
            <select
              id={`${id}-freq`}
              value={freq}
              onChange={(e) => setFreq(e.target.value as Freq)}
              className="rounded-md bg-fill-tertiary px-2 py-1"
            >
              <option value="daily">{t("settings.recording.daily")}</option>
              <option value="weekly">{t("settings.recording.weekly")}</option>
              <option value="monthly">{t("settings.recording.monthly")}</option>
            </select>
            {freq === "weekly" ? (
              <select
                aria-label={t("settings.recording.dayOfWeek")}
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
                className="rounded-md bg-fill-tertiary px-2 py-1"
              >
                {WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d)}
                  </option>
                ))}
              </select>
            ) : null}
            {freq === "monthly" ? (
              <select
                aria-label={t("settings.recording.dayOfMonth")}
                value={monthday}
                onChange={(e) => setMonthday(Number(e.target.value))}
                className="rounded-md bg-fill-tertiary px-2 py-1"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            ) : null}
            <label htmlFor={`${id}-time`}>{t("settings.recording.at")}</label>
            <input
              id={`${id}-time`}
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-md bg-fill-tertiary px-2 py-1"
            />
          </div>
        </>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-callout text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        {check?.eligible === true ? (
          <Button type="button" disabled={busy || time === ""} onClick={() => void save()}>
            {t("settings.recording.confirm")}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("settings.recording.close")}
        </Button>
      </div>
    </fieldset>
  );
}
