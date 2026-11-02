import type { EverythingRunResult, EverythingSource } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useCall, useSearchSources } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { EverythingConsent } from "../../memory/EverythingConsent.tsx";
import {
  EVERYTHING_KEY,
  EVERYTHING_LOCAL_CONFIRMED,
  type EverythingValues,
  readConfirmed,
  readEverything,
  SourceFields,
} from "../../memory/EverythingFields.tsx";
import { estimateMonthly, formatUsd } from "../../memory/estimate.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { Group, LoadGate, SectionFrame, useSettingsForm } from "./shared.tsx";

/**
 * Settings → Memory → Sources (docs/design/everything-memory-2026.md §12.2): what Everything
 * memory reads, and Run now. Off until the owner runs the first-run consent (from Basics or from
 * here); the model, schedule, privacy choices and exclusions live under Advanced and Privacy.
 */

export function EverythingPanel({
  value,
  onChange,
  onTurnOn,
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
  onRunNow?: () => void;
  running?: boolean;
  runResult?: EverythingRunResult | null;
}): ReactElement {
  const persona = usePersona();
  if (!value.enabled) {
    return (
      <Group title={t("everything.enabledGroup")} description={t("everything.offHint")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-body text-label-secondary">
            {t("everything.off", { persona: persona.name })}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onTurnOn}>
            {t("everything.turnOn")}
          </Button>
        </div>
      </Group>
    );
  }
  return (
    <>
      <SourceFields
        value={value}
        onChange={onChange}
        {...(indexed === undefined ? {} : { indexed })}
        {...(onOpenSearch === undefined ? {} : { onOpenSearch })}
      />
      <Group title={t("everything.run.title")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="min-w-0 flex-1 text-callout text-label-secondary"
            data-testid="run-estimate"
          >
            {t("everything.run.hint")}{" "}
            {value.model.default.kind === "cloud"
              ? t("everything.run.estimateCloud", {
                  cost: formatUsd(estimateMonthly("cloud", value.sources).typical / 30),
                })
              : t("everything.run.estimateFree")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={running || onRunNow === undefined}
            onClick={onRunNow}
          >
            {running ? t("everything.run.running") : t("everything.run.button")}
          </Button>
        </div>
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
      </Group>
    </>
  );
}

export function TimeField({
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

/**
 * Everything memory's settings value, its switch and the first-run consent. Basics (the switch)
 * and Sources (a Set up… button when it is off) each use it, so the consent is one flow.
 */
export function useEverythingSetup() {
  const form = useSettingsForm();
  const persona = usePersona();
  const [consent, setConsent] = useState(false);
  const value = readEverything(form.values);
  const localConfirmed = readConfirmed(form.values[EVERYTHING_LOCAL_CONFIRMED]);
  const confirmLocal = (ref: string) =>
    form.onChange(EVERYTHING_LOCAL_CONFIRMED, [...new Set([...localConfirmed, ref])]);
  const dialog = consent ? (
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
  ) : null;
  return {
    form,
    value,
    localConfirmed,
    confirmLocal,
    turnOn: () => setConsent(true),
    turnOff: () => form.onChange(EVERYTHING_KEY, { ...value, enabled: false }),
    setValue: (next: EverythingValues) => form.onChange(EVERYTHING_KEY, next),
    dialog,
  };
}

export function EverythingMemorySection(): ReactElement {
  const persona = usePersona();
  const { navigate } = useSlots();
  const search = useSearchSources();
  // Unknown until Search answers, so nothing says "not indexed" while it loads.
  const indexed =
    search.status === undefined
      ? undefined
      : new Set<EverythingSource>(search.status.sources.filter((s) => s.enabled).map((s) => s.id));
  const call = useCall();
  const setup = useEverythingSetup();
  const { form } = setup;
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<EverythingRunResult | null>(null);
  const fail = (err: unknown) =>
    toast.error(t("memoryReview.failed", { reason: describeError(err) }));

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
          value={setup.value}
          onChange={setup.setValue}
          onTurnOn={setup.turnOn}
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
        />
        {setup.dialog}
      </LoadGate>
    </SectionFrame>
  );
}
