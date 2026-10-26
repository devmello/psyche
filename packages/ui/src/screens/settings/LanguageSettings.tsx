import { type ReactElement, useId } from "react";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import {
  canonicalLocale,
  DIRECTION_SETTING,
  LANGUAGE_SETTING,
  LOCALE_SETTING,
  localeName,
  MESSAGE_LOCALES,
  OFFERED_LOCALES,
  resolveMessageLocale,
  runtimeLocale,
} from "../../i18n/locale.ts";
import { useSystemLocale } from "../../shell/AppearanceProvider.tsx";
import { Group, RadioField, SettingHint, type SettingsValues, str } from "./shared.tsx";

/** A fixed moment for the preview line (14:05 on Tuesday 27 October 2026, UTC). */
const PREVIEW_AT = Date.UTC(2026, 9, 27, 14, 5);

/** The `ui.language` value a select shows: a shipped language, else "system". */
export function languageChoice(setting: unknown): string {
  return typeof setting === "string" && (MESSAGE_LOCALES as readonly string[]).includes(setting)
    ? setting
    : "system";
}

/**
 * The language select (A12, #621), shared by onboarding's first step and Settings: "Match system"
 * (the best catalogue for the region) and every shipped language by its native name, labelled in
 * the current language. The text changes as soon as the setting is written (AppearanceProvider
 * remounts the app).
 */
export function LanguageSelect({
  id,
  value,
  onChange,
  describedBy,
  className,
}: {
  id: string;
  value: unknown;
  onChange: (language: string) => void;
  describedBy?: string;
  className?: string;
}): ReactElement {
  const i18n = activeI18n();
  const system = resolveMessageLocale("system", i18n.locale);
  return (
    <NativeSelect
      id={id}
      className={className}
      value={languageChoice(value)}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="system">
        {t("settings.language.languageSystem", { name: localeName(system, system) })}
      </option>
      {MESSAGE_LOCALES.map((lang) => (
        <option key={lang} value={lang} lang={lang}>
          {localeName(lang, lang)}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * Language and region (A12, #608, #621): the text's language (`ui.language`), the format locale (`ui.locale`: "system" or a BCP 47 tag) and
 * the text direction (`ui.direction`). AppearanceProvider resolves them and remounts the app, so
 * a change shows at once. Only languages with a catalogue are listed.
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
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor={`${id}-language`}>{t("settings.language.language")}</label>
          <LanguageSelect
            id={`${id}-language`}
            className="min-w-56"
            value={values[LANGUAGE_SETTING]}
            describedBy={`${id}-language-hint`}
            onChange={(v) => onChange(LANGUAGE_SETTING, v)}
          />
        </div>
        <p id={`${id}-language-hint`} className="text-callout text-label-secondary">
          {t("settings.language.languageHint")}
        </p>
        <SettingHint settingKey={LANGUAGE_SETTING} />
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
