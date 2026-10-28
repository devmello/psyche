import type { Message, Run } from "@psyche/protocol";
import { CircleAlert } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Card } from "../blocks/card.tsx";
import { Button } from "../components/ui/button.tsx";
import { compactThread, useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";

/** An auth or credential failure: the model's key is missing, locked or refused. */
export function isCredentialFailure(error: string): boolean {
  return /\b(auth|credential|api key|unauthori[sz]ed|401|403|forbidden)\b/i.test(error);
}

/** The turn was over the owner's context limit (the Agent's `context_limit` end). */
export function isContextLimitFailure(error: string): boolean {
  return error === "context_limit" || error.startsWith("context_limit:");
}

/**
 * Which message each failed run's error follows: the last message of that run, else the last
 * message sent before the run ended (the owner's own message when the turn failed at once).
 */
export function failureAnchors(
  messages: readonly Message[],
  runs: readonly Run[],
): Map<string, Run[]> {
  const anchors = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.status !== "failed") continue;
    const own = messages.filter((m) => m.runId === run.id).at(-1);
    const until = run.endedAt ?? run.startedAt;
    const before = messages.filter((m) => m.createdAt <= until).at(-1);
    const anchor = own ?? before ?? messages.at(-1);
    if (anchor === undefined) continue;
    anchors.set(anchor.id, [...(anchors.get(anchor.id) ?? []), run]);
  }
  return anchors;
}

/**
 * A run that failed, said where its reply would have been (#539): Psyche's words for the cause,
 * a way to the setting that fixes it when the model's key is the problem, and the Gateway's own
 * text under Details.
 */
export function RunFailure({ run }: { run: Run }): ReactElement {
  const { navigate } = useSlots();
  const store = useStore();
  const [compacting, setCompacting] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const error = run.error ?? "";
  const credential = isCredentialFailure(error);
  const tooBig = isContextLimitFailure(error);
  const headline = tooBig
    ? t("chat.runFailed.contextLimit")
    : credential
      ? t("chat.runFailed.credential")
      : t("chat.runFailed.generic");
  const compact = async (): Promise<void> => {
    setCompacting(true);
    try {
      await compactThread(store, run.threadId);
    } catch {
      // The thread may be busy; the card stays so the owner can try again.
    } finally {
      setCompacting(false);
    }
  };
  return (
    <Card
      variant="pinned"
      role="alert"
      label={headline}
      className="mt-3 ms-7 flex items-start gap-2 text-body"
      data-testid="run-failure"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-label-primary">{headline}</p>
        {tooBig ? (
          <p className="text-label-secondary">{t("chat.runFailed.contextLimitHint")}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {credential && navigate ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate("/settings/model")}
            >
              {t("chat.runFailed.openModels")}
            </Button>
          ) : null}
          {tooBig ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={compacting}
              onClick={() => void compact()}
            >
              {t("chat.runFailed.compact")}
            </Button>
          ) : null}
          {error ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={`${id}-details`}
              onClick={() => setOpen((o) => !o)}
            >
              {t("chat.runFailed.details")}
            </Button>
          ) : null}
        </div>
        {open ? (
          <p id={`${id}-details`} className="text-mono break-words text-label-secondary">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
