import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Check, X } from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import {
  REDUCE_TRANSPARENCY_SETTING,
  useSupportsVibrancy,
  VIBRANCY_SETTING,
} from "../../shell/AppearanceProvider.tsx";
import {
  DEFAULT_ACCENT_SEED,
  GRAY_FAMILIES,
  type GrayFamily,
  generateTheme,
  isValidSeed,
  type ModeTheme,
} from "../../theme/generate.ts";
import { appearanceFromSettings } from "../../theme/ThemeProvider.tsx";
import { LanguageGroup } from "./LanguageSettings.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/** Appearance (UI design §3.18, color system §4.8, theming API §4.10). */

type AccentId = "violet" | "blue" | "teal" | "green" | "amber" | "tomato" | "pink";

const accent = (id: AccentId, seed: string) => ({
  id,
  seed,
  /** The swatch's name, in the active language. */
  get name(): string {
    return t(`settings.appearance.accent.${id}`);
  },
});

export const ACCENT_PRESETS: readonly { id: AccentId; readonly name: string; seed: string }[] = [
  accent("violet", DEFAULT_ACCENT_SEED),
  accent("blue", "oklch(0.6 0.19 255)"),
  accent("teal", "oklch(0.62 0.12 185)"),
  accent("green", "oklch(0.63 0.15 145)"),
  accent("amber", "oklch(0.8 0.16 80)"),
  accent("tomato", "oklch(0.62 0.2 35)"),
  accent("pink", "oklch(0.62 0.2 350)"),
];

const grayLabel = (g: GrayFamily): string => t(`settings.appearance.gray.${g}`);

const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

function Scale({ label, colors }: { label: string; colors: readonly string[] }): ReactElement {
  return (
    <ol aria-label={label} className="grid grid-cols-12 gap-0.5">
      {STEPS.map((step) => (
        <li
          key={step}
          className="h-6 rounded-sm border border-gray-a3"
          style={{ backgroundColor: colors[step - 1] }}
        >
          <span className="sr-only">{t("settings.appearance.step", { step })}</span>
        </li>
      ))}
    </ol>
  );
}

function Ratio({ label, value, min }: { label: string; value: number; min: number }): ReactElement {
  const ok = value >= min;
  return (
    <li className="flex items-center gap-1.5">
      {ok ? (
        <Check className="size-3.5 text-success-text" aria-hidden="true" />
      ) : (
        <X className="size-3.5 text-danger-text" aria-hidden="true" />
      )}
      <span>
        {t("settings.appearance.ratio.label", { label })}{" "}
        <span className="tabular-nums">
          {t("settings.appearance.ratio.value", {
            value: activeI18n().number(value, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          })}
        </span>{" "}
        <span className="text-muted-foreground">
          {t("settings.appearance.ratio.gate", { ok, min })}
        </span>
      </span>
    </li>
  );
}

/** Live preview of one appearance: both 12-step scales, the WCAG gate and any nudges. */
export function ThemePreview({ mode }: { mode: ModeTheme }): ReactElement {
  const appearance = mode.appearance;
  const r = mode.report;
  return (
    <figure className="flex flex-col gap-2 rounded-md border border-gray-6 bg-background p-3">
      <figcaption className="font-medium">
        {t("settings.appearance.preview.name", { appearance })}
      </figcaption>
      <Scale
        label={t("settings.appearance.preview.accentScale", { appearance })}
        colors={mode.accent.solid}
      />
      <Scale
        label={t("settings.appearance.preview.grayScale", { appearance })}
        colors={mode.gray.solid}
      />
      <div
        className="inline-flex w-fit items-center rounded-md px-3 py-1 text-sm font-medium"
        style={{ backgroundColor: mode.accent.solid[8], color: mode.accentContrast }}
      >
        {t("settings.appearance.preview.button")}
      </div>
      <ul
        className="flex flex-col gap-0.5 text-xs"
        aria-label={t("settings.appearance.preview.contrast", { appearance })}
      >
        <Ratio label={t("settings.appearance.ratio.accent11")} value={r.accent11On2} min={4.5} />
        <Ratio label={t("settings.appearance.ratio.accent12")} value={r.accent12On2} min={7} />
        <Ratio label={t("settings.appearance.ratio.textOn9")} value={r.contrastOn9} min={4.5} />
        <Ratio label={t("settings.appearance.ratio.gray11")} value={r.gray11On2} min={4.5} />
        <Ratio label={t("settings.appearance.ratio.gray12")} value={r.gray12On2} min={7} />
      </ul>
      {mode.nudged.length > 0 ? (
        <div className="text-xs">
          <p className="font-medium text-approval-text">
            {t("settings.appearance.preview.nudged")}
          </p>
          <ul className="list-disc ps-4 text-muted-foreground">
            {mode.nudged.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settings.appearance.preview.noNudges")}</p>
      )}
    </figure>
  );
}

function AccentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (seed: string) => void;
}): ReactElement {
  const id = useId();
  const preset = ACCENT_PRESETS.find((p) => p.seed === value);
  const [draft, setDraft] = useState(preset ? "" : value);
  const invalid = draft.trim() !== "" && !isValidSeed(draft.trim());
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="font-medium">
        {t("settings.appearance.accentColor")}
      </span>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={preset ? preset.seed : ""}
        onValueChange={(v) => onChange(String(v))}
        className="flex flex-wrap gap-3"
      >
        {ACCENT_PRESETS.map((p) => (
          // One control per swatch: the colored circle is the radio, its name is the label.
          <Label
            key={p.id}
            htmlFor={`${id}-${p.id}`}
            className="flex-col gap-1.5 text-xs font-normal"
          >
            <RadioPrimitive.Root
              value={p.seed}
              id={`${id}-${p.id}`}
              className="flex size-8 items-center justify-center rounded-full border border-gray-a4 text-white outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring data-checked:ring-2 data-checked:ring-gray-12 data-checked:ring-offset-2 data-checked:ring-offset-background"
              style={{ backgroundColor: p.seed }}
            >
              <RadioPrimitive.Indicator>
                <Check className="size-4 drop-shadow-sm" aria-hidden="true" />
              </RadioPrimitive.Indicator>
            </RadioPrimitive.Root>
            {p.name}
          </Label>
        ))}
      </RadioGroup>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-seed`}>{t("settings.appearance.customColor")}</Label>
        <Input
          id={`${id}-seed`}
          className="max-w-xs font-mono"
          // i18n-ignore: a CSS colour value, not text
          placeholder="oklch(0.6 0.15 250)"
          value={draft}
          aria-invalid={invalid}
          aria-describedby={`${id}-seed-help`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const s = draft.trim();
            if (s !== "" && isValidSeed(s) && s !== value) onChange(s);
          }}
          onKeyDown={(e) => {
            const s = draft.trim();
            if (e.key === "Enter" && s !== "" && isValidSeed(s) && s !== value) onChange(s);
          }}
        />
        <p
          id={`${id}-seed-help`}
          className={cn("text-xs", invalid ? "text-danger-text" : "text-muted-foreground")}
        >
          {invalid ? t("settings.appearance.seedInvalid") : t("settings.appearance.seedHelp")}
        </p>
      </div>
    </div>
  );
}

/** The OS asks for opaque materials (`prefers-reduced-transparency`). */
function systemReducesTransparency(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-transparency: reduce)").matches
  );
}

export function AppearancePanel({
  values,
  onChange,
  needsApproval,
  loading,
  error,
  onRetry,
  supportsVibrancy = false,
}: SettingsFormProps &
  LoadProps & {
    /** The desktop window can draw the native sidebar material (shows the vibrancy switch). */
    supportsVibrancy?: boolean;
  }): ReactElement {
  const a = appearanceFromSettings(values);
  const theme = useMemo(
    () => generateTheme({ accentSeed: a.accentSeed, gray: a.gray }),
    [a.accentSeed, a.gray],
  );
  const motion = a.reduceMotion === "system" ? "system" : a.reduceMotion ? "on" : "off";
  // Unset follows the OS (AppearanceProvider leaves `data-reduce-transparency` off the root).
  const reduceTransparency = values[REDUCE_TRANSPARENCY_SETTING];
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.appearance.title")}
      description={t("settings.appearance.description")}
    >
      <LoadGate
        label={t("settings.appearance.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.key.appearance.theme")}>
          <RadioField
            label={t("settings.key.appearance.theme")}
            hideLabel
            inline
            value={a.theme}
            settingKey="appearance.theme"
            onChange={(v) => onChange("appearance.theme", v)}
            options={[
              {
                value: "auto",
                label: t("settings.appearance.theme.auto"),
                hint: t("settings.appearance.theme.autoHint"),
              },
              {
                value: "light",
                label: t("settings.appearance.preview.name", { appearance: "light" }),
              },
              {
                value: "dark",
                label: t("settings.appearance.preview.name", { appearance: "dark" }),
              },
            ]}
          />
          <RadioField
            label={t("settings.key.appearance.gray")}
            inline
            value={a.gray}
            settingKey="appearance.gray"
            onChange={(v) => onChange("appearance.gray", v)}
            options={GRAY_FAMILIES.map((g) => ({ value: g, label: grayLabel(g) }))}
          />
          <RadioField
            label={t("settings.key.appearance.density")}
            inline
            value={a.density}
            settingKey="appearance.density"
            onChange={(v) => onChange("appearance.density", v)}
            options={[
              { value: "comfortable", label: t("settings.appearance.density.comfortable") },
              { value: "compact", label: t("settings.appearance.density.compact") },
            ]}
          />
        </Group>

        <Group title={t("settings.appearance.accent")}>
          <AccentPicker
            value={a.accentSeed}
            onChange={(s) => onChange("appearance.accentSeed", s)}
          />
          <div className="grid gap-3 md:grid-cols-2" aria-live="polite">
            <ThemePreview mode={theme.light} />
            <ThemePreview mode={theme.dark} />
          </div>
        </Group>

        <Group title={t("settings.appearance.motionContrast")}>
          <RadioField
            label={t("settings.key.appearance.reduceMotion")}
            inline
            value={motion}
            settingKey="appearance.reduceMotion"
            onChange={(v) =>
              onChange("appearance.reduceMotion", v === "system" ? "system" : v === "on")
            }
            options={[
              { value: "system", label: t("settings.appearance.followSystem") },
              { value: "on", label: t("common.on") },
              { value: "off", label: t("common.off") },
            ]}
          />
          <SwitchField
            label={t("settings.key.appearance.contrast")}
            description={t("settings.appearance.contrastHint")}
            checked={a.contrast === "high"}
            settingKey="appearance.contrast"
            onChange={(v) => onChange("appearance.contrast", v ? "high" : "standard")}
          />
        </Group>

        <Group title={t("settings.appearance.transparency")}>
          {supportsVibrancy ? (
            <SwitchField
              label={t("settings.key.appearance.vibrancy")}
              description={t("settings.appearance.vibrancyHint")}
              checked={values[VIBRANCY_SETTING] === true}
              settingKey={VIBRANCY_SETTING}
              onChange={(v) => onChange(VIBRANCY_SETTING, v)}
            />
          ) : null}
          <SwitchField
            label={t("settings.key.appearance.reduceTransparency")}
            description={t("settings.appearance.reduceTransparencyHint")}
            checked={
              reduceTransparency === true ||
              (reduceTransparency !== false && systemReducesTransparency())
            }
            settingKey={REDUCE_TRANSPARENCY_SETTING}
            onChange={(v) => onChange(REDUCE_TRANSPARENCY_SETTING, v)}
          />
        </Group>

        <LanguageGroup values={values} onChange={onChange} />
      </LoadGate>
    </SectionFrame>
  );
}

export function AppearanceSection(): ReactElement {
  const form = useSettingsForm();
  const supportsVibrancy = useSupportsVibrancy();
  return (
    <div className="flex flex-col gap-3">
      <AppearancePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        supportsVibrancy={supportsVibrancy}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
