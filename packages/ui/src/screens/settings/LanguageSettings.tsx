import { type ReactElement, useId } from "react";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import {
  canonicalLocale,
  DIRECTION_SETTING,
  LOCALE_SETTING,
  localeName,
  MESSAGE_LOCALES,
  OFFERED_LOCALES,
  runtimeLocale,
} from "../../i18n/locale.ts";
import { useSystemLocale } from "../../shell/AppearanceProvider.tsx";
import { Group, RadioField, SettingHint, type SettingsValues, str } from "./shared.tsx";

/** A fixed moment for the preview line (14:05 on Tuesday 27 October 2026, UTC). */
const PREVIEW_AT = Date.UTC(2026, 9, 27, 14, 5);

/**
 * Language and region (A12, #608): the format locale (`ui.locale`: "system" or a BCP 47 tag) and
 * the text direction (`ui.direction`). AppearanceProvider resolves both and remounts the app, so a
 * change shows at once, starting with the preview line under the Region field. Only languages with
 * a catalogue are listed (English today); the region does not change the text.
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
  const languages = i18n.list(MESSAGE_LOCALES.map((l) => localeName(l, i18n.messageLocale)));
  return (
    <Group title={t("settings.language.title")} description={t("settings.language.description")}>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-3">
          <span>{t("settings.language.language")}</span>
          <span className="text-label-secondary">{languages}</span>
        </div>
        <p className="text-callout text-label-secondary">
          {t("settings.language.languageHint", { languages })}
        </p>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor={`${id}-region`}>{t("settings.language.region")}</label>
          <NativeSelect
            id={`${id}-region`}
            className="min-w-56"
            value={current}
            aria-describedby={`${id}-preview`}
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
        </div>
        <p
          id={`${id}-preview`}
          aria-live="polite"
          className="text-callout text-label-secondary tabular-nums"
        >
          {t("settings.language.preview", {
            date: i18n.date(PREVIEW_AT, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            }),
            time: i18n.time(PREVIEW_AT, { timeStyle: "short", timeZone: "UTC" }),
            number: i18n.number(1234.5),
            amount: i18n.number(4.2, { style: "currency", currency: "USD" }),
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
