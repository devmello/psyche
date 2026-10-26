import { type ReactElement, useEffect, useId, useState } from "react";
import { usePrefillComposer } from "../../chat/prefill.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  num,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  SwitchField,
  str,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Defaults shown when a key is unset are the Gateway's own (spec §4): prep 120 min ahead and a
 * notice 60 min ahead, mail checks every 10 min while active and hourly otherwise.
 *
 * Settings → Mail & meetings (docs/workflows/mail-and-meetings-2026.md §7.3), under General:
 * the two master switches (pause, read-only), then one grouped list per workflow. Every switch
 * is a Gateway setting (`mail.*`, `meetings.*`, `workflows.*`); the jobs read them when they
 * run, so a change takes effect on the next run. The voice profile and the sender rules are
 * workspace files: View, Edit and Reset hand the owner's request to the composer.
 */

/** Connector types that are mail accounts. */
const MAIL_TYPES = new Set(["google", "microsoft", "imap", "apple:mail"]);

/** One row with a label, a hint and a native select (the section's only select shape). */
function SelectRow({
  label,
  hint,
  value,
  options,
  onChange,
  settingKey,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  settingKey?: string;
  disabled?: boolean;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <label htmlFor={id} className="text-body text-label-primary">
            {label}
          </label>
          {hint ? <p className="text-callout text-label-secondary">{hint}</p> : null}
        </div>
        <NativeSelect
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {settingKey ? <SettingHint settingKey={settingKey} /> : null}
    </div>
  );
}

/** A time of day ("07:30") that commits on blur or Return. */
function TimeRow({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  disabled: boolean;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (/^\d{2}:\d{2}$/.test(draft) && draft !== value) onCommit(draft);
    else setDraft(value);
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={id} className="min-w-0 flex-1 text-body text-label-primary">
        {label}
      </label>
      <Input
        id={id}
        type="time"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="h-7 w-28 tabular-nums"
      />
    </div>
  );
}

const opts = (values: readonly number[], label: (n: number) => string) =>
  values.map((n) => ({ value: String(n), label: label(n) }));

const minutes = (n: number) => t("settings.mail.schedule.minutes", { n });
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export interface MailAccountView {
  id: string;
  label: string;
}

export interface MailMeetingsPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  accounts: readonly MailAccountView[];
  /** Local model refs the draft picker offers. */
  localModels: readonly string[];
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Hands a request to the composer (voice profile and sender rules are files). */
  onAsk?: (text: string) => void;
  onOpenConnectors?: () => void;
}

/** The presentational section; `MailMeetingsSection` feeds it from the Gateway. */
export function MailMeetingsPanel({
  values,
  onChange,
  accounts,
  localModels,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
  onAsk,
  onOpenConnectors,
}: MailMeetingsPanelProps): ReactElement {
  const paused = bool(values, "workflows.paused", false);
  const readOnly = bool(values, "workflows.readOnly", false);
  // Paused stops every job, so the rest of the page is set aside but stays readable.
  const off = paused;
  const prepOn = bool(values, "meetings.prep.enabled", false);
  const digestOn = bool(values, "mail.digest.enabled", false);
  const followupsOn = bool(values, "mail.followups.enabled", false);
  const notesOn = bool(values, "meetings.notes.enabled", false);
  const localModel = str(values, "mail.draft.localModel", "");
  const ask = (id: Parameters<typeof t>[0]) => () => onAsk?.(t(id));

  return (
    <SectionFrame
      title={t("settings.mail.title")}
      description={t("settings.mail.description")}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.mail.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.mail.group.master")}>
          <SwitchField
            label={t("settings.key.workflows.paused")}
            description={t("settings.mail.paused.hint")}
            settingKey="workflows.paused"
            checked={paused}
            onChange={(v) => onChange("workflows.paused", v)}
          />
          <SwitchField
            label={t("settings.key.workflows.readOnly")}
            description={t("settings.mail.readOnly.hint")}
            settingKey="workflows.readOnly"
            checked={readOnly}
            disabled={off}
            onChange={(v) => onChange("workflows.readOnly", v)}
          />
        </Group>

        <Group title={t("settings.mail.group.accounts")}>
          {accounts.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-callout text-label-secondary">
                {t("settings.mail.accounts.none")}
              </p>
              {onOpenConnectors ? (
                <Button type="button" variant="outline" size="sm" onClick={onOpenConnectors}>
                  {t("settings.mail.accounts.connect")}
                </Button>
              ) : null}
            </div>
          ) : (
            accounts.map((a) => (
              <SwitchField
                key={a.id}
                label={t("settings.mail.accounts.use", { account: a.label })}
                checked={bool(values, `mail.accounts.${a.id}`, true)}
                disabled={off}
                onChange={(v) => onChange(`mail.accounts.${a.id}`, v)}
              />
            ))
          )}
        </Group>

        <Group title={t("settings.mail.group.digest")}>
          <SwitchField
            label={t("settings.key.mail.digest.enabled")}
            settingKey="mail.digest.enabled"
            checked={digestOn}
            disabled={off}
            onChange={(v) => onChange("mail.digest.enabled", v)}
          />
          <TimeRow
            label={t("settings.mail.digest.time")}
            value={str(values, "mail.digest.time", "07:30")}
            disabled={off || !digestOn}
            onCommit={(v) => onChange("mail.digest.time", v)}
          />
          <SelectRow
            label={t("settings.mail.digest.days")}
            settingKey="mail.digest.days"
            value={str(values, "mail.digest.days", "weekdays")}
            disabled={off || !digestOn}
            options={[
              { value: "weekdays", label: t("settings.mail.digest.days.weekdays") },
              { value: "everyday", label: t("settings.mail.digest.days.everyday") },
            ]}
            onChange={(v) => onChange("mail.digest.days", v)}
          />
          <SwitchField
            label={t("settings.key.mail.digest.onlyWhenNeeded")}
            description={t("settings.mail.digest.onlyWhenNeeded.hint")}
            settingKey="mail.digest.onlyWhenNeeded"
            checked={bool(values, "mail.digest.onlyWhenNeeded", false)}
            disabled={off || !digestOn}
            onChange={(v) => onChange("mail.digest.onlyWhenNeeded", v)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-label-primary">
                {t("settings.mail.digest.rules")}
              </span>
              <p className="text-callout text-label-secondary">
                {t("settings.mail.digest.rulesHint")}
              </p>
            </div>
            {onAsk ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={ask("settings.mail.digest.openRulesAsk")}
              >
                {t("settings.mail.digest.openRules")}
              </Button>
            ) : null}
          </div>
        </Group>

        <Group title={t("settings.mail.group.followups")}>
          <SwitchField
            label={t("settings.key.mail.followups.enabled")}
            settingKey="mail.followups.enabled"
            checked={followupsOn}
            disabled={off}
            onChange={(v) => onChange("mail.followups.enabled", v)}
          />
          <SelectRow
            label={t("settings.mail.followups.waitDays")}
            settingKey="mail.followups.waitDays"
            value={String(num(values, "mail.followups.waitDays", 3))}
            disabled={off || !followupsOn}
            options={opts([1, 2, 3, 5, 7], (n) => t("settings.mail.followups.days", { n }))}
            onChange={(v) => onChange("mail.followups.waitDays", Number(v))}
          />
          <SwitchField
            label={t("settings.key.mail.followups.showTwice")}
            description={t("settings.mail.followups.showTwice.hint")}
            settingKey="mail.followups.showTwice"
            checked={bool(values, "mail.followups.showTwice", true)}
            disabled={off || !followupsOn}
            onChange={(v) => onChange("mail.followups.showTwice", v)}
          />
        </Group>

        <Group title={t("settings.mail.group.style")}>
          <SwitchField
            label={t("settings.key.mail.voice.enabled")}
            description={t("settings.mail.voice.learn.hint")}
            settingKey="mail.voice.enabled"
            checked={bool(values, "mail.voice.enabled", false)}
            disabled={off}
            onChange={(v) => onChange("mail.voice.enabled", v)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-body text-label-primary">
              {t("settings.mail.voice.profile")}
            </span>
            {onAsk ? (
              <span className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={ask("settings.mail.voice.viewAsk")}
                >
                  {t("settings.mail.voice.view")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={ask("settings.mail.voice.editAsk")}
                >
                  {t("settings.mail.voice.edit")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={ask("settings.mail.voice.resetAsk")}
                >
                  {t("settings.mail.voice.reset")}
                </Button>
              </span>
            ) : null}
          </div>
          {localModels.length === 0 ? (
            <div className="flex flex-col">
              <span className="text-body text-label-primary">
                {t("settings.key.mail.draft.localModel")}
              </span>
              <p className="text-callout text-label-secondary">
                {t("settings.mail.voice.localModel.empty")}
              </p>
            </div>
          ) : (
            <SelectRow
              label={t("settings.key.mail.draft.localModel")}
              hint={t("settings.mail.voice.localModel.hint")}
              settingKey="mail.draft.localModel"
              value={localModel}
              disabled={off}
              options={[
                { value: "", label: t("settings.mail.voice.localModel.none") },
                ...localModels.map((m) => ({ value: m, label: m })),
              ]}
              onChange={(v) => onChange("mail.draft.localModel", v)}
            />
          )}
        </Group>

        <Group title={t("settings.mail.group.scheduling")}>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body text-label-primary">
                  {t("settings.mail.schedule.hours")}
                </span>
                <p className="text-callout text-label-secondary">
                  {t("settings.mail.schedule.hoursHint")}
                </p>
              </div>
              <NativeSelect
                aria-label={t("settings.mail.schedule.hoursFrom")}
                value={String(num(values, "mail.schedule.hoursStart", 9))}
                disabled={off}
                onChange={(e) => onChange("mail.schedule.hoursStart", Number(e.target.value))}
              >
                {opts(
                  Array.from({ length: 24 }, (_, h) => h),
                  hourLabel,
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label={t("settings.mail.schedule.hoursTo")}
                value={String(num(values, "mail.schedule.hoursEnd", 17))}
                disabled={off}
                onChange={(e) => onChange("mail.schedule.hoursEnd", Number(e.target.value))}
              >
                {opts(
                  Array.from({ length: 24 }, (_, h) => h + 1),
                  hourLabel,
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <SelectRow
            label={t("settings.key.mail.schedule.bufferMin")}
            hint={t("settings.mail.schedule.buffer.hint")}
            settingKey="mail.schedule.bufferMin"
            value={String(num(values, "mail.schedule.bufferMin", 15))}
            disabled={off}
            options={[
              { value: "0", label: t("settings.mail.schedule.noBuffer") },
              ...opts([5, 10, 15, 30], minutes),
            ]}
            onChange={(v) => onChange("mail.schedule.bufferMin", Number(v))}
          />
          <SwitchField
            label={t("settings.key.mail.schedule.focusTime")}
            description={t("settings.mail.schedule.focusTime.hint")}
            settingKey="mail.schedule.focusTime"
            checked={bool(values, "mail.schedule.focusTime", false)}
            disabled={off}
            onChange={(v) => onChange("mail.schedule.focusTime", v)}
          />
          <TextSetting
            label={t("settings.key.mail.schedulingLink")}
            description={t("settings.mail.schedule.link.hint")}
            settingKey="mail.schedulingLink"
            value={str(values, "mail.schedulingLink", "")}
            placeholder={t("settings.mail.schedule.link.placeholder")}
            maxLength={500}
            onCommit={(v) => onChange("mail.schedulingLink", v)}
          />
        </Group>

        <Group
          title={t("settings.mail.group.prep")}
          description={t("settings.mail.prep.calendars")}
        >
          <SwitchField
            label={t("settings.key.meetings.prep.enabled")}
            settingKey="meetings.prep.enabled"
            checked={prepOn}
            disabled={off}
            onChange={(v) => onChange("meetings.prep.enabled", v)}
          />
          <SwitchField
            label={t("settings.key.meetings.prep.scope")}
            description={t("settings.mail.prep.scope.hint")}
            settingKey="meetings.prep.scope"
            checked={str(values, "meetings.prep.scope", "external") !== "all"}
            disabled={off || !prepOn}
            onChange={(v) => onChange("meetings.prep.scope", v ? "external" : "all")}
          />
          <SelectRow
            label={t("settings.mail.prep.leadMin")}
            settingKey="meetings.prep.leadMin"
            value={String(num(values, "meetings.prep.leadMin", 120))}
            disabled={off || !prepOn}
            options={opts([30, 60, 120, 240], minutes)}
            onChange={(v) => onChange("meetings.prep.leadMin", Number(v))}
          />
          <SelectRow
            label={t("settings.mail.prep.notifyMin")}
            settingKey="meetings.prep.notifyMin"
            value={String(num(values, "meetings.prep.notifyMin", 60))}
            disabled={off || !prepOn}
            options={opts([5, 10, 15, 30, 60], minutes)}
            onChange={(v) => onChange("meetings.prep.notifyMin", Number(v))}
          />
          <SwitchField
            label={t("settings.key.meetings.prep.saveToNotes")}
            description={t("settings.mail.prep.saveToNotes.hint")}
            settingKey="meetings.prep.saveToNotes"
            checked={bool(values, "meetings.prep.saveToNotes", false)}
            disabled={off || !prepOn}
            onChange={(v) => onChange("meetings.prep.saveToNotes", v)}
          />
          <SelectRow
            label={t("settings.mail.prep.dailyCap")}
            settingKey="meetings.prep.dailyCap"
            value={String(num(values, "meetings.prep.dailyCap", 4))}
            disabled={off || !prepOn}
            options={opts([1, 2, 3, 4], (n) => String(n))}
            onChange={(v) => onChange("meetings.prep.dailyCap", Number(v))}
          />
        </Group>

        <Group title={t("settings.mail.group.notes")}>
          <SwitchField
            label={t("settings.key.meetings.notes.enabled")}
            description={t("settings.mail.notes.enabled.hint")}
            settingKey="meetings.notes.enabled"
            checked={notesOn}
            disabled={off}
            onChange={(v) => onChange("meetings.notes.enabled", v)}
          />
          <TextSetting
            label={t("settings.mail.notes.folder")}
            description={t("settings.mail.notes.folder.hint")}
            settingKey="meetings.notes.folder"
            value={str(values, "meetings.notes.folder", "")}
            placeholder={t("settings.mail.notes.folder.placeholder")}
            maxLength={1024}
            onCommit={(v) => onChange("meetings.notes.folder", v)}
          />
          <SelectRow
            label={t("settings.mail.notes.tasksApp")}
            settingKey="meetings.notes.tasksApp"
            value={str(values, "meetings.notes.tasksApp", "reminders")}
            disabled={off || !notesOn}
            options={[
              { value: "reminders", label: t("settings.mail.notes.tasksApp.reminders") },
              { value: "things", label: t("settings.mail.notes.tasksApp.things") },
            ]}
            onChange={(v) => onChange("meetings.notes.tasksApp", v)}
          />
          <SwitchField
            label={t("settings.key.meetings.notes.recapDraft")}
            description={t("settings.mail.notes.recap.hint")}
            settingKey="meetings.notes.recapDraft"
            checked={bool(values, "meetings.notes.recapDraft", false)}
            disabled={off || !notesOn}
            onChange={(v) => onChange("meetings.notes.recapDraft", v)}
          />
          <TextSetting
            label={t("settings.key.meetings.notes.consentLine")}
            description={t("settings.mail.notes.consent.hint")}
            settingKey="meetings.notes.consentLine"
            value={str(
              values,
              "meetings.notes.consentLine",
              t("settings.mail.notes.consent.default"),
            )}
            maxLength={300}
            onCommit={(v) => onChange("meetings.notes.consentLine", v)}
          />
          <SwitchField
            label={t("settings.key.meetings.notes.cloudSummary")}
            description={t("settings.mail.notes.cloud.hint")}
            settingKey="meetings.notes.cloudSummary"
            checked={bool(values, "meetings.notes.cloudSummary", false)}
            disabled={off || !notesOn}
            onChange={(v) => onChange("meetings.notes.cloudSummary", v)}
          />
        </Group>

        <Group
          title={t("settings.mail.group.polling")}
          description={`${t("settings.mail.poll.hint")} ${t("settings.mail.quietHours")}`}
        >
          <SelectRow
            label={t("settings.mail.poll.active")}
            settingKey="mail.poll.activeMin"
            value={String(num(values, "mail.poll.activeMin", 10))}
            disabled={off}
            options={opts([1, 2, 5, 10, 15], minutes)}
            onChange={(v) => onChange("mail.poll.activeMin", Number(v))}
          />
          <SelectRow
            label={t("settings.mail.poll.idle")}
            settingKey="mail.poll.idleMin"
            value={String(num(values, "mail.poll.idleMin", 60))}
            disabled={off}
            options={opts([15, 30, 60, 120], minutes)}
            onChange={(v) => onChange("mail.poll.idleMin", Number(v))}
          />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

/** Connected: `settings.*`, the mail accounts from `connectors.list`, local models from `models.list`. */
export function MailMeetingsSection(): ReactElement {
  const form = useSettingsForm();
  const connectors = useGatewayQuery("connectors.list", {});
  const models = useGatewayQuery("models.list", {});
  const { navigate } = useSlots();
  const prefill = usePrefillComposer();
  const accounts = (connectors.data?.connectors ?? [])
    .filter((c) => MAIL_TYPES.has(c.type) && c.status !== "disconnected")
    .map((c) => ({ id: c.id, label: c.label }));
  const localModels = (models.data?.providers ?? [])
    .filter((p) => p.local)
    .flatMap((p) => p.models.map((m) => m.ref));
  return (
    <div className="flex flex-col gap-3">
      <MailMeetingsPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        accounts={accounts}
        localModels={localModels}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(prefill ? { onAsk: prefill } : {})}
        {...(navigate ? { onOpenConnectors: () => navigate("/settings/connectors") } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
