import { Check } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useCopy } from "../../lib/clipboard.ts";
import { ConfirmRecoveryForm } from "./ConfirmRecoveryForm.tsx";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * The vault's recovery key, with Copy. Shown right after `vault.setup` (Settings → Credentials),
 * and later through `RecoveryKeyReveal`. It stays on screen until the owner confirms it by typing
 * its last group back (`ConfirmRecoveryForm`).
 */
export function RecoveryKeyCard({ recoveryKey }: { recoveryKey: string }): ReactElement {
  const clip = useCopy();
  return (
    <div
      className="mt-2 flex flex-col gap-1 rounded-lg border border-approval-border bg-approval-surface p-3"
      data-testid="vault-recovery-key"
    >
      <p className="text-headline text-label-primary">{t("onboarding.model.recoveryTitle")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm break-all select-all">{recoveryKey}</code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void clip.copy(recoveryKey)}
        >
          {clip.state === "copied" ? <Check aria-hidden="true" /> : null}
          {clip.state === "copied" ? t("onboarding.model.copied") : t("onboarding.model.copy")}
        </Button>
        <span role="status" className="sr-only">
          {clip.state === "copied" ? t("onboarding.model.copiedStatus") : ""}
        </span>
        {clip.state === "failed" ? (
          <span className="text-callout text-danger-text" role="alert">
            {t("onboarding.model.copyFailed")}
          </span>
        ) : null}
      </div>
      <p className="text-callout text-label-secondary">{t("onboarding.model.recoveryBody")}</p>
    </div>
  );
}

/**
 * "Show recovery key": reads the key from the Gateway (`vault.recoveryKey`, admin only; the
 * Gateway keeps it sealed under the vault key and opens it only while the vault is unlocked), so
 * the owner can save it after setup. A plain tap: no Touch ID or password is asked. A locked
 * vault is unlocked first, the same call the confirm form makes. The key lives in this
 * component's state only, and goes when the owner hides it or leaves.
 *
 * `withConfirm` adds the confirm form under the key (Home's card); Settings has its own.
 */
export function RecoveryKeyReveal({
  unlocked,
  withConfirm = false,
  onConfirmed,
}: {
  unlocked: boolean;
  withConfirm?: boolean;
  onConfirmed?: () => void;
}): ReactElement {
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setGone(false);
    try {
      if (!unlocked) {
        await call("vault.unlock", { reason: t("settings.credentials.vault.unlockReason") });
      }
      const res = await call("vault.recoveryKey", {});
      if (res.recoveryKey === null) setGone(true);
      else setKey(res.recoveryKey);
    } catch (err) {
      setError(
        hasCode(err, "forbidden")
          ? t("settings.credentials.vault.adminOnly")
          : t("settings.credentials.vault.recoveryKey.failed", { reason: messageOf(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (key !== null) {
    return (
      <div className="flex flex-col gap-2" data-testid="vault-recovery-reveal">
        <RecoveryKeyCard recoveryKey={key} />
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setKey(null)}>
            {t("settings.credentials.vault.recoveryKey.hide")}
          </Button>
        </div>
        {withConfirm ? (
          <ConfirmRecoveryForm
            expectUnlocked
            onConfirmed={() => {
              setKey(null);
              onConfirmed?.();
            }}
          />
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="vault-recovery-reveal">
      <div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void show()}>
          {t("settings.credentials.vault.recoveryKey.show")}
        </Button>
      </div>
      {gone ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("settings.credentials.vault.recoveryKey.gone")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
