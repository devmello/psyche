import type { VaultStatus } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { RecoveryKeyCard } from "../onboarding/OnboardingSteps.tsx";
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
        <ConfirmForm
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
      <ConfirmForm expectUnlocked={status.state === "unlocked"} onConfirmed={onChanged} />
    </div>
  );
}

/** The last group of the key, typed back; the Gateway compares it and answers with status only. */
function ConfirmForm({
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
