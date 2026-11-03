import type { EntitySummary, LifeFactHit } from "@psyche/protocol";
import { MessageCircle } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { usePrefillComposer } from "../../chat/prefill.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { isMessageId, t } from "../../i18n/core.ts";
import { formatDate } from "../../lib/format.ts";
import {
  type AnswerClaim,
  factsDisagree,
  groundedClaims,
  type LifeAnswerPhase,
  newestFirst,
} from "./life-answer.ts";

/**
 * The answer card above Search and ⌘K results (docs/roadmap/future-features.md §1): a short
 * answer from reviewed facts, a citation chip after each claim, and a plain reason when there is
 * no answer. An answer with no citation is never shown as an answer. Fact values and quotes can
 * be other people's words, so they are drawn as plain text, never as markup or links.
 */

/** The answer panel's state, from `useSearchSurface` (or a host that has its own). */
export interface LifeAnswerState {
  phase: LifeAnswerPhase;
  /** The query reads like a question, so it is asked without a click. */
  auto?: boolean;
  /** The question as typed, for "Open as a chat". */
  question?: string;
  result?: {
    answer?: string | null;
    facts: readonly LifeFactHit[];
    reason?: "no_model" | "no_facts" | "no_answer" | "ungrounded" | "model_failed" | null;
  };
  onAsk: () => void;
  onOpenSettings?: () => void;
  /** Called after the card sent the owner elsewhere (the palette closes itself). */
  onDone?: () => void;
}

const NOTE = {
  no_model: "screens.search.answer.noModel",
  no_facts: "screens.search.answer.noFacts",
  no_answer: "screens.search.answer.noAnswer",
  ungrounded: "screens.search.answer.ungrounded",
  model_failed: "screens.search.answer.failed",
} as const;

function sourceLabel(source: string): string {
  const id = `everything.source.${source}`;
  return isMessageId(id) ? t(id) : source;
}

function chipLabel(facts: readonly LifeFactHit[]): string {
  const [first] = facts;
  if (facts.length === 1 && first !== undefined)
    return `${first.entity.name}: ${t(`people.attr.${first.attribute}`)}`;
  return t("screens.search.answer.facts", { n: facts.length });
}

export function LifeAnswerCard({
  state,
  onOpenEntity,
}: {
  state: LifeAnswerState;
  /** Opens a person's page in Memory. */
  onOpenEntity?: (entity: EntitySummary) => void;
}): ReactElement {
  const prefill = usePrefillComposer();
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();
  const r = state.result;
  const claims = state.phase === "done" ? groundedClaims(r?.answer, r?.facts ?? []) : [];
  const answered = claims.length > 0;
  const reason = state.phase === "done" && !answered ? (r?.reason ?? "ungrounded") : null;
  const question = state.question?.trim() ?? "";
  const canChat = prefill !== undefined && question !== "" && state.phase === "done";

  return (
    <section
      className="mx-3 mb-2 flex flex-col gap-1.5 border-b border-separator pb-2"
      aria-label={t("screens.search.answer.label")}
      data-testid="life-answer"
    >
      {state.phase === "idle" ? (
        <Button size="sm" variant="secondary" className="self-start" onClick={state.onAsk}>
          {t("screens.search.answer.ask")}
        </Button>
      ) : null}
      {state.phase === "loading" ? (
        <p className="text-callout text-label-secondary" role="status">
          {t("screens.search.answer.loading")}
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p className="text-callout text-label-secondary" role="status">
          {t("screens.search.answer.failed")}
        </p>
      ) : null}
      {reason === null ? null : (
        <p className="text-callout text-label-secondary" role="status" data-reason={reason}>
          {t(NOTE[reason])}
          {reason === "no_model" && state.onOpenSettings ? (
            <>
              {" "}
              <button type="button" className="underline" onClick={state.onOpenSettings}>
                {t("screens.search.answer.settings")}
              </button>
            </>
          ) : null}
        </p>
      )}
      {answered ? (
        <>
          <p className="text-body text-label-primary" aria-live="polite">
            {claims.map((claim, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: claims are positional and never reorder
              <span key={i}>
                {i > 0 ? " " : null}
                {claim.text}{" "}
                <Badge
                  variant="outline"
                  data-testid="life-answer-source"
                  render={
                    <button
                      type="button"
                      aria-expanded={open === i}
                      aria-controls={`${baseId}-${i}`}
                      onClick={() => setOpen(open === i ? null : i)}
                    />
                  }
                >
                  {chipLabel(claim.facts)}
                </Badge>
              </span>
            ))}
          </p>
          {open === null || claims[open] === undefined ? null : (
            <ClaimFacts
              id={`${baseId}-${open}`}
              claim={claims[open]}
              onOpenEntity={
                onOpenEntity
                  ? (e) => {
                      onOpenEntity(e);
                      state.onDone?.();
                    }
                  : undefined
              }
            />
          )}
        </>
      ) : null}
      {canChat ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => {
            prefill(question);
            state.onDone?.();
          }}
        >
          <MessageCircle aria-hidden="true" />
          {t("screens.search.answer.openAsChat")}
        </Button>
      ) : null}
    </section>
  );
}

/** The facts under one chip: what each says, when Psyche learned it and where it came from. */
function ClaimFacts({
  id,
  claim,
  onOpenEntity,
}: {
  id: string;
  claim: AnswerClaim;
  onOpenEntity: ((entity: EntitySummary) => void) | undefined;
}): ReactElement {
  const facts = newestFirst(claim.facts);
  return (
    <div id={id} className="flex flex-col gap-1.5" data-testid="life-answer-facts">
      {factsDisagree(facts) ? (
        <p className="text-callout text-approval-text" role="note">
          {t("screens.search.answer.differ")}
        </p>
      ) : null}
      <ul
        className="flex flex-col gap-2 rounded-md bg-fill-quaternary p-2"
        aria-label={t("screens.search.answer.from")}
      >
        {facts.map((f) => {
          const learned = f.learnedAt ?? f.observedAt;
          return (
            <li key={f.factId} className="flex flex-col gap-0.5" data-testid="life-answer-fact">
              <p className="text-callout text-label-primary">
                {f.entity.name} · {t(`people.attr.${f.attribute}`)}: {f.value}
              </p>
              <p className="text-caption text-label-tertiary">
                {learned == null
                  ? null
                  : t("screens.search.answer.learned", { date: formatDate(learned) })}
                {learned != null && f.source != null ? " · " : null}
                {f.source == null
                  ? null
                  : t("screens.search.answer.fromSource", { source: sourceLabel(f.source) })}
              </p>
              {f.quote == null ? null : (
                <blockquote className="border-l-2 border-separator pl-2 text-callout text-label-secondary">
                  {t("memoryReview.quote", { quote: f.quote })}
                </blockquote>
              )}
              {onOpenEntity ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => onOpenEntity(f.entity)}
                >
                  {t("screens.search.answer.openFact")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
