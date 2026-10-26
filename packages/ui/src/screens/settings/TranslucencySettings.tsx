import { ChevronRight } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import {
  GLASS_BLUR_SETTING,
  GLASS_LIMITS,
  GLASS_PRESET_SETTING,
  GLASS_PRESETS,
  GLASS_REFRACTION_SETTING,
  GLASS_TINT_SETTING,
  type GlassPreset,
  glassIsPreset,
  glassPreset,
  glassValues,
} from "../../lib/glass-settings.ts";
import { cn } from "../../lib/utils.ts";
import { SettingHint } from "./shared.tsx";

/**
 * Settings → Appearance → Translucency (#597): the glass preset (the HIG's Clear and Regular
 * variants, or Opaque) and an Advanced disclosure with live sliders for tint, blur and refraction.
 * The values become root CSS variables (AppearanceProvider), so every glass surface updates at
 * once; the OS Reduce Transparency setting still wins.
 */
export function GlassPresetField({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const id = useId();
  const preset = glassPreset(values);
  const choose = (next: GlassPreset) => {
    onChange(GLASS_PRESET_SETTING, next);
    // A preset resets the Advanced values to its own.
    if (next !== "opaque") {
      const v = GLASS_PRESETS[next];
      onChange(GLASS_TINT_SETTING, v.tint);
      onChange(GLASS_BLUR_SETTING, v.blur);
      onChange(GLASS_REFRACTION_SETTING, v.refraction);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-5 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <span id={`${id}-label`} className="text-body text-label-primary">
            {t("settings.key.appearance.glass")}
          </span>
          <p id={`${id}-desc`} className="text-callout text-label-secondary">
            {t(`settings.appearance.glass.${preset}Hint`)}
          </p>
        </div>
        <ToggleGroup
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-desc`}
          value={[preset]}
          onValueChange={(v: unknown[]) => {
            const next = v[0];
            if (next === "clear" || next === "regular" || next === "opaque") choose(next);
          }}
        >
          {(["clear", "regular", "opaque"] as const).map((p) => (
            <ToggleGroupItem key={p} value={p} size="sm">
              {t(`settings.appearance.glass.${p}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <SettingHint settingKey={GLASS_PRESET_SETTING} />
    </div>
  );
}

function SliderRow({
  settingKey,
  label,
  value,
  limits,
  format,
  disabled,
  onChange,
}: {
  settingKey: string;
  label: string;
  value: number;
  limits: { min: number; max: number; step: number };
  format: (n: number) => string;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="w-32 shrink-0 text-body text-label-primary">
          {label}
        </label>
        <input
          id={id}
          type="range"
          min={limits.min}
          max={limits.max}
          step={limits.step}
          value={value}
          disabled={disabled}
          aria-valuetext={format(value)}
          onChange={(e) => onChange(settingKey, Number(e.currentTarget.value))}
          className="h-5 min-w-0 flex-1 accent-(--accent-9) disabled:opacity-50"
        />
        <output
          htmlFor={id}
          className="w-14 shrink-0 text-end text-callout text-label-secondary tabular-nums"
        >
          {format(value)}
        </output>
      </div>
      <SettingHint settingKey={settingKey} />
    </div>
  );
}

export function GlassAdvanced({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  const v = glassValues(values);
  const opaque = glassPreset(values) === "opaque";
  const n = (x: number) => activeI18n().number(x);
  const reset = () => {
    const base = GLASS_PRESETS[glassPreset(values) === "clear" ? "clear" : "regular"];
    onChange(GLASS_TINT_SETTING, base.tint);
    onChange(GLASS_BLUR_SETTING, base.blur);
    onChange(GLASS_REFRACTION_SETTING, base.refraction);
  };
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit items-center gap-1 rounded-sm text-body text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--duration-micro)",
            open && "rotate-90",
          )}
        />
        {t("settings.appearance.glass.advanced")}
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-2 ps-5">
          {opaque ? (
            <p className="text-callout text-label-secondary">
              {t("settings.appearance.glass.opaqueAdvanced")}
            </p>
          ) : null}
          <SliderRow
            settingKey={GLASS_TINT_SETTING}
            label={t("settings.key.appearance.glassTint")}
            value={v.tint}
            limits={GLASS_LIMITS.tint}
            format={(x) => `${n(x)} %`}
            disabled={opaque}
            onChange={onChange}
          />
          <SliderRow
            settingKey={GLASS_BLUR_SETTING}
            label={t("settings.key.appearance.glassBlur")}
            value={v.blur}
            limits={GLASS_LIMITS.blur}
            format={(x) => `${n(x)} px`}
            disabled={opaque}
            onChange={onChange}
          />
          <SliderRow
            settingKey={GLASS_REFRACTION_SETTING}
            label={t("settings.key.appearance.glassRefraction")}
            value={v.refraction}
            limits={GLASS_LIMITS.refraction}
            format={(x) => `${n(x)} %`}
            disabled={opaque}
            onChange={onChange}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={opaque || glassIsPreset(values)}
            onClick={reset}
          >
            {t("settings.appearance.glass.reset")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
