import { Sparkles } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { EvidenceLine } from "../screens/ideas/evidence.tsx";
import type { GraphSuggestion } from "./types.ts";

export type SuggestionAnswer = "accept" | "reject" | "later";

export interface SuggestionCardProps {
  suggestion: GraphSuggestion;
  onAnswer?: (suggestion: GraphSuggestion, answer: SuggestionAnswer) => void;
  busy?: boolean;
}

/** "Sam Lee" or "Sam L. (samlee.home@gmail.com)". */
function described(e: GraphSuggestion["entities"][number] | undefined): string {
  if (!e) return "";
  return e.detail ? `${e.name} (${e.detail})` : e.name;
}

/**
 * A merge or project suggestion (spec §6.5), in the inferred-goal pattern: a sparkle, the
 * question, "Because:" evidence and Confirm / Not the same / Later. Nothing changes before
 * Confirm.
 */
export function SuggestionCard({
  suggestion,
  onAnswer,
  busy = false,
}: SuggestionCardProps): ReactElement {
  const titleId = useId();
  const merge = suggestion.kind === "merge";
  const question = merge
    ? t("people.suggestion.merge", {
        a: described(suggestion.entities[0]),
        b: described(suggestion.entities[1]),
      })
    : t("people.suggestion.project", { name: suggestion.proposedName ?? "" });
  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
    >
      <p className="flex items-center gap-1 text-caption text-label-secondary">
        <Sparkles className="size-3.5 text-accent-11" aria-hidden="true" />
        {t("people.suggestion.eyebrow")}
      </p>
      <h3 id={titleId} className="text-headline text-label-primary">
        {question}
      </h3>
      <EvidenceLine
        items={suggestion.reasons.map((text) => ({
          source: null,
          text,
          ref: null,
          route: null,
          href: null,
        }))}
      />
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onAnswer?.(suggestion, "accept")}
        >
          {t("people.suggestion.confirm")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onAnswer?.(suggestion, "reject")}
        >
          {merge ? t("people.suggestion.notSame") : t("people.suggestion.notProject")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onAnswer?.(suggestion, "later")}
        >
          {t("people.suggestion.later")}
        </Button>
      </div>
    </article>
  );
}
