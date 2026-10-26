import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import {
  GLASS_BLUR_SETTING,
  GLASS_PRESET_SETTING,
  GLASS_REFRACTION_SETTING,
  GLASS_TINT_SETTING,
  glassPreset,
} from "../../lib/glass-settings.ts";
import { SwitchField } from "./shared.tsx";

/**
 * Settings → Appearance → Translucency (#608): one switch, "Translucent controls". Glass is left
 * only on the composer, the toolbar control groups, popovers, menus and the palette (native
 * sidebar vibrancy went in #602), so on is the Regular preset and off is Opaque. Turning it on
 * clears any Advanced values an earlier build stored (null falls back to the preset's).
 */
export function GlassSwitch({
  values,
  onChange,
}: {
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}): ReactElement {
  return (
    <SwitchField
      label={t("settings.key.appearance.glass")}
      description={t("settings.appearance.glass.hint")}
      checked={glassPreset(values) !== "opaque"}
      settingKey={GLASS_PRESET_SETTING}
      onChange={(on) => {
        onChange(GLASS_PRESET_SETTING, on ? "regular" : "opaque");
        if (!on) return;
        for (const key of [GLASS_TINT_SETTING, GLASS_BLUR_SETTING, GLASS_REFRACTION_SETTING]) {
          if (values[key] !== undefined && values[key] !== null) onChange(key, null);
        }
      }}
    />
  );
}
