import { TEACHING_SETTING_DEFAULTS, type TeachingImplicitSignals } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { bool, Group, type SettingsFormProps, SwitchField } from "./shared.tsx";

/** The implicit signals, each its own switch under "Notice edits, undos and dismissals". */
const SIGNALS: readonly (keyof TeachingImplicitSignals)[] = [
  "draftEdits",
  "undo",
  "approvalEdits",
  "dismissals",
];

function implicitOf(values: Record<string, unknown>): TeachingImplicitSignals {
  const v = values["teaching.implicit"];
  return {
    ...TEACHING_SETTING_DEFAULTS["teaching.implicit"],
    ...(v !== null && typeof v === "object" ? (v as Partial<TeachingImplicitSignals>) : {}),
  };
}

/**
 * Settings → Data controls → Learning (teaching loop §8): learn from feedback, notice implicit
 * signals (each its own switch), pause learning, the weekly card, a link to Growth, and Forget
 * everything I learned behind a typed confirmation.
 */
export function LearningGroup({
  values,
  onChange,
  persona,
  busy = false,
  onOpenGrowth,
  onForgetAll,
}: Pick<SettingsFormProps, "values" | "onChange"> & {
  persona: string;
  busy?: boolean;
  onOpenGrowth?: () => void;
  onForgetAll?: () => void;
}): ReactElement {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const implicit = implicitOf(values);
  const anyImplicit = SIGNALS.some((s) => implicit[s]);
  const phrase = t("settings.learning.forgetPhrase");
  return (
    <Group title={t("settings.learning.title")}>
      <SwitchField
        label={t("settings.learning.enabled")}
        description={t("settings.learning.enabledHint", { persona })}
        checked={bool(values, "teaching.enabled", true)}
        onChange={(v) => onChange("teaching.enabled", v)}
      />
      <SwitchField
        label={t("settings.learning.implicit")}
        description={t("settings.learning.implicitHint")}
        checked={anyImplicit}
        onChange={(v) =>
          onChange(
            "teaching.implicit",
            Object.fromEntries(SIGNALS.map((s) => [s, v])) as TeachingImplicitSignals,
          )
        }
      />
      <details className="ps-3 text-sm">
        <summary className="cursor-pointer text-label-secondary">
          {t("settings.learning.signals")}
        </summary>
        <div className="mt-1 flex flex-col">
          {SIGNALS.map((s) => (
            <SwitchField
              key={s}
              label={t(`settings.learning.signal.${s}`)}
              checked={implicit[s]}
              onChange={(v) => onChange("teaching.implicit", { ...implicit, [s]: v })}
            />
          ))}
        </div>
      </details>
      <SwitchField
        label={t("settings.learning.paused")}
        description={t("settings.learning.pausedHint")}
        checked={bool(values, "teaching.paused", false)}
        onChange={(v) => onChange("teaching.paused", v)}
      />
      <SwitchField
        label={t("settings.learning.weeklyCard")}
        description={t("settings.learning.weeklyCardHint")}
        checked={bool(values, "teaching.weeklyCard", true)}
        onChange={(v) => onChange("teaching.weeklyCard", v)}
      />
      {onOpenGrowth ? (
        <div className="flex items-center justify-between gap-3">
          <span>{t("settings.learning.open", { persona })}</span>
          <Button type="button" variant="outline" size="sm" onClick={onOpenGrowth}>
            {t("settings.learning.openButton")}
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{t("settings.learning.forgetAllTitle", { persona })}</p>
          <Label htmlFor={`${id}-forget`}>{t("settings.learning.forgetAllBody", { phrase })}</Label>
          <Input
            id={`${id}-forget`}
            className="max-w-xs"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={typed.trim().toLowerCase() !== phrase || busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
                onForgetAll?.();
              }}
            >
              {t("settings.learning.forgetAllGo")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-danger-text"
            disabled={!onForgetAll || busy}
            onClick={() => setConfirming(true)}
          >
            {t("settings.learning.forgetAll", { persona })}
          </Button>
        </div>
      )}
    </Group>
  );
}
