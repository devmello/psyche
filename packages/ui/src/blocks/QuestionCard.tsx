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
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Question card from `ask_user` (UI design §3.4, Claude's AskUserQuestion schema): 1–4 questions,
 * 2–4 options each, optional multi-select, an "Other" free-text row. No timeout: background
 * input requests wait indefinitely; Psyche never auto-submits.
 *
 * Questions are the model's text and may echo untrusted content, so what is shown is the desktop
 * rendering from `@psyche/permissions/cards` (`renderQuestionForSurface`, design-12); answers
 * still carry the original header and option labels back to the agent.
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
  /** Renders an option preview in the artifact sandbox (shell slot). Plain text otherwise. */
  renderPreview?: (preview: string) => ReactNode;
  className?: string;
}

const COUNT = ["", "one answer", "two answers", "three answers", "four answers"];

export function QuestionCard({
  request,
  persona = "The agent",
  avatar,
  onAnswer,
  onSkip,
  renderPreview,
  className,
}: QuestionCardProps): ReactElement {
  const headingId = useId();
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
      <article
        aria-labelledby={headingId}
        className={cn("my-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm", className)}
      >
        <h3 id={headingId} className="sr-only">
          {request.status === "answered" ? "Answered questions" : "Cancelled questions"}
        </h3>
        {request.status === "cancelled" ? (
          <p className="text-muted-foreground">No longer needed.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {request.questions.map((q, i) => {
              const a = request.answer?.[q.header];
              const text = Array.isArray(a) ? a.join(", ") : (a ?? "—");
              return (
                <li key={q.header} className="flex gap-2">
                  <Check className="mt-0.5 size-3.5 text-success" aria-hidden="true" />
                  <span className="text-label text-muted-foreground">
                    {shown[i]?.header ?? q.header}
                  </span>
                  <span>{sanitizeDisplay(text)}</span>
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
      setError(err instanceof Error ? err.message : String(err));
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
    <article
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className={cn(
        "my-2 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm psy-enter",
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        {avatar}
        <h3 id={headingId} className="font-semibold">
          {persona} needs {n === 1 ? "an answer" : COUNT[n]} before continuing
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
        <p className="mt-2 text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {onSkip ? (
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        ) : null}
        <Button
          disabled={!complete || busy}
          onClick={() => void submit()}
          aria-keyshortcuts="Meta+Enter"
        >
          Answer
        </Button>
      </div>
    </article>
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
      aria-label={`${display.header}: other answer`}
      placeholder="Other"
      className="h-7 max-w-64"
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

  return (
    <fieldset onKeyDown={onKeyDown} aria-describedby={`${id}-hint`}>
      <legend className="mb-1.5 flex items-baseline gap-2">
        <span className="text-label text-muted-foreground">{display.header}</span>
        <span className="font-medium text-foreground">{display.question}</span>
        {q.multiSelect ? <span className="text-xs text-muted-foreground">(pick any)</span> : null}
      </legend>
      <span id={`${id}-hint`} className="sr-only">
        Press 1 to {values.length} to choose.
      </span>
      {q.multiSelect ? (
        <div className={cn(chips ? "flex flex-wrap gap-x-4 gap-y-1.5" : "flex flex-col gap-1.5")}>
          {options.map((o, i) => {
            const v = cleanLabel(o.label);
            const cid = `${id}-${o.index}`;
            return (
              <div key={o.index} className="flex items-start gap-2">
                <Checkbox
                  id={cid}
                  checked={draft.selected.includes(v)}
                  onCheckedChange={() => toggle(v)}
                />
                <OptionLabel
                  htmlFor={cid}
                  option={shownOptions[i] ?? o}
                  renderPreview={renderPreview}
                />
              </div>
            );
          })}
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-other`}
              aria-label="Other"
              checked={draft.selected.includes(OTHER)}
              onCheckedChange={() => toggle(OTHER)}
            />
            {otherInput}
          </div>
        </div>
      ) : (
        <RadioGroup
          value={draft.selected[0] ?? ""}
          onValueChange={(v) => toggle(v as string)}
          aria-label={display.question}
          className={cn(chips ? "flex flex-wrap gap-x-4 gap-y-1.5" : "flex flex-col gap-1.5")}
        >
          {options.map((o, i) => {
            const v = cleanLabel(o.label);
            const rid = `${id}-${o.index}`;
            return (
              <div key={o.index} className="flex items-start gap-2">
                <RadioGroupItem value={v} id={rid} />
                <OptionLabel
                  htmlFor={rid}
                  option={shownOptions[i] ?? o}
                  renderPreview={renderPreview}
                />
              </div>
            );
          })}
          <div className="flex items-center gap-2">
            <RadioGroupItem value={OTHER} id={`${id}-other`} aria-label="Other" />
            {otherInput}
          </div>
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
      <label htmlFor={htmlFor} className="cursor-pointer leading-5">
        {cleanLabel(option.label)}
        {option.recommended ? (
          <span className="ml-1.5 rounded-full bg-accent-3 px-1.5 text-xs text-accent-11">
            recommended
          </span>
        ) : null}
        {option.description ? (
          <span className="block text-xs text-muted-foreground">
            {option.description.replace(/^recommended\s*[-–—:]?\s*/i, "")}
          </span>
        ) : null}
      </label>
      {option.preview ? (
        <div>
          <button
            type="button"
            className="min-h-6 text-xs text-accent-11 hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide preview" : "Preview"}
            <span className="sr-only"> of {cleanLabel(option.label)}</span>
          </button>
          {open ? (
            <div className="mt-1 max-h-48 overflow-auto rounded-md border border-gray-6 bg-background p-2">
              {renderPreview?.(option.preview) ?? (
                <pre className="font-mono text-xs whitespace-pre-wrap">{option.preview}</pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
