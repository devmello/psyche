import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { renderQuestionForSurface, sanitizeDisplay } from "@psyche/permissions/cards";
import type { InputRequest, Question } from "@psyche/protocol";
import { Check } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from "react";
import { StatusGlyph } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";
import { CardEnter, useEntersLater } from "./card-enter.tsx";

/**
 * Question card from `ask_user` (UI design §3.4, Claude's AskUserQuestion schema): 1–4 questions,
 * 2–4 options each, optional multi-select, an "Other" free-text row. No timeout: background
 * input requests wait indefinitely; Psyche never auto-submits.
 *
 * Questions are the model's text and may echo untrusted content, so what is shown is the desktop
 * rendering from `@psyche/permissions/cards` (`renderQuestionForSurface`, design-12); answers
 * still carry the original header and option labels back to the agent.
 *
 * Redesign 2026 (docs/design/redesign-2026.md §5.3): the approval dock's level-1 surface with a
 * neutral hairline, `fill-tertiary` chip capsules with the selected chip in the accent, "Skip for
 * now" as a plain button before the trailing primary "Answer". Answered, it collapses to one line
 * per question.
 */

export type Answers = Record<string, string | string[]>;

export const OTHER = "\u0000other";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

export function isRecommended(o: Question["options"][number]): boolean {
  return RECOMMENDED.test(o.label) || /^recommended\b/i.test(o.description ?? "");
}

/** Chips when every label ≤ 24 chars and no option has a description or preview (§3.4). */
export function usesChips(q: Question): boolean {
  return q.options.every(
    (o) => o.label.replace(RECOMMENDED, "").length <= 24 && !o.description && !o.preview,
  );
}

/** Recommended option first (at most one), preselected for single-select only. */
export function orderedOptions(q: Question) {
  const rec = q.options.findIndex(isRecommended);
  const list = q.options.map((o, i) => ({ ...o, index: i, recommended: i === rec }));
  if (rec > 0) {
    const [r] = list.splice(rec, 1);
    if (r) list.unshift(r);
  }
  return list;
}

const cleanLabel = (label: string) => label.replace(RECOMMENDED, "");

/** Level-1 card surface shared with the approval dock (§3.5): elevation gives the hairline. */
const SURFACE = "my-2 rounded-lg bg-surface-raised text-body text-label-primary shadow-elevation-1";

/** A `fill-tertiary` capsule; the selected chip takes the accent (theme-gated AA contrast). */
const CHIP =
  "group/chip inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-fill-tertiary px-3 text-body text-label-primary outline-none select-none transition-[color,background-color,box-shadow] duration-(--duration-micro) ease-(--ease-standard) active:bg-fill-secondary active:duration-(--duration-instant) focus-visible:ring-3 focus-visible:ring-ring data-checked:bg-primary data-checked:text-primary-foreground";

interface Draft {
  selected: string[];
  other: string;
}

function initialDraft(q: Question): Draft {
  const first = orderedOptions(q)[0];
  return {
    selected: !q.multiSelect && first?.recommended ? [cleanLabel(first.label)] : [],
    other: "",
  };
}

function answerOf(q: Question, d: Draft): string | string[] | null {
  const chosen = d.selected.map((s) => (s === OTHER ? d.other.trim() : s)).filter((s) => s !== "");
  if (q.multiSelect) return chosen.length > 0 ? chosen : null;
  return chosen[0] ?? null;
}

export interface QuestionCardProps {
  request: InputRequest;
  persona?: string;
  /** Avatar node shown in the header. */
  avatar?: ReactNode;
  onAnswer?: (answers: Answers) => unknown;
  onSkip?: () => void;
  /**
   * Answered cards offer a "Change" link per question when set; it receives the question's
   * original header. The request itself is closed, so the host decides what changing means.
   */
  onChangeAnswer?: (header: string) => void;
  /** Renders an option preview in the artifact sandbox (shell slot). Plain text otherwise. */
  renderPreview?: (preview: string) => ReactNode;
  className?: string;
}

export function QuestionCard({
  request,
  persona = t("blocks.common.theAgent"),
  avatar,
  onAnswer,
  onSkip,
  onChangeAnswer,
  renderPreview,
  className,
}: QuestionCardProps): ReactElement {
  const headingId = useId();
  const later = useEntersLater(request.createdAt);
  const shown = useMemo(() => renderQuestionForSurface("desktop", request).questions, [request]);
  const [drafts, setDrafts] = useState<Draft[]>(() => request.questions.map(initialDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = useMemo(
    () => request.questions.map((q, i) => answerOf(q, drafts[i] ?? { selected: [], other: "" })),
    [request.questions, drafts],
  );
  const complete = answers.every((a) => a !== null);

  if (request.status !== "open") {
    return (
      <article aria-labelledby={headingId} className={cn(SURFACE, "px-4 py-2", className)}>
        <h3 id={headingId} className="sr-only">
          {request.status === "answered"
            ? t("blocks.question.answered")
            : t("blocks.question.cancelled")}
        </h3>
        {request.status === "cancelled" ? (
          <p className="flex min-h-7 items-center gap-2 text-label-secondary">
            <StatusGlyph status="cancelled" />
            {t("blocks.question.noLongerNeeded")}
          </p>
        ) : (
          <ul className="flex flex-col">
            {request.questions.map((q, i) => {
              const a = request.answer?.[q.header];
              const text = Array.isArray(a) ? a.join(", ") : (a ?? "—");
              const header = shown[i]?.header ?? q.header;
              return (
                <li key={q.header} className="flex min-h-7 min-w-0 items-center gap-2">
                  <StatusGlyph status="done" />
                  <span className="shrink-0 text-caption text-label-secondary">{header}</span>
                  <span className="min-w-0 flex-1 truncate">{sanitizeDisplay(text)}</span>
                  {onChangeAnswer ? (
                    <Button
                      variant="plain"
                      size="xs"
                      aria-label={t("chat.question.changeOf", { header })}
                      onClick={() => onChangeAnswer(q.header)}
                    >
                      {t("chat.question.change")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </article>
    );
  }

  const set = (qi: number, fn: (d: Draft) => Draft) =>
    setDrafts((ds) => ds.map((d, i) => (i === qi ? fn(d) : d)));

  const submit = async () => {
    if (!complete || busy || onAnswer === undefined) return;
    const out: Answers = {};
    request.questions.forEach((q, i) => {
      const a = answers[i];
      if (a !== null && a !== undefined) out[q.header] = a;
    });
    setBusy(true);
    setError(null);
    try {
      await onAnswer(out);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const n = request.questions.length;
  return (
    <CardEnter animate={later}>
      <article
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className={cn(SURFACE, "p-4", className)}
      >
        <div className="mb-3 flex items-center gap-2">
          {avatar}
          <h3 id={headingId} className="text-headline text-label-primary">
            {t("blocks.question.heading", { persona, count: n })}
          </h3>
        </div>
        <div className="flex flex-col gap-4">
          {request.questions.map((q, qi) => (
            <QuestionField
              key={q.header}
              question={q}
              display={shown[qi] ?? q}
              draft={drafts[qi] ?? { selected: [], other: "" }}
              onChange={(fn) => set(qi, fn)}
              renderPreview={renderPreview}
            />
          ))}
        </div>
        {error ? (
          <p className="mt-3 flex items-start gap-1.5 text-callout text-label-primary" role="alert">
            <StatusGlyph status="failed" />
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          {onSkip ? (
            <Button variant="plain" onClick={onSkip}>
              {t("blocks.question.skip")}
            </Button>
          ) : null}
          <Button
            disabled={!complete || busy}
            onClick={() => void submit()}
            aria-keyshortcuts="Meta+Enter"
          >
            {t("blocks.question.answer")}
          </Button>
        </div>
      </article>
    </CardEnter>
  );
}

function QuestionField({
  question: q,
  display,
  draft,
  onChange,
  renderPreview,
}: {
  question: Question;
  /** The sanitized copy of `question`, same option order; shown instead of the raw text. */
  display: Question;
  draft: Draft;
  onChange: (fn: (d: Draft) => Draft) => void;
  renderPreview?: ((preview: string) => ReactNode) | undefined;
}): ReactElement {
  const id = useId();
  const options = orderedOptions(q);
  const shownOptions = orderedOptions(display);
  const chips = usesChips(q);
  const values = [...options.map((o) => cleanLabel(o.label)), OTHER];

  const toggle = (value: string) =>
    onChange((d) => {
      if (!q.multiSelect) return { ...d, selected: [value] };
      return d.selected.includes(value)
        ? { ...d, selected: d.selected.filter((s) => s !== value) }
        : { ...d, selected: [...d.selected, value] };
    });

  // 1–9 pick options of the focused question (§3.4, §4.11).
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      (e.target instanceof HTMLInputElement && e.target.type === "text")
    )
      return;
    const n = Number.parseInt(e.key, 10);
    if (n >= 1 && n <= values.length) {
      e.preventDefault();
      toggle(values[n - 1] as string);
    }
  };

  const otherInput = (
    <Input
      aria-label={t("blocks.question.otherAnswer", { header: display.header })}
      placeholder={chips ? t("chat.question.otherPlaceholder") : t("blocks.question.other")}
      className={cn("h-7 max-w-64 text-body md:text-body", chips && "w-48 rounded-full px-3")}
      value={draft.other}
      onFocus={() => {
        if (!draft.selected.includes(OTHER)) toggle(OTHER);
      }}
      onChange={(e) => {
        const text = e.target.value;
        onChange((d) => ({ ...d, other: text }));
      }}
    />
  );

  const layout = chips ? "flex flex-wrap items-center gap-2" : "flex flex-col gap-2";
  const recommended = (
    <span className="text-subheadline text-label-secondary group-data-checked/chip:text-primary-foreground">
      {t("blocks.question.recommended")}
    </span>
  );

  return (
    <fieldset onKeyDown={onKeyDown} aria-describedby={`${id}-hint`} className="min-w-0">
      <legend className="mb-2 flex flex-col gap-0.5">
        <span className="text-caption text-label-secondary">{display.header}</span>
        <span className="text-body font-medium text-label-primary">
          {display.question}
          {q.multiSelect ? (
            <span className="ms-1.5 text-callout font-normal text-label-secondary">
              {t("blocks.question.pickAny")}
            </span>
          ) : null}
        </span>
      </legend>
      <span id={`${id}-hint`} className="sr-only">
        {t("blocks.question.keysHint", { count: values.length })}
      </span>
      {q.multiSelect ? (
        <div className={layout}>
          {options.map((o, i) => {
            const v = cleanLabel(o.label);
            const shownOption = shownOptions[i] ?? o;
            const checked = draft.selected.includes(v);
            if (chips) {
              return (
                <CheckboxPrimitive.Root
                  key={o.index}
                  className={CHIP}
                  checked={checked}
                  onCheckedChange={() => toggle(v)}
                >
                  <CheckboxPrimitive.Indicator className="-ms-0.5 flex">
                    <Check className="size-3.5" aria-hidden="true" />
                  </CheckboxPrimitive.Indicator>
                  <span className="truncate">{cleanLabel(shownOption.label)}</span>
                  {o.recommended ? <> {recommended}</> : null}
                </CheckboxPrimitive.Root>
              );
            }
            const cid = `${id}-${o.index}`;
            return (
              <div key={o.index} className="flex items-start gap-2">
                <Checkbox
                  id={cid}
                  className="mt-0.5"
                  checked={checked}
                  onCheckedChange={() => toggle(v)}
                />
                <OptionLabel htmlFor={cid} option={shownOption} renderPreview={renderPreview} />
              </div>
            );
          })}
          {chips ? (
            <>
              <CheckboxPrimitive.Root
                className={CHIP}
                checked={draft.selected.includes(OTHER)}
                onCheckedChange={() => toggle(OTHER)}
              >
                <CheckboxPrimitive.Indicator className="-ms-0.5 flex">
                  <Check className="size-3.5" aria-hidden="true" />
                </CheckboxPrimitive.Indicator>
                {t("blocks.question.other")}
              </CheckboxPrimitive.Root>
              {otherInput}
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-other`}
                aria-label={t("blocks.question.other")}
                checked={draft.selected.includes(OTHER)}
                onCheckedChange={() => toggle(OTHER)}
              />
              {otherInput}
            </div>
          )}
        </div>
      ) : (
        <RadioGroup
          value={draft.selected[0] ?? ""}
          onValueChange={(v) => toggle(v as string)}
          aria-label={display.question}
          className={layout}
        >
          {options.map((o, i) => {
            const v = cleanLabel(o.label);
            const shownOption = shownOptions[i] ?? o;
            if (chips) {
              return (
                <RadioPrimitive.Root key={o.index} value={v} className={CHIP}>
                  <span className="truncate">{cleanLabel(shownOption.label)}</span>
                  {o.recommended ? <> {recommended}</> : null}
                </RadioPrimitive.Root>
              );
            }
            const rid = `${id}-${o.index}`;
            return (
              <div key={o.index} className="flex items-start gap-2">
                <RadioGroupItem value={v} id={rid} className="mt-0.5" />
                <OptionLabel htmlFor={rid} option={shownOption} renderPreview={renderPreview} />
              </div>
            );
          })}
          {chips ? (
            <>
              <RadioPrimitive.Root value={OTHER} className={CHIP}>
                {t("blocks.question.other")}
              </RadioPrimitive.Root>
              {otherInput}
            </>
          ) : (
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value={OTHER}
                id={`${id}-other`}
                aria-label={t("blocks.question.other")}
              />
              {otherInput}
            </div>
          )}
        </RadioGroup>
      )}
    </fieldset>
  );
}

function OptionLabel({
  htmlFor,
  option,
  renderPreview,
}: {
  htmlFor: string;
  option: ReturnType<typeof orderedOptions>[number];
  renderPreview?: ((preview: string) => ReactNode) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="text-body text-label-primary">
        {cleanLabel(option.label)}
        {option.recommended ? (
          <span className="ms-1.5 rounded-full bg-fill-secondary px-1.5 text-subheadline text-label-secondary">
            {t("blocks.question.recommended")}
          </span>
        ) : null}
        {option.description ? (
          <span className="block text-callout text-label-secondary">
            {option.description.replace(/^recommended\s*[-–—:]?\s*/i, "")}
          </span>
        ) : null}
      </label>
      {option.preview ? (
        <div>
          <Button
            variant="plain"
            size="xs"
            className="-ms-2"
            aria-expanded={open}
            aria-label={t(open ? "blocks.question.hidePreviewOf" : "blocks.question.previewOf", {
              label: cleanLabel(option.label),
            })}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t("blocks.question.hidePreview") : t("blocks.question.preview")}
          </Button>
          {open ? (
            <div className="mt-1 max-h-48 overflow-auto rounded-md bg-canvas p-2 shadow-elevation-1">
              {renderPreview?.(option.preview) ?? (
                <pre className="font-mono text-mono whitespace-pre-wrap text-label-primary">
                  {option.preview}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
