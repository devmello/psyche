import type { Channel, MethodParams } from "@psyche/protocol";
import { type FormEvent, type ReactElement, useContext, useEffect, useId, useState } from "react";
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
import { approvalIdOf, messageOf, SettingsApprovalContext } from "./shared.tsx";

/**
 * Guided "Add a channel" (Settings → Channels). Uses the Gateway's own methods, in order:
 * refuse a (type, account) that already has a channel (so a live channel's tokens are never
 * replaced), `channels.secrets.set` for each transport token (sent in the request body, straight
 * to the vault, never in a URL and never echoed back), then `channels.configure` to create the
 * channel on the safe default policy (`pairing`: nobody is let in until the owner approves them).
 * If creating fails, every token this flow stored is cleared again, so a failure leaves nothing
 * behind. Creating a channel is a presence-gated change: on `approval_required` the tokens are
 * cleared, the Settings approval banner takes over, and the same steps run again once approved.
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

/** What the Gateway reads to start each transport; it must name the account added here. */
const ENV: Record<AddableType, string> = {
  slack: "PSYCHE_SLACK_WORKSPACE",
  discord: "PSYCHE_DISCORD_ACCOUNT",
  sms: "PSYCHE_SMS_FROM",
  whatsapp: "PSYCHE_WHATSAPP_NUMBER",
};

/** SMS and WhatsApp accounts are the E.164 number (the same pattern the Gateway uses). */
const E164 = /^\+\d{6,15}$/;
const NEEDS_NUMBER: ReadonlySet<AddableType> = new Set(["sms", "whatsapp"]);

export interface ChannelDraft {
  type: AddableType;
  account: string;
  secrets: Partial<Record<SecretName, string>>;
  /** Overwrite tokens already stored for this account; off keeps them as they are. */
  replaceStored?: boolean;
}

export interface AddOutcome {
  /** The channel exists but its transport is not running yet. */
  inactive: boolean;
  /** The Gateway variable that must name this account. */
  env: string;
}

type CallFn = ReturnType<typeof useCall>;

/**
 * The steps behind Connect. Throws the Gateway's error (an `approval_required` among them) with
 * nothing stored; resolves with what to tell the owner.
 */
export async function connectChannel(
  call: CallFn,
  draft: ChannelDraft,
  approvalId?: string,
): Promise<AddOutcome> {
  const { type, account, secrets } = draft;
  const { channels } = await call("channels.list", {});
  if (channels.some((c) => c.type === type && c.account.toLowerCase() === account.toLowerCase())) {
    throw new Error(t("settings.channels.add.exists", { type: TYPE_NAME[type], account }));
  }
  // Tokens already stored for this account (the CLI's two-step flow) are the owner's: they are
  // kept unless the owner chose to replace them, and a failed or approval-pending attempt never
  // deletes them. If the vault cannot be read, nothing is stored.
  const before = await call("channels.secrets.status", { type, account }).then(
    (r) => new Set<SecretName>(r.set),
    (err: unknown) => {
      throw new Error(t("settings.channels.add.statusFailed", { reason: messageOf(err) }));
    },
  );
  // A token the owner typed for a name that is already stored is never dropped silently.
  if (
    draft.replaceStored !== true &&
    ADDABLE_CHANNELS[type].some((n) => before.has(n) && (secrets[n] ?? "").trim() !== "")
  ) {
    throw new Error(t("settings.channels.add.storedTyped"));
  }
  const stored: SecretName[] = [];
  try {
    for (const name of ADDABLE_CHANNELS[type]) {
      if (before.has(name) && draft.replaceStored !== true) continue;
      await call("channels.secrets.set", {
        type,
        account,
        name,
        value: (secrets[name] ?? "").trim(),
      });
      stored.push(name);
    }
    const { channel } = await call("channels.configure", {
      type,
      account,
      dmPolicy: "pairing",
      ...(approvalId === undefined ? {} : { approvalId }),
    });
    // The transport only starts when the Gateway's environment names this account.
    const now = await call("channels.get", { channelId: channel.id }).then(
      (r) => r.channel,
      () => channel,
    );
    // `active` only means the row exists: the Gateway reports no adapter state here, so the
    // message always names the variable that starts the transport.
    return { inactive: now.status !== "active", env: ENV[type] };
  } catch (err) {
    // If another add won the race and the channel now exists, the shared tokens are its own.
    const raced = await call("channels.list", {}).then(
      (r) => r.channels.some((c) => c.type === type && c.account === account),
      () => false,
    );
    if (!raced) {
      for (const name of stored) {
        if (before.has(name)) continue;
        await call("channels.secrets.clear", { type, account, name }).catch(() => undefined);
      }
    }
    throw err;
  }
}

export interface AddChannelDialogProps {
  open: boolean;
  persona: string;
  onClose: () => void;
  /** Called once the channel exists, so the list reloads; `inactive` when it is not running yet. */
  onAdded: (outcome: AddOutcome) => void;
}

export function AddChannelDialog({
  open,
  persona,
  onClose,
  onAdded,
}: AddChannelDialogProps): ReactElement {
  const call = useCall();
  const id = useId();
  const requestApproval = useContext(SettingsApprovalContext);
  const [type, setType] = useState<AddableType>("slack");
  const [account, setAccount] = useState("");
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = ADDABLE_CHANNELS[type];
  // Tokens already stored for this account: kept unless the owner ticks Replace.
  const [alreadyStored, setAlreadyStored] = useState<SecretName[]>([]);
  const [replace, setReplace] = useState(false);
  const acct = account.trim();
  useEffect(() => {
    setAlreadyStored([]);
    setReplace(false);
    if (acct === "") return;
    let live = true;
    const timer = setTimeout(() => {
      call("channels.secrets.status", { type, account: acct }).then(
        (r) => {
          if (live) setAlreadyStored(r.set);
        },
        () => undefined,
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [call, type, acct]);
  const keeping = (n: SecretName) => alreadyStored.includes(n) && !replace;
  // A field that turns off while the owner keeps the stored token loses what was typed in it.
  useEffect(() => {
    if (replace || alreadyStored.length === 0) return;
    setSecrets((cur) => {
      const next = { ...cur };
      for (const n of alreadyStored) delete next[n];
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    });
  }, [alreadyStored, replace]);
  const complete =
    acct !== "" && names.every((n) => keeping(n) || (secrets[n] ?? "").trim() !== "");

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
    if (NEEDS_NUMBER.has(type) && !E164.test(acct)) {
      setError(t("settings.channels.add.badNumber"));
      return;
    }
    const draft: ChannelDraft = {
      type,
      account: acct,
      secrets: { ...secrets },
      replaceStored: replace,
    };
    setBusy(true);
    setError(null);
    try {
      const outcome = await connectChannel(call, draft);
      // The tokens are dropped from memory once the Gateway has them.
      close();
      onAdded(outcome);
    } catch (err) {
      const approvalId = approvalIdOf(err);
      if (approvalId !== null && requestApproval) {
        // Creating a channel needs the owner's approval: the Settings banner shows the card and
        // runs the same steps again once it is approved. Nothing is stored while it waits.
        requestApproval({
          key: "channels.add",
          label: t("settings.channels.add.approvalLabel"),
          approvalId,
          retry: async (aid) => onAdded(await connectChannel(call, draft, aid)),
        });
        close();
      } else {
        setError(t("settings.channels.add.failed", { reason: messageOf(err) }));
      }
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
          {alreadyStored.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-md bg-fill-secondary p-3">
              <p className="text-callout text-label-secondary">
                {t("settings.channels.add.storedNote", {
                  names: alreadyStored
                    .map((n) => t(`settings.channels.add.secret.${n}`))
                    .join(", "),
                })}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={replace}
                  disabled={busy}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                {t("settings.channels.add.replace")}
              </label>
            </div>
          ) : null}
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
                disabled={busy || keeping(name)}
                onChange={(e) => setSecrets((s) => ({ ...s, [name]: e.target.value }))}
              />
            </div>
          ))}
          <p className="text-callout text-muted-foreground">
            {t("settings.channels.add.envNote", { env: ENV[type] })}
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
