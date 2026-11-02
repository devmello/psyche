import type { NudgeSensitivity } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { t } from "../i18n/core.ts";
import { Group, RadioField, SwitchField } from "../screens/settings/shared.tsx";

export const NUDGES_ENABLED = "nudges.enabled";
export const NUDGES_CONSENTED_AT = "nudges.consentedAt";
export const NUDGES_SENSITIVITY = "nudges.sensitivity";

const SENSITIVITIES: readonly NudgeSensitivity[] = ["low", "normal", "high"];

/** The stored values, read the way the Gateway reads them: off until switch and consent exist. */
export function readNudgeSettings(values: Readonly<Record<string, unknown>>): {
  enabled: boolean;
  sensitivity: NudgeSensitivity;
} {
  const sens = values[NUDGES_SENSITIVITY];
  return {
    enabled: values[NUDGES_ENABLED] === true && typeof values[NUDGES_CONSENTED_AT] === "string",
    sensitivity: sens === "low" || sens === "high" || sens === "normal" ? sens : "normal",
  };
}

export interface RelationshipNudgesSettingsProps {
  enabled: boolean;
  sensitivity: NudgeSensitivity;
  /** Writes one `nudges.*` setting. */
  onChange: (key: string, value: unknown) => void;
  /** The consent date to store when the owner confirms; tests pass a fixed one. */
  now?: () => string;
}

/**
 * Settings → People → Relationship nudges. Off for everyone; turning it on first shows what it
 * does and what it never does, and stores the date of the answer. Cadence sensitivity applies
 * at once. Quiet hours are the general ones in Settings → Notifications.
 */
export function RelationshipNudgesSettings({
  enabled,
  sensitivity,
  onChange,
  now = () => new Date().toISOString(),
}: RelationshipNudgesSettingsProps): ReactElement {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Group title={t("nudges.settings.title")} description={t("nudges.settings.description")}>
        <SwitchField
          label={t("nudges.settings.enabled")}
          description={t("nudges.settings.enabledHint")}
          checked={enabled}
          settingKey={NUDGES_ENABLED}
          onChange={(on) => {
            if (on) setAsking(true);
            else onChange(NUDGES_ENABLED, false);
          }}
        />
        <RadioField
          label={t("nudges.settings.sensitivity")}
          description={t("nudges.settings.sensitivityHint")}
          inline
          value={sensitivity}
          onChange={(v) => onChange(NUDGES_SENSITIVITY, v)}
          options={SENSITIVITIES.map((s) => ({ value: s, label: t(`nudges.settings.${s}`) }))}
        />
        <p className="px-1 text-callout text-label-secondary">{t("nudges.settings.quietHours")}</p>
      </Group>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("nudges.consent.title")}</DialogTitle>
            <DialogDescription>{t("nudges.consent.body")}</DialogDescription>
          </DialogHeader>
          <p className="text-callout text-label-secondary">{t("nudges.consent.rules")}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              {t("nudges.consent.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onChange(NUDGES_CONSENTED_AT, now());
                onChange(NUDGES_ENABLED, true);
                setAsking(false);
              }}
            >
              {t("nudges.consent.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
