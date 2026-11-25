import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { Group, SwitchField } from "../screens/settings/shared.tsx";
import { PointsDataLine } from "./PointsDataLine.tsx";

export const POINTS_ENABLED_KEY = "points.enabled";

/**
 * Settings → Computer use → Psyche points: the on or off switch (off until the owner's pass) and
 * the data line. The permission rows it needs are the ones already on that page. Mac Host only;
 * the page hides it elsewhere.
 */
export function PointsSettingsGroup({
  enabled,
  onChange,
  provider,
  local,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  provider?: string;
  local?: boolean;
}): ReactElement {
  return (
    <Group title={t("points.settings.title")} description={t("points.settings.description")}>
      <SwitchField
        label={t("settings.key.points.enabled")}
        description={t("points.settings.enabledHint")}
        checked={enabled}
        settingKey={POINTS_ENABLED_KEY}
        onChange={onChange}
      />
      <PointsDataLine
        {...(provider === undefined ? {} : { provider })}
        {...(local ? { local } : {})}
      />
    </Group>
  );
}
