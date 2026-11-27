import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { RecoveryKeyReveal } from "../screens/settings/RecoveryKeyPanel.tsx";

/**
 * Home's "Save your recovery key" card, under Needs you until the owner confirms they saved it
 * (typing the key's last group back). The key is read from the Gateway only when the owner taps
 * Show, and is never kept on Home: it is not in the page until then, and goes when hidden.
 * Settings → Privacy & security → Credentials shows it again afterwards.
 */
export function SaveRecoveryKeyCard({
  unlocked,
  onConfirmed,
}: {
  unlocked: boolean;
  onConfirmed: () => void;
}): ReactElement {
  return (
    <section
      data-testid="save-recovery-key"
      aria-label={t("home.recoveryKey.title")}
      className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
    >
      <p className="text-headline text-label-primary">{t("home.recoveryKey.title")}</p>
      <p className="text-callout text-label-secondary">{t("home.recoveryKey.body")}</p>
      <RecoveryKeyReveal unlocked={unlocked} withConfirm onConfirmed={onConfirmed} />
    </section>
  );
}
