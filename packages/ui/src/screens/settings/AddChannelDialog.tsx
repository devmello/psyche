import type { Channel, MethodParams } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { messageOf } from "./shared.tsx";

/**
 * Guided "Add a channel" (Settings → Channels). Uses the Gateway's own methods, in order:
 * `channels.secrets.set` for each transport token (sent in the request body, straight to the
 * vault, never in a URL and never echoed back), then `channels.configure` to create the channel
 * with the safe default policy (`pairing`: nobody is let in until the owner approves them).
 * Types whose token is not a vault secret (Telegram, iMessage, Signal, email) are set up where
 * the Gateway runs, so they are not offered here.
 */

type SecretName = MethodParams<"channels.secrets.set">["name"];
type AddableType = Extract<Channel["type"], "slack" | "discord" | "sms" | "whatsapp">;

/** Mirrors the Gateway's `CHANNEL_SECRETS`; the Gateway rejects a name a type does not use. */
export const ADDABLE_CHANNELS: Readonly<Record<AddableType, readonly SecretName[]>> = {
  slack: ["bot_token", "app_token"],
  discord: ["bot_token"],
  sms: ["auth_token"],
  whatsapp: ["access_token", "app_secret", "verify_token"],
};

const TYPES = Object.keys(ADDABLE_CHANNELS) as AddableType[];
const TYPE_NAME: Record<AddableType, string> = {
  slack: "Slack",
  discord: "Discord",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export interface AddChannelDialogProps {
  open: boolean;
  persona: string;
  onClose: () => void;
  /** Called once the channel exists, so the list reloads. */
  onAdded: () => void;
}

export function AddChannelDialog({
  open,
  persona,
  onClose,
  onAdded,
}: AddChannelDialogProps): ReactElement {
  const call = useCall();
  const id = useId();
  const [type, setType] = useState<AddableType>("slack");
  const [account, setAccount] = useState("");
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = ADDABLE_CHANNELS[type];
  const complete = account.trim() !== "" && names.every((n) => (secrets[n] ?? "").trim() !== "");

  const reset = () => {
    setAccount("");
    setSecrets({});
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!complete) {
      setError(t("settings.channels.add.missing"));
      return;
    }
    const acct = account.trim();
    setBusy(true);
    setError(null);
    try {
      for (const name of names) {
        await call("channels.secrets.set", {
          type,
          account: acct,
          name,
          value: (secrets[name] ?? "").trim(),
        });
      }
      await call("channels.configure", { type, account: acct, dmPolicy: "pairing" });
      // The tokens are dropped from memory once the Gateway has them.
      close();
      onAdded();
    } catch (err) {
      setError(t("settings.channels.add.failed", { reason: messageOf(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" data-testid="add-channel">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("settings.channels.add.title")}</DialogTitle>
            <DialogDescription>
              {t("settings.channels.add.description", { persona })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-type`} className="font-medium text-foreground">
              {t("settings.channels.add.type")}
            </label>
            <select
              id={`${id}-type`}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={type}
              disabled={busy}
              onChange={(e) => {
                setType(e.target.value as AddableType);
                setSecrets({});
                setError(null);
              }}
            >
              {TYPES.map((k) => (
                <option key={k} value={k}>
                  {TYPE_NAME[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-account`} className="font-medium text-foreground">
              {t(`settings.channels.add.account.${type}`)}
            </label>
            <input
              id={`${id}-account`}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              autoComplete="off"
              spellCheck={false}
              value={account}
              disabled={busy}
              onChange={(e) => setAccount(e.target.value)}
            />
          </div>
          {names.map((name) => (
            <div key={name} className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-${name}`} className="font-medium text-foreground">
                {t(`settings.channels.add.secret.${name}`)}
              </label>
              <input
                id={`${id}-${name}`}
                type="password"
                // Not a login: password managers must not offer to fill or save it.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                spellCheck={false}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                value={secrets[name] ?? ""}
                disabled={busy}
                onChange={(e) => setSecrets((s) => ({ ...s, [name]: e.target.value }))}
              />
            </div>
          ))}
          <p className="text-callout text-muted-foreground">
            {t("settings.channels.add.otherTypes")}
          </p>
          {error !== null ? (
            <p role="alert" className="text-callout text-danger-text">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !complete}>
              {busy ? t("settings.channels.add.connecting") : t("settings.channels.add.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
