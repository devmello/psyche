import { type ReactElement, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { clearThread, GatewayRequestError, useStore, useStoreState } from "../data/index.ts";
import type { UiState } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { usePersona } from "../slots.tsx";

/**
 * Whether the thread has work the Gateway would refuse to clear under: a run working, or one
 * waiting on an approval or a question. Same test as `threads.clear`'s `conflict`.
 */
export function selectChatBusy(s: UiState, threadId: string): boolean {
  const entry = s.threads[threadId];
  if (entry !== undefined) {
    const a = entry.activity;
    if (a.running + a.awaitingApproval + a.awaitingInput > 0) return true;
    if ((entry.thread.activeWriterRunId ?? null) !== null) return true;
  }
  return Object.values(s.runs).some(
    (r) =>
      r.threadId === threadId &&
      (r.status === "running" || r.status === "awaiting_approval" || r.status === "awaiting_input"),
  );
}

/** Opens the Clear chat dialog of a chat (⋯ menu, ⌘K, `/clear`); that chat's thread shows it. */
export function requestClearChat(
  store: { update: (fn: (s: UiState) => UiState) => void },
  threadId: string,
): void {
  store.update((s) => ({ ...s, clearChatRequest: threadId }));
}

/**
 * The header menu's Clear chat props for a chat: only the main chat offers it (every other chat
 * can be deleted), and it is off while the chat is working or waiting on you.
 */
export function useClearChatHeader(
  threadId: string | null,
  kind: string | undefined,
): { onClearChat?: () => void; clearChatDisabled?: boolean } {
  const store = useStore();
  const busy = useStoreState((s) => (threadId === null ? false : selectChatBusy(s, threadId)));
  if (threadId === null || kind !== "main") return {};
  return { onClearChat: () => requestClearChat(store, threadId), clearChatDisabled: busy };
}

export interface ClearChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Clears the chat; `alsoForget` is the checkbox. Rejects with the reason to show. */
  onConfirm: (alsoForget: boolean) => Promise<void>;
  /** The chat is working or waiting on you: the confirm button is off, with this reason. */
  busy?: boolean;
}

/**
 * "Clear the main chat?": says what goes (the messages, the agent's working memory of the chat)
 * and what stays (receipts, the activity log), with "Also forget what {persona} learned from
 * this chat" off by default and the destructive confirm. The chat itself keeps its place.
 */
export function ClearChatDialog({
  open,
  onOpenChange,
  onConfirm,
  busy = false,
}: ClearChatDialogProps): ReactElement {
  const persona = usePersona();
  const forgetId = useId();
  const [forget, setForget] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) return;
    setForget(false);
    setError(null);
  }, [open]);
  const run = () => {
    setWorking(true);
    setError(null);
    onConfirm(forget)
      .then(() => onOpenChange(false))
      .catch((err: unknown) =>
        setError(
          err instanceof GatewayRequestError && err.code === "conflict"
            ? t("chat.clear.busy", { persona: persona.name })
            : t("chat.clear.failed", { reason: describeError(err) }),
        ),
      )
      .finally(() => setWorking(false));
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="clear-chat-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chat.clear.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("chat.clear.body", { persona: persona.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-2">
          <Checkbox
            id={forgetId}
            className="mt-0.5"
            checked={forget}
            onCheckedChange={(v) => setForget(v === true)}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={forgetId} className="text-body text-label-primary">
              {t("chat.clear.forget", { persona: persona.name })}
            </label>
            <p className="text-callout text-label-secondary">{t("chat.clear.forgetHint")}</p>
          </div>
        </div>
        {busy ? (
          <p role="status" className="text-callout text-label-secondary">
            {t("chat.clear.busy", { persona: persona.name })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-callout text-danger-text">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy || working} onClick={run}>
            {working ? t("chat.clear.clearing") : t("chat.clear.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The thread's own Clear chat dialog: opens when something asked for this thread's
 * (`clearChatRequest`), clears it with `threads.clear`, and leaves the chat showing its empty state.
 * Mounted by the chat column, so the request survives a ⌘K action that first navigates here.
 */
export function ConnectedClearChatDialog({ threadId }: { threadId: string }): ReactElement | null {
  const store = useStore();
  const requested = useStoreState((s) => s.clearChatRequest === threadId);
  const busy = useStoreState((s) => selectChatBusy(s, threadId));
  return (
    <ClearChatDialog
      open={requested}
      busy={busy}
      onOpenChange={(open) => {
        if (!open)
          store.update((s) =>
            s.clearChatRequest === threadId ? { ...s, clearChatRequest: null } : s,
          );
      }}
      onConfirm={async (alsoForget) => {
        await clearThread(store, threadId, alsoForget);
        toast(t("chat.clear.done"));
      }}
    />
  );
}
