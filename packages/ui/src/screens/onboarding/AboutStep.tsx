import type { ReactElement } from "react";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import type { OwnerProfile } from "./types.ts";

const FIELDS = ["name", "timeZone", "work", "city"] as const;

/** Welcome: a few facts for USER.md. Every field is optional; Skip leaves them empty. */
export function AboutStep({
  value,
  onChange,
}: {
  value: OwnerProfile;
  onChange: (next: OwnerProfile) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-about">
      <p className="text-reading text-label-secondary">{t("onboarding.about.lead")}</p>
      {FIELDS.map((key) => (
        <div key={key} className="flex flex-col gap-1.5">
          <Label htmlFor={`onboarding-about-${key}`}>{tk(`onboarding.about.${key}`)}</Label>
          <Input
            id={`onboarding-about-${key}`}
            value={value[key]}
            placeholder={tk(`onboarding.about.${key}Hint`)}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}
