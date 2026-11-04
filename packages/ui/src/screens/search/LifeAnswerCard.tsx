import type { EntitySummary, LifeAnswerPassage, LifeFactHit } from "@psyche/protocol";
import { MessageCircle } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { usePrefillComposer } from "../../chat/prefill.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { isMessageId, t } from "../../i18n/core.ts";
import { formatDate } from "../../lib/format.ts";
import {
  type AnswerClaim,
  type FollowUpTurn,
  factsDisagree,
  groundedClaims,
  type LifeAnswerPhase,
  MAX_FOLLOW_UPS,
  newestFirst,
} from "./life-answer.ts";
import { SourceViewer } from "./SourceViewer.tsx";

/**
 * The answer card above Search and ⌘K results (docs/roadmap/future-features.md §1): a short
 * answer from reviewed facts and source passages, a citation chip after each claim, and a plain
 * reason when there is no answer. An answer with no citation is never shown as an answer. A fact
 * chip shows the fact and, from there, the passage it came from; a passage chip opens the passage
 * itself. Fact values, quotes and passage titles can be other people's words, so they are drawn as
 * plain text, never as markup or links. Follow-up questions go in the box under the answer.
 */

type Reason = "no_model" | "no_facts" | "no_answer" | "ungrounded" | "model_failed";

/** What one answer came back with. */
export interface LifeAnswerData {
  answer?: string | null;
  facts: readonly LifeFactHit[];
  passages?: readonly LifeAnswerPassage[] | undefined;
  reason?: Reason | null;
}

/** The answer panel's state, from `useSearchSurface` (or a host that has its own). */
export interface LifeAnswerState {
  phase: LifeAnswerPhase;
  /** The query reads like a question, so it is asked without a click. */
  auto?: boolean;
  /** The question as typed, for "Open as a chat". */
  question?: string;
  result?: LifeAnswerData;
  onAsk: () => void;
  onOpenSettings?: () => void;
  /** Called after the card sent the owner elsewhere (the palette closes itself). */
  onDone?: () => void;
  /** Follow-up questions asked under this answer, and how to ask one; absent = not offered. */
  turns?: readonly FollowUpTurn[];
  onFollowUp?: (text: string) => void;
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

const SHORT_TITLE = 24;

function chipLabel(claim: AnswerClaim): string {
  const [fact] = claim.facts;
  const [passage] = claim.passages;
  const n = claim.facts.length + claim.passages.length;
  if (n === 1 && fact !== undefined)
    return `${fact.entity.name}: ${t(`people.attr.${fact.attribute}`)}`;
  if (n === 1 && passage !== undefined)
    return t("screens.search.answer.passageChip", {
      source: sourceLabel(passage.source),
      title:
        passage.title.length > SHORT_TITLE
          ? `${passage.title.slice(0, SHORT_TITLE).trim()}…`
          : passage.title,
    });
  if (claim.passages.length === 0) return t("screens.search.answer.facts", { n });
  return t("screens.search.answer.sources", { n });
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
  const r = state.result;
  const claims =
    state.phase === "done" ? groundedClaims(r?.answer, r?.facts ?? [], r?.passages ?? []) : [];
  const answered = claims.length > 0;
  const question = state.question?.trim() ?? "";
  const canChat = prefill !== undefined && question !== "" && state.phase === "done";
  const turns = state.turns ?? [];
  const busy = turns.some((x) => x.phase === "loading");

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
      <AnswerBody
        phase={state.phase}
        result={r}
        onOpenEntity={onOpenEntity}
        onDone={state.onDone}
        onOpenSettings={state.onOpenSettings}
      />
      {turns.map((turn) => (
        <div key={turn.id} className="flex flex-col gap-1.5" data-testid="life-answer-turn">
          <p className="text-callout text-label-secondary">
            {t("screens.search.answer.youAsked", { question: turn.question })}
          </p>
          <AnswerBody
            phase={turn.phase}
            result={turn.result}
            onOpenEntity={onOpenEntity}
            onDone={state.onDone}
            onOpenSettings={state.onOpenSettings}
          />
        </div>
      ))}
      {answered && state.onFollowUp && turns.length < MAX_FOLLOW_UPS ? (
        <FollowUpBox disabled={busy} onAsk={state.onFollowUp} />
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

/** The follow-up box. Keys stay here: in the palette they would otherwise pick a result. */
function FollowUpBox({
  disabled,
  onAsk,
}: {
  disabled: boolean;
  onAsk: (text: string) => void;
}): ReactElement {
  const [text, setText] = useState("");
  return (
    <form
      className="flex items-center gap-1.5"
      data-testid="life-answer-followup"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || text.trim() === "") return;
        onAsk(text);
        setText("");
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <Input
        value={text}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("screens.search.answer.followUpPlaceholder")}
        aria-label={t("screens.search.answer.followUpLabel")}
      />
      <Button type="submit" size="sm" variant="secondary" disabled={disabled || text.trim() === ""}>
        {t("screens.search.answer.followUpAsk")}
      </Button>
    </form>
  );
}

/** One answer: its state line, its claims with their chips, and the sources under the open chip. */
function AnswerBody({
  phase,
  result,
  onOpenEntity,
  onDone,
  onOpenSettings,
}: {
  phase: LifeAnswerPhase;
  result: LifeAnswerData | undefined;
  onOpenEntity: ((entity: EntitySummary) => void) | undefined;
  onDone: (() => void) | undefined;
  onOpenSettings: (() => void) | undefined;
}): ReactElement {
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();
  const claims =
    phase === "done"
      ? groundedClaims(result?.answer, result?.facts ?? [], result?.passages ?? [])
      : [];
  const answered = claims.length > 0;
  const reason = phase === "done" && !answered ? (result?.reason ?? "ungrounded") : null;
  return (
    <>
      {phase === "loading" ? (
        <p className="text-callout text-label-secondary" role="status">
          {t("screens.search.answer.loading")}
        </p>
      ) : null}
      {phase === "error" ? (
        <p className="text-callout text-label-secondary" role="status">
          {t("screens.search.answer.failed")}
        </p>
      ) : null}
      {reason === null ? null : (
        <p className="text-callout text-label-secondary" role="status" data-reason={reason}>
          {t(NOTE[reason])}
          {reason === "no_model" && onOpenSettings ? (
            <>
              {" "}
              <button type="button" className="underline" onClick={onOpenSettings}>
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
                  {chipLabel(claim)}
                </Badge>
              </span>
            ))}
          </p>
          {open === null || claims[open] === undefined ? null : (
            <ClaimSources
              id={`${baseId}-${open}`}
              claim={claims[open]}
              onOpenEntity={
                onOpenEntity
                  ? (e) => {
                      onOpenEntity(e);
                      onDone?.();
                    }
                  : undefined
              }
            />
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * What stands behind one chip: the passages quoted, and the facts with when Psyche learned each
 * and where it came from. Several facts are listed newest first, and a note says when they differ
 * (the newest is the likelier truth, the older ones stay visible). A fact still waiting for review
 * is never used to answer, so none is shown here.
 */
function ClaimSources({
  id,
  claim,
  onOpenEntity,
}: {
  id: string;
  claim: AnswerClaim;
  onOpenEntity: ((entity: EntitySummary) => void) | undefined;
}): ReactElement {
  const facts = newestFirst(claim.facts);
  // The source passage open below its fact or passage (one at a time).
  const [source, setSource] = useState<string | null>(null);
  const toggle = (key: string) => setSource(source === key ? null : key);
  return (
    <div id={id} className="flex flex-col gap-1.5" data-testid="life-answer-facts">
      {factsDisagree(facts) ? (
        <p className="text-callout text-approval-text" role="note">
          {t("screens.search.answer.differ")}
        </p>
      ) : null}
      {claim.passages.length === 0 ? null : (
        <ul
          className="flex flex-col gap-2 rounded-md bg-fill-quaternary p-2"
          aria-label={t("screens.search.answer.fromPassages")}
        >
          {claim.passages.map((p) => (
            <li key={p.id} className="flex flex-col gap-0.5" data-testid="life-answer-passage">
              <p className="text-callout text-label-primary">{p.title}</p>
              <p className="text-caption text-label-tertiary">
                {t("screens.search.source.from", {
                  source: sourceLabel(p.source),
                  date: formatDate(new Date(p.createdAt).toISOString()),
                })}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={source === p.id}
                  data-testid="life-answer-open-passage"
                  onClick={() => toggle(p.id)}
                >
                  {source === p.id
                    ? t("screens.search.source.hide")
                    : t("screens.search.source.show")}
                </Button>
              </div>
              {source === p.id ? <SourceViewer docId={p.id} /> : null}
            </li>
          ))}
        </ul>
      )}
      {facts.length === 0 ? null : (
        <ul
          className="flex flex-col gap-2 rounded-md bg-fill-quaternary p-2"
          aria-label={t("screens.search.answer.from")}
        >
          {facts.map((f) => {
            const learned = f.learnedAt ?? f.observedAt;
            const docIds = f.docIds?.length ? f.docIds : f.docId != null ? [f.docId] : [];
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
                <div className="flex flex-wrap gap-1">
                  {docIds.map((docId, i) => {
                    const key = `${f.factId}:${docId}`;
                    return (
                      <Button
                        key={docId}
                        size="sm"
                        variant="ghost"
                        aria-expanded={source === key}
                        data-testid="life-answer-open-source"
                        onClick={() => toggle(key)}
                      >
                        {source === key
                          ? t("screens.search.source.hide")
                          : docIds.length > 1
                            ? t("screens.search.source.showN", { n: i + 1 })
                            : t("screens.search.source.show")}
                      </Button>
                    );
                  })}
                  {onOpenEntity ? (
                    <Button size="sm" variant="ghost" onClick={() => onOpenEntity(f.entity)}>
                      {t("screens.search.answer.openFact")}
                    </Button>
                  ) : null}
                </div>
                {docIds.map((docId) =>
                  source === `${f.factId}:${docId}` ? (
                    <SourceViewer key={docId} docId={docId} />
                  ) : null,
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
