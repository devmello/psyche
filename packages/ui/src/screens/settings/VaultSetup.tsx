import type { VaultStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { RecoveryKeyCard } from "../onboarding/OnboardingSteps.tsx";
import { ConfirmRecoveryForm } from "./ConfirmRecoveryForm.tsx";
import { hasCode, messageOf } from "./shared.tsx";

/**
 * Settings → Credentials: set the vault up when there is none, and confirm the recovery key later
 * when the vault exists but the owner never did. Both reuse onboarding's calls and recovery card:
 * the Gateway has exactly one key slot (another answers `invalid_params` with no side effects),
 * the key is shown once, and the check runs on the Gateway (`vault.confirmRecovery`). Neither step
 * asks for Touch ID or a password: unlocking a locked vault is the same call onboarding makes.
 */

const SLOTS = ["key_file", "keychain", "safe_storage"] as const;

export function VaultSetupPanel({
  status,
  onChanged,
}: {
  status: VaultStatus;
  onChanged: () => void;
}): ReactElement | null {
  // Held in memory only, until the owner confirms it or leaves the page. It lives here, above
  // the status, so a status refresh right after setup cannot drop the only copy of the key.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  if (recoveryKey !== null) {
    return (
      <div
        className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
        data-testid="vault-setup"
      >
        <RecoveryKeyCard recoveryKey={recoveryKey} />
        <ConfirmRecoveryForm
          expectUnlocked
          onConfirmed={() => {
            setRecoveryKey(null);
            onChanged();
          }}
        />
      </div>
    );
  }
  if (status.state === "uninitialized") {
    return (
      <SetupVault
        onCreated={(key) => {
          setRecoveryKey(key);
          onChanged();
        }}
      />
    );
  }
  if (!status.recoveryConfirmed) return <ConfirmRecovery status={status} onChanged={onChanged} />;
  return null;
}

function SetupVault({ onCreated }: { onCreated: (recoveryKey: string) => void }): ReactElement {
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setup = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      for (const slot of SLOTS) {
        try {
          const res = await call("vault.setup", { slot });
          onCreated(res.recoveryKey);
          return;
        } catch (err) {
          if (!hasCode(err, "invalid_params")) throw err;
        }
      }
      throw new Error(t("settings.credentials.vault.setup.noSlot"));
    } catch (err) {
      setError(
        hasCode(err, "forbidden")
          ? t("settings.credentials.vault.adminOnly")
          : t("settings.credentials.vault.setup.failed", { reason: messageOf(err) }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
      data-testid="vault-setup"
    >
      <p className="font-medium">{t("settings.credentials.vault.setup.title")}</p>
      <p className="text-callout text-muted-foreground">
        {t("settings.credentials.vault.setup.body")}
      </p>
      <div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void setup()}>
          {t("settings.credentials.vault.setup.button")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ConfirmRecovery({
  status,
  onChanged,
}: {
  status: VaultStatus;
  onChanged: () => void;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
      data-testid="vault-confirm-recovery"
    >
      <ConfirmRecoveryForm expectUnlocked={status.state === "unlocked"} onConfirmed={onChanged} />
    </div>
  );
}
