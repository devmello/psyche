import type { NudgeAction, NudgeItem } from "@psyche/protocol";
import { type ReactElement, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";

/**
 * The text a "Draft a reply" fills into the chat composer. Nothing is sent. The starters (what
 * Psyche has on file, with where it comes from) go in as context the draft may use and must not
 * go beyond.
 */
export function draftPrompt(item: NudgeItem): string {
  const base = draftRequest(item);
  const starters = item.starters ?? [];
  if (starters.length === 0) return base;
  const list = starters.map((s) => `- ${s.text} (${s.evidence})`).join("\n");
  return `${base}\n\n${t("nudges.draft.starters")}\n${list}`;
}

function draftRequest(item: NudgeItem): string {
  switch (item.kind) {
    case "unanswered":
      return t("nudges.draft.unanswered", {
        name: item.name,
        channel: item.channel ?? "messages",
        days: item.daysAgo ?? 0,
      });
    case "drift":
      return t("nudges.draft.drift", { name: item.name });
    case "birthday":
      return t("nudges.draft.birthday", { name: item.name, date: item.date ?? "" });
    case "promise":
      return t("nudges.draft.promise", { name: item.name, text: item.text });
  }
}

/** Up to three things to bring up, each with the fact or promise it comes from. */
export function NudgeStarters({
  starters,
}: {
  starters: NudgeItem["starters"];
}): ReactElement | null {
  if (starters === undefined || starters.length === 0) return null;
  return (
    <section aria-label={t("nudges.starters.title")} data-testid="nudge-starters">
      <p className="text-caption text-label-secondary">{t("nudges.starters.title")}</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {starters.map((s) => (
          <li key={`${s.text}|${s.evidence}`} className="flex flex-col">
            <span className="text-body text-label-primary">{s.text}</span>
            <span className="text-caption text-label-secondary" data-testid="nudge-evidence">
              {s.evidence}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface NudgeActionsProps {
  /** Absent once the nudge has gone away (answered, snoozed elsewhere, done). */
  item: NudgeItem | undefined;
  /** Opens a chat with the draft request filled in; absent where no chat can be reached. */
  onDraft?: (prompt: string) => void;
  /** Runs an action; rejects with the Gateway's error. */
  onAct: (action: NudgeAction) => Promise<unknown>;
  /** Another control on the page holds the accent (Home): Draft is an outline button. */
  quiet?: boolean;
  className?: string;
}

/**
 * The actions under a nudge: Draft a reply (the one accent), Snooze (a week or a month), Done,
 * and Not this person. A promise past its due date is the one amber "needs you" mark.
 */
export function NudgeActions({
  item,
  onDraft,
  onAct,
  quiet = false,
  className,
}: NudgeActionsProps): ReactElement {
  const [result, setResult] = useState<NudgeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The list drops a nudge once it is acted on; the result line still names the person.
  const lastName = useRef("");
  if (item !== undefined) lastName.current = item.name;
  const run = async (action: NudgeAction) => {
    setBusy(true);
    setError(null);
    try {
      await onAct(action);
      setResult(action);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  if (item === undefined || result !== null) {
    return (
      <p role="status" className={cn("text-callout text-label-secondary", className)}>
        {result === null
          ? t("nudges.gone")
          : t(`nudges.result.${result}`, { name: lastName.current })}
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="nudge-actions">
      {item.overdue ? (
        <p className="text-callout text-amber-11" data-testid="nudge-overdue">
          {t("nudges.overdue")}
        </p>
      ) : null}
      <NudgeStarters starters={item.starters} />
      <div className="flex flex-wrap items-center gap-2">
        {onDraft ? (
          <Button
            type="button"
            size="sm"
            {...(quiet ? { variant: "outline" as const } : {})}
            disabled={busy}
            onClick={() => onDraft(draftPrompt(item))}
          >
            {item.kind === "unanswered" ? t("nudges.draftReply") : t("nudges.draftMessage")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" size="sm" variant="outline" disabled={busy} />}
          >
            {t("nudges.snooze")}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void run("snooze_week")}>
              {t("nudges.snoozeWeek")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void run("snooze_month")}>
              {t("nudges.snoozeMonth")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run("done")}
        >
          {t("nudges.done")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          className="text-label-secondary"
          onClick={() => void run("mute_person")}
        >
          {t("nudges.mutePerson")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-callout text-label-secondary">
          {t("nudges.failed", { reason: error })}
        </p>
      ) : null}
    </div>
  );
}
