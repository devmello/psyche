import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Shared by Settings → Credentials and onboarding's model step. The owner types the key's last
 * group back; the Gateway (`vault.confirmRecovery`) compares it with a sealed hash and answers
 * with status only. A wrong group shows the same error everywhere and clears the field.
 */
export function ConfirmRecoveryForm({
  expectUnlocked,
  onConfirmed,
}: {
  expectUnlocked: boolean;
  onConfirmed: () => void;
}): ReactElement {
  const id = useId();
  const call = useCall();
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const typed = group.trim();
    if (typed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A locked vault must be open to compare; this is the unlock onboarding makes too.
      if (!expectUnlocked) {
        await call("vault.unlock", { reason: t("settings.credentials.vault.unlockReason") });
      }
      await call("vault.confirmRecovery", { lastGroup: typed });
      setGroup("");
      onConfirmed();
    } catch (err) {
      setGroup("");
      setError(
        hasCode(err, "invalid_params")
          ? t("settings.credentials.vault.confirm.wrong")
          : hasCode(err, "forbidden")
            ? t("settings.credentials.vault.adminOnly")
            : t("settings.credentials.vault.confirm.failed", { reason: messageOf(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
      <p className="font-medium">{t("settings.credentials.vault.confirm.title")}</p>
      <p className="text-callout text-muted-foreground">
        {t("settings.credentials.vault.confirm.body")}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-group`}>{t("settings.credentials.vault.confirm.label")}</Label>
          <Input
            id={`${id}-group`}
            value={group}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            onChange={(e) => setGroup(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy || group.trim() === ""}>
          {t("settings.credentials.vault.confirm.button")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </form>
  );
}
