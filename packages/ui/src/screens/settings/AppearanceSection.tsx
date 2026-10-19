import { Check, X } from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.tsx";
import { cn } from "../../lib/utils.ts";
import {
  DEFAULT_ACCENT_SEED,
  GRAY_FAMILIES,
  type GrayFamily,
  generateTheme,
  isValidSeed,
  type ModeTheme,
} from "../../theme/generate.ts";
import { appearanceFromSettings } from "../../theme/ThemeProvider.tsx";
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

export const ACCENT_PRESETS: readonly { name: string; seed: string }[] = [
  { name: "Violet", seed: DEFAULT_ACCENT_SEED },
  { name: "Blue", seed: "oklch(0.6 0.19 255)" },
  { name: "Teal", seed: "oklch(0.62 0.12 185)" },
  { name: "Green", seed: "oklch(0.63 0.15 145)" },
  { name: "Amber", seed: "oklch(0.8 0.16 80)" },
  { name: "Tomato", seed: "oklch(0.62 0.2 35)" },
  { name: "Pink", seed: "oklch(0.62 0.2 350)" },
];

const GRAY_LABEL: Record<GrayFamily, string> = {
  auto: "Auto (matches the accent)",
  neutral: "Neutral",
  slate: "Slate",
  mauve: "Mauve",
  sage: "Sage",
  olive: "Olive",
  sand: "Sand",
};

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
          <span className="sr-only">Step {step}</span>
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
        {label}: <span className="tabular-nums">{value.toFixed(2)}:1</span>{" "}
        <span className="text-muted-foreground">
          ({ok ? "passes" : "fails"} {min}:1)
        </span>
      </span>
    </li>
  );
}

/** Live preview of one appearance: both 12-step scales, the WCAG gate and any nudges. */
export function ThemePreview({ mode }: { mode: ModeTheme }): ReactElement {
  const name = mode.appearance === "light" ? "Light" : "Dark";
  const r = mode.report;
  return (
    <figure className="flex flex-col gap-2 rounded-md border border-gray-6 bg-background p-3">
      <figcaption className="font-medium">{name}</figcaption>
      <Scale label={`${name} accent scale`} colors={mode.accent.solid} />
      <Scale label={`${name} gray scale`} colors={mode.gray.solid} />
      <div
        className="inline-flex w-fit items-center rounded-md px-3 py-1 text-sm font-medium"
        style={{ backgroundColor: mode.accent.solid[8], color: mode.accentContrast }}
      >
        Button on step 9
      </div>
      <ul className="flex flex-col gap-0.5 text-xs" aria-label={`${name} contrast (WCAG 2)`}>
        <Ratio label="Accent 11 on 2" value={r.accent11On2} min={4.5} />
        <Ratio label="Accent 12 on 2" value={r.accent12On2} min={7} />
        <Ratio label="Text on accent 9" value={r.contrastOn9} min={4.5} />
        <Ratio label="Gray 11 on 2" value={r.gray11On2} min={4.5} />
        <Ratio label="Gray 12 on 2" value={r.gray12On2} min={7} />
      </ul>
      {mode.nudged.length > 0 ? (
        <div className="text-xs">
          <p className="font-medium text-approval-text">Psyche adjusted this seed to pass:</p>
          <ul className="list-disc pl-4 text-muted-foreground">
            {mode.nudged.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No adjustments needed.</p>
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
        Accent color
      </span>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={preset ? preset.seed : ""}
        onValueChange={(v) => onChange(String(v))}
        className="flex flex-wrap gap-3"
      >
        {ACCENT_PRESETS.map((p) => (
          <Label key={p.name} htmlFor={`${id}-${p.name}`} className="flex-col gap-1 font-normal">
            <span
              className={cn(
                "size-7 rounded-full border border-gray-a4",
                preset?.name === p.name && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ backgroundColor: p.seed }}
              aria-hidden="true"
            />
            <span className="flex items-center gap-1 text-xs">
              <RadioGroupItem value={p.seed} id={`${id}-${p.name}`} />
              {p.name}
            </span>
          </Label>
        ))}
      </RadioGroup>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-seed`}>Custom color</Label>
        <Input
          id={`${id}-seed`}
          className="max-w-xs font-mono"
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
          {invalid
            ? "Psyche can't read that color. Try a CSS color such as oklch(0.6 0.15 250)."
            : "Any CSS color. It lands on step 9; Psyche adjusts it if the text would be hard to read."}
        </p>
      </div>
    </div>
  );
}

export function AppearancePanel({
  values,
  onChange,
  needsApproval,
  loading,
  error,
  onRetry,
}: SettingsFormProps & LoadProps): ReactElement {
  const a = appearanceFromSettings(values);
  const theme = useMemo(
    () => generateTheme({ accentSeed: a.accentSeed, gray: a.gray }),
    [a.accentSeed, a.gray],
  );
  const motion = a.reduceMotion === "system" ? "system" : a.reduceMotion ? "on" : "off";
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Appearance"
      description="Applies to every paired device. Approval, danger and success colors never follow the accent."
    >
      <LoadGate
        label="appearance"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Theme">
          <RadioField
            label="Theme"
            hideLabel
            inline
            value={a.theme}
            settingKey="appearance.theme"
            onChange={(v) => onChange("appearance.theme", v)}
            options={[
              { value: "auto", label: "Auto", hint: "Follows the system" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
          <RadioField
            label="Gray family"
            inline
            value={a.gray}
            settingKey="appearance.gray"
            onChange={(v) => onChange("appearance.gray", v)}
            options={GRAY_FAMILIES.map((g) => ({ value: g, label: GRAY_LABEL[g] }))}
          />
          <RadioField
            label="Density"
            inline
            value={a.density}
            settingKey="appearance.density"
            onChange={(v) => onChange("appearance.density", v)}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </Group>

        <Group title="Accent">
          <AccentPicker
            value={a.accentSeed}
            onChange={(s) => onChange("appearance.accentSeed", s)}
          />
          <div className="grid gap-3 md:grid-cols-2" aria-live="polite">
            <ThemePreview mode={theme.light} />
            <ThemePreview mode={theme.dark} />
          </div>
        </Group>

        <Group title="Motion and contrast">
          <RadioField
            label="Reduce motion"
            inline
            value={motion}
            settingKey="appearance.reduceMotion"
            onChange={(v) =>
              onChange("appearance.reduceMotion", v === "system" ? "system" : v === "on")
            }
            options={[
              { value: "system", label: "Follow the system" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
          <SwitchField
            label="High contrast"
            description="Stronger borders, darker text and 2 px focus rings."
            checked={a.contrast === "high"}
            settingKey="appearance.contrast"
            onChange={(v) => onChange("appearance.contrast", v ? "high" : "standard")}
          />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export function AppearanceSection(): ReactElement {
  const form = useSettingsForm();
  return (
    <div className="flex flex-col gap-3">
      <AppearancePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
