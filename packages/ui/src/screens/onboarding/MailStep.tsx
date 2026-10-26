import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { GROUP_ROWS, SwitchField } from "../settings/shared.tsx";
import type { MailChoices } from "./types.ts";

/**
 * The mail and meetings decision screen (docs/workflows/mail-and-meetings-2026.md §7.5): after
 * Connectors, when a mail account is connected. Each workflow has its own switch and a one-line
 * explanation; nothing runs until the owner continues. Learning the writing style is the one
 * switch that starts off, and says what is read and where it stays. The Mail rule bridge and
 * Psyche's own recording are not offered here.
 */

/** What the screen starts with (§7.5). */
export const MAIL_DEFAULTS: MailChoices = {
  digest: true,
  prep: true,
  followups: true,
  voice: false,
  notes: true,
};

/** The Gateway settings a set of choices writes (one switch each; the digest at 7:30). */
export function mailSettings(choices: MailChoices): Record<string, boolean | string> {
  return {
    "mail.digest.enabled": choices.digest,
    ...(choices.digest ? { "mail.digest.time": "07:30" } : {}),
    "meetings.prep.enabled": choices.prep,
    "mail.followups.enabled": choices.followups,
    "mail.voice.enabled": choices.voice,
    "meetings.notes.enabled": choices.notes,
  };
}

export function MailStep({
  persona,
  value,
  onChange,
}: {
  persona: string;
  value: MailChoices;
  onChange: (next: MailChoices) => void;
}): ReactElement {
  const set = (key: keyof MailChoices) => (on: boolean) => onChange({ ...value, [key]: on });
  const on = Object.values(value).filter(Boolean).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-reading text-label-secondary">
        {t("onboarding.mail.title", { name: persona })}. {t("onboarding.mail.lead")}
      </p>
      <div className={GROUP_ROWS}>
        <SwitchField
          label={t("onboarding.mail.digest")}
          description={t("onboarding.mail.digestHint")}
          checked={value.digest}
          onChange={set("digest")}
        />
        <SwitchField
          label={t("onboarding.mail.prep")}
          description={t("onboarding.mail.prepHint")}
          checked={value.prep}
          onChange={set("prep")}
        />
        <SwitchField
          label={t("onboarding.mail.followups")}
          description={t("onboarding.mail.followupsHint")}
          checked={value.followups}
          onChange={set("followups")}
        />
        <SwitchField
          label={t("onboarding.mail.voice")}
          description={t("onboarding.mail.voiceHint")}
          checked={value.voice}
          onChange={set("voice")}
        />
        <SwitchField
          label={t("onboarding.mail.notes")}
          description={t("onboarding.mail.notesHint")}
          checked={value.notes}
          onChange={set("notes")}
        />
      </div>
      <p className="px-1 text-callout text-label-secondary">
        {t("onboarding.mail.summary", { n: on })}
      </p>
    </div>
  );
}
