import { type ReactElement, useEffect, useId, useState } from "react";
import { formatTokens } from "../../chat/context/types.ts";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { Group, num, SettingHint, type SettingsValues } from "./shared.tsx";

/**
 * Context and compaction (owner priority after #447): the thread context limit, when earlier
 * turns are summarised, and how many recent turns always stay verbatim. Bounds keep the values
 * sane; a value outside them is explained and not saved.
 */

export const CONTEXT_KEYS = {
  maxTokens: "context.maxTokens",
  compactAt: "context.compactAt",
  keepRecentTurns: "context.keepRecentTurns",
} as const;

/** The Gateway's bounds and defaults (`ContextLimits`, docs/status/s02.md). */
export const CONTEXT_BOUNDS = {
  maxTokens: { min: 1_000, step: 1_000 },
  /** Percent of the limit. */
  compactAt: { min: 20, max: 95, default: 80 },
  keepRecentTurns: { min: 1, max: 20, default: 4 },
} as const;

/** A whole-number field that saves on Enter or blur, only inside its bounds. */
function BoundedNumber({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  suffix,
  settingKey,
  onCommit,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  settingKey: string;
  onCommit: (value: number) => void;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft.replaceAll(",", ""));
    if (!Number.isInteger(n) || n < min || n > max) {
      setError(t("settings.context.errorRange", { min, max }));
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-foreground">
        {label}
      </label>
      <p id={`${id}-desc`} className="text-xs text-muted-foreground">
        {description}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          className="w-36"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-describedby={`${id}-desc${error ? ` ${id}-error` : ""}`}
          aria-invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
      <SettingHint settingKey={settingKey} />
    </div>
  );
}

export interface ContextSettingsGroupProps {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
  /** The primary model's context length, when the router knows it. */
  modelContextLength?: number;
}

export function ContextSettingsGroup({
  values,
  onChange,
  modelContextLength,
}: ContextSettingsGroupProps): ReactElement {
  const ceiling = modelContextLength ?? 2_000_000;
  const limit = Math.min(num(values, CONTEXT_KEYS.maxTokens, ceiling), ceiling);
  const compactPct = Math.round(
    num(values, CONTEXT_KEYS.compactAt, CONTEXT_BOUNDS.compactAt.default / 100) * 100,
  );
  const keep = num(values, CONTEXT_KEYS.keepRecentTurns, CONTEXT_BOUNDS.keepRecentTurns.default);
  return (
    <Group
      title={t("settings.context.title")}
      description={
        modelContextLength
          ? t("settings.context.modelReads", {
              n: modelContextLength,
              short: formatTokens(modelContextLength),
            })
          : t("settings.context.modelUnknown")
      }
    >
      <BoundedNumber
        label={t("settings.key.context.maxTokens")}
        description={t("settings.context.maxTokensHint")}
        value={limit}
        min={CONTEXT_BOUNDS.maxTokens.min}
        max={ceiling}
        step={CONTEXT_BOUNDS.maxTokens.step}
        suffix={t("settings.context.tokens")}
        settingKey={CONTEXT_KEYS.maxTokens}
        onCommit={(v) => onChange(CONTEXT_KEYS.maxTokens, v)}
      />
      <BoundedNumber
        label={t("settings.key.context.compactAt")}
        description={t("settings.context.compactAtHint", {
          n: Math.round((limit * compactPct) / 100),
        })}
        value={compactPct}
        min={CONTEXT_BOUNDS.compactAt.min}
        max={CONTEXT_BOUNDS.compactAt.max}
        suffix={t("settings.context.percentOfLimit")}
        settingKey={CONTEXT_KEYS.compactAt}
        onCommit={(v) => onChange(CONTEXT_KEYS.compactAt, v / 100)}
      />
      <BoundedNumber
        label={t("settings.key.context.keepRecentTurns")}
        description={t("settings.context.keepHint")}
        value={keep}
        min={CONTEXT_BOUNDS.keepRecentTurns.min}
        max={CONTEXT_BOUNDS.keepRecentTurns.max}
        suffix={t("settings.context.turns")}
        settingKey={CONTEXT_KEYS.keepRecentTurns}
        onCommit={(v) => onChange(CONTEXT_KEYS.keepRecentTurns, v)}
      />
    </Group>
  );
}
