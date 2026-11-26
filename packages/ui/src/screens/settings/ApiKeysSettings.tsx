import { ChevronRight, CircleHelp } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { Group } from "./shared.tsx";

const ROW =
  "flex min-h-11 w-full cursor-default items-center gap-3 px-4 py-2 text-start text-body text-label-primary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Settings → Model & providers → API keys (setup without a terminal): one row per hosted model
 * provider and one for web search. The field is write-only: a saved key is never read back, so
 * the row shows only whether one is set and where it comes from. The draft is dropped as soon as
 * it is sent. No call is made to the provider to test the key.
 */

export const API_KEY_IDS = ["anthropic", "openai", "google", "openrouter", "brave"] as const;
export type ApiKeyId = (typeof API_KEY_IDS)[number];

export interface ApiKeyStatus {
  id: ApiKeyId;
  configured: boolean;
  source: "env" | "vault" | null;
  inVault: boolean;
}

/** Light local check before anything is sent: not empty, no whitespace. */
export function checkApiKeyDraft(raw: string): "empty" | "whitespace" | null {
  const v = raw.trim();
  if (v === "") return "empty";
  return /\s/.test(v) ? "whitespace" : null;
}

const messageOf = (err: unknown): string => describeError(err);

function statusLine(s: ApiKeyStatus): string {
  if (s.source === "env") {
    return s.inVault ? t("settings.apiKeys.envAndVault") : t("settings.apiKeys.env");
  }
  return s.source === "vault" ? t("settings.apiKeys.vault") : t("settings.apiKeys.none");
}

function KeyRow({
  status,
  onChanged,
  isPrimary,
}: {
  status: ApiKeyStatus;
  onChanged: () => void;
  /** The default model (`models.primary`) is served by this provider. */
  isPrimary: boolean;
}): ReactElement {
  const call = useCall();
  const id = useId();
  const name = t(`settings.apiKeys.name.${status.id}`);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);

  const save = async () => {
    const problem = checkApiKeyDraft(draft);
    if (problem !== null) {
      setError(t(problem === "empty" ? "settings.apiKeys.empty" : "settings.apiKeys.whitespace"));
      return;
    }
    const key = draft.trim();
    setBusy(true);
    setError(null);
    try {
      await call("keys.set", { id: status.id, key });
      // The draft is dropped once the Gateway has it; a failed save keeps it to try again.
      setDraft("");
      onChanged();
    } catch (err) {
      const reason = messageOf(err);
      setError(
        /vault is locked/i.test(reason)
          ? t("settings.apiKeys.locked")
          : t("settings.apiKeys.failed", { reason }),
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("keys.clear", { id: status.id });
      onChanged();
    } catch (err) {
      setError(t("settings.apiKeys.clearFailed", { reason: messageOf(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={ROW}
        data-testid={`api-key-row-${status.id}`}
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-callout text-label-secondary">
          {status.configured ? t("settings.drill.keySet") : t("settings.apiKeys.none")}
        </span>
        <ChevronRight className="size-4 text-label-tertiary" aria-hidden="true" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // The draft is a secret in the page: closing the sheet drops it.
          if (!next) {
            setDraft("");
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription className="sr-only">{t("settings.apiKeys.title")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5" data-testid={`api-key-${status.id}`}>
            <label htmlFor={`${id}-key`} className="font-medium text-foreground">
              {t("settings.apiKeys.field", { name })}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`${id}-key`}
                type="password"
                // Not a login: password managers must not offer to fill or save it.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                spellCheck={false}
                aria-describedby={`${id}-status`}
                className="h-8 min-w-72 rounded-md border border-input bg-transparent px-2 text-sm"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || draft.trim() === ""}
                onClick={() => void save()}
              >
                {busy ? t("settings.apiKeys.saving") : t("settings.apiKeys.save")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || !status.inVault}
                onClick={() => setConfirming(true)}
              >
                {t("settings.apiKeys.clear")}
              </Button>
            </div>
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("settings.apiKeys.clearConfirm.title", { name })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {isPrimary
                      ? t("settings.apiKeys.clearConfirm.bodyPrimary", { name })
                      : t("settings.apiKeys.clearConfirm.body", { name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      setConfirming(false);
                      void clear();
                    }}
                  >
                    {t("settings.apiKeys.clearConfirm.confirm")}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <p id={`${id}-status`} className="text-callout text-muted-foreground">
              {statusLine(status)}
            </p>
            {error !== null ? (
              <p role="alert" className="text-callout text-danger-text">
                {error}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ApiKeysGroup({
  keys,
  onChanged,
  primaryProvider,
}: {
  keys: readonly ApiKeyStatus[];
  onChanged: () => void;
  /** The provider id of the default model, so removing its key says what it breaks. */
  primaryProvider?: string;
}): ReactElement {
  return (
    <Group
      title={t("settings.apiKeys.title")}
      actions={
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("settings.drill.keyHelp")}
              />
            }
          >
            <CircleHelp aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 text-callout text-label-secondary">
            {t("settings.apiKeys.description")}
          </PopoverContent>
        </Popover>
      }
    >
      {API_KEY_IDS.map((id) => {
        const status = keys.find((k) => k.id === id) ?? {
          id,
          configured: false,
          source: null,
          inVault: false,
        };
        return (
          <KeyRow
            key={id}
            status={status}
            onChanged={onChanged}
            isPrimary={primaryProvider === id}
          />
        );
      })}
    </Group>
  );
}
