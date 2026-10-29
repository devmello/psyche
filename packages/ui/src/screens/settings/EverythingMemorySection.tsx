import type { EverythingExclusion } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { Input } from "../../components/ui/input.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { EverythingConsent } from "../../memory/EverythingConsent.tsx";
import {
  EVERYTHING_KEY,
  EVERYTHING_LOCAL_CONFIRMED,
  type EverythingValues,
  ModelFields,
  PeopleFields,
  readEverything,
  SensitiveFields,
  SourceFields,
} from "../../memory/EverythingFields.tsx";
import { ExclusionsPanel, type ExclusionsPanelProps } from "../../memory/ExclusionsPanel.tsx";
import { usePersona } from "../../slots.tsx";
import {
  Group,
  LoadGate,
  RadioField,
  SectionFrame,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Privacy → Everything memory (docs/design/everything-memory-2026.md §12.2). Off until
 * the owner runs the first-run consent; then the model (None until picked), sources, people,
 * sensitive topics, agent access, schedule and retention, each its own control.
 */

export function EverythingPanel({
  value,
  onChange,
  onTurnOn,
  localConfirmed,
  onConfirmLocal,
  exclusions,
}: {
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  onTurnOn: () => void;
  localConfirmed: string | undefined;
  onConfirmLocal: (ref: string) => void;
  exclusions: ReactElement;
}): ReactElement {
  const off = !value.enabled;
  return (
    <>
      <Group title={t("everything.enabled")}>
        <SwitchField
          label={t("everything.enabled")}
          description={t("everything.enabledHint")}
          checked={value.enabled}
          settingKey={EVERYTHING_KEY}
          onChange={(on) => (on ? onTurnOn() : onChange({ ...value, enabled: false }))}
        />
      </Group>
      {off ? null : (
        <>
          <ModelFields
            value={value}
            onChange={onChange}
            localConfirmed={localConfirmed}
            onConfirmLocal={onConfirmLocal}
          />
          <SourceFields value={value} onChange={onChange} />
          <PeopleFields value={value} onChange={onChange} />
          {exclusions}
          <SensitiveFields value={value} onChange={onChange} />
          <Group title={t("everything.agent.title")}>
            <RadioField
              label={t("everything.agent.title")}
              hideLabel
              grouped
              value={value.agentAccess}
              onChange={(a) => onChange({ ...value, agentAccess: a })}
              options={(["none", "accepted", "all"] as const).map((a) => ({
                value: a,
                label: t(`everything.agent.${a}`),
                hint: t(`everything.agent.${a}Hint`),
              }))}
            />
            <SwitchField
              label={t("everything.agent.sensitive")}
              checked={value.agentSeesSensitive}
              settingKey={EVERYTHING_KEY}
              onChange={(on) => onChange({ ...value, agentSeesSensitive: on })}
            />
          </Group>
          <Group title={t("everything.schedule.title")}>
            <TimeField
              label={t("everything.schedule.quietStart")}
              value={value.schedule.quietHoursStart}
              onChange={(v) =>
                onChange({ ...value, schedule: { ...value.schedule, quietHoursStart: v } })
              }
            />
            <TimeField
              label={t("everything.schedule.quietEnd")}
              value={value.schedule.quietHoursEnd}
              onChange={(v) =>
                onChange({ ...value, schedule: { ...value.schedule, quietHoursEnd: v } })
              }
            />
            <SwitchField
              label={t("everything.schedule.battery")}
              description={t("everything.schedule.batteryHint")}
              checked={value.schedule.runOnBattery}
              settingKey={EVERYTHING_KEY}
              onChange={(on) =>
                onChange({ ...value, schedule: { ...value.schedule, runOnBattery: on } })
              }
            />
          </Group>
          <Group title={t("everything.retention.title")}>
            <p className="px-3 text-callout text-label-secondary">
              {t("everything.retention.pending", { days: value.retention.pendingDays })}
            </p>
            <p className="px-3 text-callout text-label-secondary">
              {t("everything.retention.untrusted", {
                months: value.retention.untrustedAcceptedMonths,
              })}
            </p>
            <p className="px-3 text-callout text-label-secondary">
              {t("everything.retention.quarantine", { days: value.retention.quarantineDays })}
            </p>
            <p className="px-3 text-callout text-label-secondary">{t("everything.storage.note")}</p>
          </Group>
        </>
      )}
    </>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-3 px-3 text-body">
      {label}
      <Input
        id={id}
        type="time"
        value={value}
        onChange={(e) =>
          /^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value) && onChange(e.target.value)
        }
        className="h-7 w-28"
      />
    </label>
  );
}

export function EverythingMemorySection(): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const call = useCall();
  const list = useGatewayQuery("memory.exclusions.list", {});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = readEverything(form.values);
  const confirmedRaw = form.values[EVERYTHING_LOCAL_CONFIRMED];
  const localConfirmed = typeof confirmedRaw === "string" ? confirmedRaw : undefined;
  const fail = (err: unknown) =>
    toast.error(t("memoryReview.failed", { reason: describeError(err) }));

  const onAdd: ExclusionsPanelProps["onAdd"] = async (input) => {
    setBusy(true);
    try {
      const r = await call("memory.exclusions.add", input);
      if (input.dryRun !== true) list.reload();
      return r.forgotten;
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const onRemove = (e: EverythingExclusion) => {
    setBusy(true);
    call("memory.exclusions.remove", { id: e.id })
      .then(() => list.reload())
      .catch(fail)
      .finally(() => setBusy(false));
  };

  return (
    <SectionFrame
      needsApproval={form.needsApproval}
      title={t("everything.title")}
      description={t("everything.description", { persona: persona.name })}
    >
      <LoadGate
        label={t("everything.loadLabel")}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      >
        <EverythingPanel
          value={value}
          onChange={(next) => form.onChange(EVERYTHING_KEY, next)}
          onTurnOn={() => setConsent(true)}
          localConfirmed={localConfirmed}
          onConfirmLocal={(ref) => form.onChange(EVERYTHING_LOCAL_CONFIRMED, ref)}
          exclusions={
            <ExclusionsPanel
              entries={list.data?.entries ?? []}
              busy={busy}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          }
        />
        {consent ? (
          <EverythingConsent
            open
            initial={value}
            persona={persona.name}
            localConfirmed={localConfirmed}
            onCancel={() => setConsent(false)}
            onFinish={(settings, confirmLocal) => {
              if (confirmLocal !== undefined)
                form.onChange(EVERYTHING_LOCAL_CONFIRMED, confirmLocal);
              form.onChange(EVERYTHING_KEY, settings);
              setConsent(false);
            }}
          />
        ) : null}
      </LoadGate>
    </SectionFrame>
  );
}
