import { FORK_BUDGET_USD_MAX, FORK_BUDGET_USD_MIN, FORK_SETTING_DEFAULTS } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Input } from "../components/ui/input.tsx";
import { t } from "../i18n/core.ts";
import {
  bool,
  Group,
  num,
  SettingHint,
  type SettingsValues,
  SwitchField,
} from "../screens/settings/shared.tsx";

export const FORK_KEYS = {
  budgetUsd: "forks.budgetUsd",
  expiryDays: "forks.expiryDays",
  suggestOptions: "forks.suggestOptions",
} as const;

export const FORK_EXPIRY_DAYS = { min: 1, max: 30 } as const;

/** A number field that saves on Enter or blur, only inside its bounds. */
function Bounded({
  label,
  hint,
  value,
  min,
  max,
  step,
  integer,
  settingKey,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  settingKey: string;
  onCommit: (v: number) => void;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      setError(true);
      return;
    }
    setError(false);
    if (n !== value) onCommit(n);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-foreground">
        {label}
      </label>
      <p id={`${id}-d`} className="m-0 text-callout text-muted-foreground">
        {hint}
      </p>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        className="w-36"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-describedby={`${id}-d`}
        aria-invalid={error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {error ? (
        <p role="alert" className="m-0 text-callout text-danger-text">
          {t("settings.forks.errorRange", { min, max })}
        </p>
      ) : null}
      <SettingHint settingKey={settingKey} />
    </div>
  );
}

/** Settings: the "Fork a plan" group (docs/design/fork-a-plan-2026.md §9). None is a sealed setting. */
export function ForkSettingsGroup({
  values,
  onChange,
}: {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  return (
    <Group title={t("settings.forks.title")} description={t("settings.forks.description")}>
      <Bounded
        label={t("settings.key.forks.budgetUsd")}
        hint={t("settings.forks.budgetHint")}
        value={num(values, FORK_KEYS.budgetUsd, FORK_SETTING_DEFAULTS["forks.budgetUsd"])}
        min={FORK_BUDGET_USD_MIN}
        max={FORK_BUDGET_USD_MAX}
        step={0.1}
        integer={false}
        settingKey={FORK_KEYS.budgetUsd}
        onCommit={(v) => onChange(FORK_KEYS.budgetUsd, v)}
      />
      <Bounded
        label={t("settings.key.forks.expiryDays")}
        hint={t("settings.forks.expiryHint")}
        value={num(values, FORK_KEYS.expiryDays, FORK_SETTING_DEFAULTS["forks.expiryDays"])}
        min={FORK_EXPIRY_DAYS.min}
        max={FORK_EXPIRY_DAYS.max}
        step={1}
        integer
        settingKey={FORK_KEYS.expiryDays}
        onCommit={(v) => onChange(FORK_KEYS.expiryDays, v)}
      />
      <SwitchField
        label={t("settings.key.forks.suggestOptions")}
        description={t("settings.forks.suggestHint")}
        checked={bool(
          values,
          FORK_KEYS.suggestOptions,
          FORK_SETTING_DEFAULTS["forks.suggestOptions"],
        )}
        settingKey={FORK_KEYS.suggestOptions}
        onChange={(v) => onChange(FORK_KEYS.suggestOptions, v)}
      />
    </Group>
  );
}
