import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { Check } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup } from "../../components/ui/radio-group.tsx";
import { t } from "../../i18n/core.ts";
import { LINK_OPEN_SETTING, type LinkOpenMode, linkOpenMode } from "../../links/link-policy.ts";
import { DEFAULT_ACCENT_SEED, GRAY_FAMILIES, type GrayFamily } from "../../theme/generate.ts";
import { appearanceFromSettings } from "../../theme/ThemeProvider.tsx";
import { DirectionField, LanguageGroup } from "./LanguageSettings.tsx";
import {
  Advanced,
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
import { GlassSwitch } from "./TranslucencySettings.tsx";

/** Appearance (UI design §3.18, color system §4.8, theming API §4.10). */

/** Read by the desktop app's main process (`apps/desktop/src/main/dock-policy.ts`). */
const SHOW_IN_DOCK_SETTING = "appearance.showInDock";
const OPEN_AT_LOGIN_SETTING = "appearance.openAtLogin";

type AccentId = "ink" | "teal" | "green" | "mauve";

const accent = (id: AccentId, seed: string) => ({
  id,
  seed,
  /** The swatch's name, in the active language. */
  get name(): string {
    return id === "mauve"
      ? t("simplify.b8.appearance.accent.mauve")
      : t(`settings.appearance.accent.${id}`);
  },
});

/**
 * Ink plus three calm alternatives. Amber is not on the list: it means "needs you".
 * A saved accent that is not one of these (violet, blue, tomato, a custom colour) still
 * renders as saved; the picker just shows no swatch selected until the owner picks one.
 */
export const ACCENT_PRESETS: readonly { id: AccentId; readonly name: string; seed: string }[] = [
  accent("ink", DEFAULT_ACCENT_SEED),
  accent("teal", "oklch(0.62 0.12 185)"),
  accent("green", "oklch(0.63 0.15 145)"),
  accent("mauve", "oklch(0.58 0.11 350)"),
];

const grayLabel = (g: GrayFamily): string => t(`settings.appearance.gray.${g}`);

function AccentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (seed: string) => void;
}): ReactElement {
  const id = useId();
  const preset = ACCENT_PRESETS.find((p) => p.seed === value);
  return (
    <div className="flex flex-col gap-3">
      <span id={`${id}-label`} className="text-body text-label-primary">
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
            className="flex-col gap-1.5 text-callout font-normal text-label-secondary"
          >
            <RadioPrimitive.Root
              value={p.seed}
              id={`${id}-${p.id}`}
              className="flex size-8 items-center justify-center rounded-full border border-gray-a4 text-white outline-none focus-visible:ring-3 focus-visible:ring-ring data-checked:ring-2 data-checked:ring-gray-12 data-checked:ring-offset-2 data-checked:ring-offset-background"
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
  const motion = a.reduceMotion === "system" ? "system" : a.reduceMotion ? "on" : "off";
  return (
    <SectionFrame needsApproval={needsApproval} title={t("settings.appearance.title")}>
      <LoadGate
        label={t("settings.appearance.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.appearance.colors")}>
          <RadioField
            label={t("settings.key.appearance.theme")}
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
          <AccentPicker
            value={a.accentSeed}
            onChange={(s) => onChange("appearance.accentSeed", s)}
          />
        </Group>

        {/* Reduce motion, contrast and translucency, one row away (Search opens it). */}
        <Advanced title={t("settings.drill.accessibility")}>
          <Group title={t("settings.appearance.comfort")}>
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
            <GlassSwitch values={values} onChange={onChange} />
          </Group>
        </Advanced>

        <Group title={t("settings.appearance.background")}>
          <SwitchField
            label={t("settings.key.appearance.showInDock")}
            description={t("settings.appearance.showInDockHint")}
            checked={values[SHOW_IN_DOCK_SETTING] === true}
            settingKey={SHOW_IN_DOCK_SETTING}
            onChange={(v) => onChange(SHOW_IN_DOCK_SETTING, v)}
          />
          <SwitchField
            label={t("settings.key.appearance.openAtLogin")}
            description={t("settings.appearance.openAtLoginHint")}
            checked={values[OPEN_AT_LOGIN_SETTING] === true}
            settingKey={OPEN_AT_LOGIN_SETTING}
            onChange={(v) => onChange(OPEN_AT_LOGIN_SETTING, v)}
          />
        </Group>

        <Group title={t("settings.links.title")} description={t("settings.links.description")}>
          <RadioField<LinkOpenMode>
            label={t("settings.key.ui.links.openIn")}
            settingKey={LINK_OPEN_SETTING}
            value={linkOpenMode(values[LINK_OPEN_SETTING])}
            onChange={(v) => onChange(LINK_OPEN_SETTING, v)}
            options={[
              { value: "ask", label: t("settings.links.openIn.ask") },
              { value: "psyche", label: t("settings.links.openIn.psyche") },
              { value: "browser", label: t("settings.links.openIn.browser") },
            ]}
          />
        </Group>

        <LanguageGroup values={values} onChange={onChange} />

        <Advanced description={t("simplify.b8.appearance.advancedHint")}>
          <RadioField
            label={t("settings.key.appearance.gray")}
            inline
            value={a.gray}
            settingKey="appearance.gray"
            onChange={(v) => onChange("appearance.gray", v)}
            options={GRAY_FAMILIES.map((g) => ({ value: g, label: grayLabel(g) }))}
          />
          <DirectionField values={values} onChange={onChange} />
        </Advanced>
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
