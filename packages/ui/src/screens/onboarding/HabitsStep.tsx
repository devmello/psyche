import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { GROUP_ROWS, SwitchField } from "../settings/shared.tsx";
import type { HabitChoices } from "./habits.ts";

/** Turn on habits: the daily brief, the evening wrap-up and follow-up tracking. */
export function HabitsStep({
  value,
  onChange,
}: {
  value: HabitChoices;
  onChange: (next: HabitChoices) => void;
}): ReactElement {
  const set = (key: keyof HabitChoices) => (on: boolean) => onChange({ ...value, [key]: on });
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-habits">
      <p className="text-reading text-label-secondary">{t("onboarding.habits.lead")}</p>
      <div className={GROUP_ROWS}>
        <SwitchField
          label={t("onboarding.habits.brief")}
          description={t("onboarding.habits.briefHint")}
          checked={value.brief}
          onChange={set("brief")}
        />
        <SwitchField
          label={t("onboarding.habits.wrapup")}
          description={t("onboarding.habits.wrapupHint")}
          checked={value.wrapup}
          onChange={set("wrapup")}
        />
        <SwitchField
          label={t("onboarding.habits.followups")}
          description={t("onboarding.habits.followupsHint")}
          checked={value.followups}
          onChange={set("followups")}
        />
      </div>
    </div>
  );
}
