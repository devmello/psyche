import type { Automation } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { ScreenColumn, ScreenToolbar } from "../feed/ScreenToolbar.tsx";
import { absoluteWhen } from "./format.ts";
import {
  type AutomationFormValues,
  type DeliveryChoice,
  type FormErrors,
  initialValues,
  MAX_PROMPT,
  MAX_TITLE,
  nextRuns,
  type ScheduleChoice,
  type ScheduleError,
  systemZone,
  validateForm,
  type Weekday,
  withType,
} from "./schedule-form.ts";

export interface ThreadOption {
  id: string;
  title: string;
}

export interface AutomationFormProps {
  /** The automation being edited; absent for a new one. */
  automation?: Automation;
  /** The prefilled instructions (an example from the empty state). */
  initialPrompt?: string;
  /** The chats a result can be posted to. */
  threads: readonly ThreadOption[];
  /** A fixed clock for stories and tests. */
  now?: number;
  /** Saves; a rejection is shown in the form. */
  onSave: (values: AutomationFormValues) => Promise<void>;
  /** Deletes after the owner confirms. Only offered when editing. */
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}

const DELIVERY_OPTIONS = ["inbox", "thread", "none"] as const;
const SCHEDULE_OPTIONS = ["once", "daily", "weekdays", "weekly", "interval"] as const;

/** The error shown for each validation failure. */
const SCHEDULE_ERROR: Record<ScheduleError, MessageId> = {
  date: "scheduled.form.error.date",
  time: "scheduled.form.error.time",
  past: "scheduled.form.error.past",
  days: "scheduled.form.error.days",
  hours: "scheduled.form.error.hours",
  switch: "scheduled.form.error.switch",
};

/** Day checkboxes in the owner's language, Sunday first, as cron counts them. */
function weekdayName(day: Weekday): string {
  // 2026-01-04 is a Sunday.
  const date = new Date(Date.UTC(2026, 0, 4 + day));
  return new Intl.DateTimeFormat(activeI18n().locale, { weekday: "long", timeZone: "UTC" }).format(
    date,
  );
}

/**
 * Create or edit an automation: what to do, when (a simple picker, with the next runs), where the
 * result goes, and whether it is on. Saving and deleting are the caller's; the form validates and
 * shows the Gateway's reasons.
 */
export function AutomationForm({
  automation,
  initialPrompt,
  threads,
  now: fixedNow,
  onSave,
  onDelete,
  onCancel,
}: AutomationFormProps): ReactElement {
  const ids = useId();
  const zone = automation?.timezone ?? systemZone();
  const [now] = useState(() => fixedNow ?? Date.now());
  const [values, setValues] = useState<AutomationFormValues>(() =>
    initialValues(automation, initialPrompt),
  );
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const ctx = { zone, now, ...(automation ? { editing: automation } : {}) };
  const checked = validateForm(values, ctx);
  const errors: FormErrors = attempted && !checked.ok ? checked.errors : {};
  const runs = nextRuns(values.schedule, zone, now);
  const editing = automation !== undefined;
  const oneTimeOnly = editing && automation.kind === "reminder";

  const setSchedule = (schedule: ScheduleChoice) => setValues((v) => ({ ...v, schedule }));
  const setDelivery = (delivery: DeliveryChoice) => setValues((v) => ({ ...v, delivery }));
  const setTimeOfDay = (time: string) =>
    setValues((v) =>
      v.schedule.type === "custom" || v.schedule.type === "interval"
        ? v
        : { ...v, schedule: { ...v.schedule, time } },
    );
  const setOnce = (patch: { date?: string; time?: string }) =>
    setValues((v) =>
      v.schedule.type === "once" ? { ...v, schedule: { ...v.schedule, ...patch } } : v,
    );

  const chooseType = (type: (typeof SCHEDULE_OPTIONS)[number]) => {
    setSchedule(withType(values.schedule, type, zone, now));
  };

  const submit = async () => {
    setAttempted(true);
    setProblem(null);
    if (!validateForm(values, ctx).ok) return;
    setBusy(true);
    try {
      await onSave(values);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    setBusy(true);
    try {
      await onDelete();
    } catch (err) {
      setProblem(describeError(err));
      setBusy(false);
    }
  };

  const scheduleValue = values.schedule.type;
  const timeId = `${ids}-time`;
  const dateId = `${ids}-date`;
  const hoursId = `${ids}-hours`;
  const nameId = `${ids}-name`;
  const promptId = `${ids}-prompt`;
  const scheduleId = `${ids}-when`;
  const deliveryId = `${ids}-delivery`;
  const threadId = `${ids}-thread`;
  const enabledId = `${ids}-enabled`;

  const errorLine = (message: string | undefined, key: string) =>
    message === undefined ? null : (
      <p id={key} role="alert" className="text-callout text-destructive">
        {message}
      </p>
    );

  return (
    <>
      <ScreenToolbar title={t(editing ? "scheduled.form.edit.title" : "scheduled.new")} />
      <ScreenColumn width="reading" className="gap-6">
        <form
          noValidate
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={promptId}>{t("scheduled.form.prompt")}</Label>
            <p id={`${promptId}-hint`} className="text-callout text-label-secondary">
              {t("scheduled.form.prompt.hint")}
            </p>
            <Textarea
              id={promptId}
              rows={5}
              maxLength={MAX_PROMPT}
              value={values.prompt}
              aria-invalid={errors.prompt === true}
              aria-describedby={`${promptId}-hint ${ids}-prompt-err`}
              onChange={(e) => setValues((v) => ({ ...v, prompt: e.target.value }))}
            />
            {errorLine(
              errors.prompt ? t("scheduled.form.error.prompt") : undefined,
              `${ids}-prompt-err`,
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>{t("scheduled.form.name")}</Label>
            <Input
              id={nameId}
              maxLength={MAX_TITLE}
              value={values.title}
              aria-describedby={`${nameId}-hint`}
              onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
            />
            <p id={`${nameId}-hint`} className="text-callout text-label-secondary">
              {t("scheduled.form.name.hint")}
            </p>
            {errorLine(
              errors.title ? t("scheduled.form.error.name") : undefined,
              `${ids}-name-err`,
            )}
          </div>

          <fieldset id={scheduleId} className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 text-body text-label-primary">
              {t("scheduled.form.when")}
            </legend>
            <p className="text-callout text-label-secondary">
              {t("scheduled.form.zone", { zone })}
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${ids}-type`}>{t("scheduled.form.when.kind")}</Label>
              <NativeSelect
                id={`${ids}-type`}
                value={scheduleValue}
                onChange={(e) => chooseType(e.target.value as (typeof SCHEDULE_OPTIONS)[number])}
              >
                {SCHEDULE_OPTIONS.map((type) => (
                  <option
                    key={type}
                    value={type}
                    disabled={type === "once" ? editing && !oneTimeOnly : oneTimeOnly}
                  >
                    {t(`scheduled.form.when.${type}`)}
                  </option>
                ))}
                {scheduleValue === "custom" ? (
                  <option value="custom" disabled>
                    {t("scheduled.form.when.custom", {
                      schedule: values.schedule.type === "custom" ? values.schedule.schedule : "",
                    })}
                  </option>
                ) : null}
              </NativeSelect>
            </div>

            {values.schedule.type === "once" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={dateId}>{t("scheduled.form.date")}</Label>
                  <Input
                    id={dateId}
                    type="date"
                    value={values.schedule.date}
                    aria-invalid={errors.schedule === "date"}
                    onChange={(e) => setOnce({ date: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={timeId}>{t("scheduled.form.time")}</Label>
                  <Input
                    id={timeId}
                    type="time"
                    value={values.schedule.time}
                    aria-invalid={errors.schedule === "time"}
                    onChange={(e) => setOnce({ time: e.target.value })}
                  />
                </div>
              </div>
            ) : null}

            {values.schedule.type === "daily" ||
            values.schedule.type === "weekdays" ||
            values.schedule.type === "weekly" ? (
              <>
                {values.schedule.type === "weekly" ? (
                  <fieldset className="flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-2 text-callout text-label-secondary">
                      {t("scheduled.form.days")}
                    </legend>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((day) => {
                        const days = values.schedule.type === "weekly" ? values.schedule.days : [];
                        return (
                          <div key={day} className="flex items-center gap-2 text-body">
                            <Checkbox
                              aria-label={weekdayName(day)}
                              checked={days.includes(day)}
                              onCheckedChange={(checked) => {
                                if (values.schedule.type !== "weekly") return;
                                const next = checked
                                  ? [...days, day]
                                  : days.filter((d) => d !== day);
                                setSchedule({
                                  ...values.schedule,
                                  days: next.sort((a, b) => a - b),
                                });
                              }}
                            />
                            {weekdayName(day)}
                          </div>
                        );
                      })}
                    </div>
                    {errorLine(
                      errors.schedule === "days" ? t(SCHEDULE_ERROR.days) : undefined,
                      `${ids}-days-err`,
                    )}
                  </fieldset>
                ) : null}
                <div className="flex flex-col gap-2">
                  <Label htmlFor={timeId}>{t("scheduled.form.time")}</Label>
                  <Input
                    id={timeId}
                    type="time"
                    value={values.schedule.time}
                    aria-invalid={errors.schedule === "time"}
                    onChange={(e) => setTimeOfDay(e.target.value)}
                  />
                </div>
              </>
            ) : null}

            {values.schedule.type === "interval" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={hoursId}>{t("scheduled.form.hours")}</Label>
                <Input
                  id={hoursId}
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={values.schedule.hours}
                  aria-invalid={errors.schedule === "hours"}
                  className="w-32"
                  onChange={(e) => setSchedule({ type: "interval", hours: Number(e.target.value) })}
                />
              </div>
            ) : null}

            {values.schedule.type === "custom" ? (
              <p className="text-callout text-label-secondary">{t("scheduled.form.custom.hint")}</p>
            ) : null}

            {errorLine(
              errors.schedule && errors.schedule !== "days"
                ? t(SCHEDULE_ERROR[errors.schedule])
                : undefined,
              `${ids}-schedule-err`,
            )}

            {editing ? (
              <p className="text-callout text-label-secondary">{t("scheduled.form.switch.hint")}</p>
            ) : null}

            {runs !== null ? (
              <section
                aria-label={t("scheduled.form.next")}
                className="flex flex-col gap-1 rounded-md bg-fill-quaternary p-3"
              >
                <h3 className="text-callout text-label-secondary">{t("scheduled.form.next")}</h3>
                {runs.length === 0 ? (
                  <p className="text-callout">{t("scheduled.form.next.none")}</p>
                ) : (
                  <ul className="flex flex-col gap-0.5 text-callout">
                    {runs.map((ms) => (
                      <li key={ms}>{absoluteWhen(new Date(ms).toISOString(), zone)}</li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor={deliveryId}>{t("scheduled.form.delivery")}</Label>
            <NativeSelect
              id={deliveryId}
              value={values.delivery.type}
              onChange={(e) => {
                const type = e.target.value as DeliveryChoice["type"];
                setDelivery(
                  type === "thread"
                    ? { type, threadId: threads[0]?.id ?? "" }
                    : type === "none"
                      ? { type }
                      : { type: "inbox" },
                );
              }}
            >
              {DELIVERY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`scheduled.form.delivery.${option}`)}
                </option>
              ))}
            </NativeSelect>
            {values.delivery.type === "thread" ? (
              <NativeSelect
                id={threadId}
                aria-label={t("scheduled.form.delivery.threadPick")}
                value={values.delivery.threadId}
                aria-invalid={errors.delivery === true}
                onChange={(e) => setDelivery({ type: "thread", threadId: e.target.value })}
              >
                <option value="" disabled>
                  {t("scheduled.form.delivery.pick")}
                </option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {errorLine(
              errors.delivery ? t("scheduled.form.error.thread") : undefined,
              `${ids}-thread-err`,
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex min-h-5 items-center gap-3">
              <div className="min-w-0 flex-1">
                <Label htmlFor={enabledId}>{t("scheduled.form.enabled")}</Label>
                <p className="text-callout text-label-secondary">
                  {t("scheduled.form.enabled.hint")}
                </p>
              </div>
              <Switch
                id={enabledId}
                checked={values.enabled}
                onCheckedChange={(enabled) => setValues((v) => ({ ...v, enabled }))}
              />
            </div>
          </div>

          <p className="text-callout text-label-secondary">{t("scheduled.form.approvals")}</p>

          {problem ? (
            <p role="alert" className="text-callout text-destructive">
              {problem}
            </p>
          ) : null}

          {confirmDelete ? (
            <fieldset className="flex min-w-0 flex-col gap-2 rounded-md border-0 bg-fill-quaternary p-3">
              <legend className="text-body text-label-primary">
                {t("scheduled.delete.title", { title: automation?.title ?? "" })}
              </legend>
              <p className="text-callout text-label-secondary">{t("scheduled.delete.body")}</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t("scheduled.delete.confirm")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  {t("scheduled.delete.cancel")}
                </Button>
              </div>
            </fieldset>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy}>
              {t("scheduled.form.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("scheduled.form.cancel")}
            </Button>
            {editing && onDelete && !confirmDelete ? (
              <Button
                type="button"
                variant="destructive"
                className="ms-auto"
                onClick={() => setConfirmDelete(true)}
              >
                {t("scheduled.form.delete")}
              </Button>
            ) : null}
          </div>
        </form>
      </ScreenColumn>
    </>
  );
}
