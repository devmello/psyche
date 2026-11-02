import type { EverythingExclusion, EverythingRunResult, EverythingSource } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useCall, useGatewayQuery, useSearchSources } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { EverythingConsent } from "../../memory/EverythingConsent.tsx";
import {
  EVERYTHING_KEY,
  EVERYTHING_LOCAL_CONFIRMED,
  type EverythingValues,
  ModelFields,
  PeopleFields,
  PerSourceModels,
  readConfirmed,
  readEverything,
  SensitiveFields,
  SourceFields,
} from "../../memory/EverythingFields.tsx";
import { ExclusionsPanel, type ExclusionsPanelProps } from "../../memory/ExclusionsPanel.tsx";
import { estimateMonthly, formatUsd } from "../../memory/estimate.ts";
import { usePersona, useSlots } from "../../slots.tsx";
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
  onRunNow,
  running = false,
  runResult = null,
  indexed,
  onOpenSearch,
}: {
  /** Sources Search indexes now; the rest say so (see `SourceFields`). */
  indexed?: ReadonlySet<EverythingSource>;
  onOpenSearch?: () => void;
  value: EverythingValues;
  onChange: (next: EverythingValues) => void;
  onTurnOn: () => void;
  localConfirmed: readonly string[];
  onConfirmLocal: (ref: string) => void;
  exclusions: ReactElement;
  onRunNow?: () => void;
  running?: boolean;
  runResult?: EverythingRunResult | null;
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
          <PerSourceModels
            value={value}
            onChange={onChange}
            localConfirmed={localConfirmed}
            onConfirmLocal={onConfirmLocal}
          />
          <SourceFields
            value={value}
            onChange={onChange}
            {...(indexed === undefined ? {} : { indexed })}
            {...(onOpenSearch === undefined ? {} : { onOpenSearch })}
          />
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
          <Group title={t("everything.run.button")} description={t("everything.run.hint")}>
            <div className="flex flex-col gap-2 px-3">
              <p className="text-callout text-label-secondary" data-testid="run-estimate">
                {value.model.default.kind === "cloud"
                  ? t("everything.run.estimateCloud", {
                      cost: formatUsd(estimateMonthly("cloud", value.sources).typical / 30),
                    })
                  : t("everything.run.estimateFree")}
              </p>
              <Button
                size="sm"
                className="self-start"
                disabled={running || onRunNow === undefined}
                onClick={onRunNow}
              >
                {running ? t("everything.run.running") : t("everything.run.button")}
              </Button>
              {runResult === null ? null : (
                <p role="status" data-testid="run-result" className="text-callout">
                  {runResult.ran
                    ? t("everything.run.done", {
                        items: runResult.itemsRead,
                        facts: runResult.factsProposed,
                        held: runResult.quarantined,
                        more: runResult.deferred > 0 ? "yes" : "no",
                      })
                    : t(`everything.run.reason.${runResult.reason ?? "disabled"}`)}
                </p>
              )}
            </div>
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
  const { navigate } = useSlots();
  const search = useSearchSources();
  // Unknown until Search answers, so nothing says "not indexed" while it loads.
  const indexed =
    search.status === undefined
      ? undefined
      : new Set<EverythingSource>(search.status.sources.filter((s) => s.enabled).map((s) => s.id));
  const call = useCall();
  const list = useGatewayQuery("memory.exclusions.list", {});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<EverythingRunResult | null>(null);
  const value = readEverything(form.values);
  const localConfirmed = readConfirmed(form.values[EVERYTHING_LOCAL_CONFIRMED]);
  const confirmLocal = (ref: string) =>
    form.onChange(EVERYTHING_LOCAL_CONFIRMED, [...new Set([...localConfirmed, ref])]);
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
          onConfirmLocal={confirmLocal}
          running={running}
          runResult={runResult}
          {...(indexed === undefined ? {} : { indexed })}
          {...(navigate ? { onOpenSearch: () => navigate("/settings/search") } : {})}
          onRunNow={() => {
            setRunning(true);
            setRunResult(null);
            call("memory.everything.run", {})
              .then(setRunResult)
              .catch(fail)
              .finally(() => setRunning(false));
          }}
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
            onFinish={(settings, confirmed) => {
              if (confirmed.length > 0) form.onChange(EVERYTHING_LOCAL_CONFIRMED, confirmed);
              form.onChange(EVERYTHING_KEY, settings);
              setConsent(false);
            }}
          />
        ) : null}
      </LoadGate>
    </SectionFrame>
  );
}
