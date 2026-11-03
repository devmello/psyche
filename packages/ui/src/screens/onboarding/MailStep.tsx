import { type ReactElement, useId } from "react";
import { t } from "../../i18n/core.ts";
import { GROUP_ROWS, SwitchField } from "../settings/shared.tsx";
import { MAIL_DEFAULTS, mailSettings } from "./mail-settings.ts";
import type { MailChoices } from "./types.ts";

export { MAIL_DEFAULTS, mailSettings };

/**
 * The mail and meetings decision (docs/workflows/mail-and-meetings-2026.md §7.5): a section of
 * the Your stuff step, under the accounts, once a mail account is connected. Each workflow has its own switch and a one-line
 * explanation; nothing runs until the owner continues. Learning the writing style is the one
 * switch that starts off, and says what is read and where it stays. The Mail rule bridge and
 * Psyche's own recording are not offered here.
 */

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
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
      data-testid="onboarding-mail"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-headline text-label-primary">
          {t("onboarding.mail.title", { name: persona })}
        </h2>
        <p className="text-callout text-label-secondary">{t("onboarding.mail.lead")}</p>
      </div>
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
    </section>
  );
}
