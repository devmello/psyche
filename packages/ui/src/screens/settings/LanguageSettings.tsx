import { type ReactElement, useId } from "react";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import {
  canonicalLocale,
  DIRECTION_SETTING,
  LOCALE_SETTING,
  localeName,
  OFFERED_LOCALES,
  runtimeLocale,
} from "../../i18n/locale.ts";
import { useSystemLocale } from "../../shell/AppearanceProvider.tsx";
import { Group, RadioField, SettingHint, type SettingsValues, str } from "./shared.tsx";

/** A fixed moment for the example line (10:30 on 2 March 2026, UTC). */
const EXAMPLE_DATE = Date.UTC(2026, 2, 2, 10, 30);

/**
 * Language and region (A12): the format locale (`ui.locale`: "system" or a BCP 47 tag) and the
 * text direction (`ui.direction`). Text stays English until a catalogue for the language ships.
 */
export function LanguageGroup({
  values,
  onChange,
}: {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  const id = useId();
  const i18n = activeI18n();
  const system = canonicalLocale(useSystemLocale()) ?? runtimeLocale();
  const chosen = str(values, LOCALE_SETTING, "system");
  const current = chosen === "system" ? "system" : (canonicalLocale(chosen) ?? "system");
  const offered: string[] = [...OFFERED_LOCALES];
  if (current !== "system" && !offered.includes(current)) offered.unshift(current);
  const direction = str(values, DIRECTION_SETTING, "auto");
  return (
    <Group title={t("settings.language.title")} description={t("settings.language.description")}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-region`} className="font-medium text-foreground">
          {t("settings.language.region")}
        </label>
        <NativeSelect
          id={`${id}-region`}
          className="min-w-64"
          value={current}
          aria-describedby={`${id}-example`}
          onChange={(e) => onChange(LOCALE_SETTING, e.target.value)}
        >
          <option value="system">
            {t("settings.language.system", { name: localeName(system, i18n.messageLocale) })}
          </option>
          {offered.map((tag) => (
            <option key={tag} value={tag}>
              {localeName(tag, i18n.messageLocale)}
            </option>
          ))}
        </NativeSelect>
        <p id={`${id}-example`} className="text-xs text-muted-foreground">
          {t("settings.language.example", {
            date: i18n.date(EXAMPLE_DATE, { dateStyle: "long", timeZone: "UTC" }),
            time: i18n.time(EXAMPLE_DATE, { timeStyle: "short", timeZone: "UTC" }),
            number: i18n.number(1234567.89),
          })}
        </p>
        <SettingHint settingKey={LOCALE_SETTING} />
      </div>
      <RadioField
        label={t("settings.language.direction")}
        description={t("settings.language.directionHint")}
        inline
        value={direction === "ltr" || direction === "rtl" ? direction : "auto"}
        settingKey={DIRECTION_SETTING}
        onChange={(v) => onChange(DIRECTION_SETTING, v)}
        options={[
          { value: "auto", label: t("settings.language.direction.auto") },
          { value: "ltr", label: t("settings.language.direction.ltr") },
          { value: "rtl", label: t("settings.language.direction.rtl") },
        ]}
      />
    </Group>
  );
}
