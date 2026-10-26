import type { Automation } from "@psyche/protocol";
import { CalendarClock, Plus, Sparkles, X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { scheduleSentence } from "../../agent/UpcomingPanel.tsx";
import { DelayedSkeletons } from "../../components/DelayedSkeleton.tsx";
import { ErrorState, GroupedList, GroupedRow } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useAutomations, useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import {
  FEED_INSTRUCTIONS_PATH,
  INSTRUCTIONS_MAX,
  INTERESTS_PATH,
  type InterestLedger,
  type InterestRow,
  mergeInterests,
  parseInterests,
  serializeInterests,
} from "./interests.ts";

/** A row being edited: the ledger row plus the index of the line it came from. */
export type EditableRow = InterestRow & { origin?: number; key: string };

/** How strongly a topic steers the feed; the three weights the editor offers. */
export const WEIGHTS = [
  { value: 0.9, id: "strong" },
  { value: 0.6, id: "some" },
  { value: 0.3, id: "light" },
] as const;

function nearestWeight(w: number): number {
  let best: number = WEIGHTS[0].value;
  for (const x of WEIGHTS) if (Math.abs(x.value - w) < Math.abs(best - w)) best = x.value;
  return best;
}

export interface FeedInstructionsViewProps {
  instructions: string;
  onInstructionsChange: (text: string) => void;
  rows: readonly EditableRow[];
  onRowsChange: (rows: EditableRow[]) => void;
  /** The briefing's schedule as a sentence ("weekdays 07:00"), or null when there is none. */
  schedule: string | null;
  onSchedule?: () => void;
  loading?: boolean;
  /** What failed while loading, e.g. "the Gateway timed out". */
  error?: string | null;
  onRetry?: () => void;
}

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

/**
 * The Feed instructions editor's body (issue #614): free-text guidance, the interest ledger as
 * editable rows (topic, how strongly, why) plus excluded topics and hidden sources, and the
 * briefing's schedule with a link to change it. Presentational; the sheet saves.
 */
export function FeedInstructionsView({
  instructions,
  onInstructionsChange,
  rows,
  onRowsChange,
  schedule,
  onSchedule,
  loading = false,
  error = null,
  onRetry,
}: FeedInstructionsViewProps): ReactElement {
  const textId = useId();
  if (loading) {
    return (
      <DelayedSkeletons label={t("screens.feed.editor.loading")} className="flex flex-col gap-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </DelayedSkeletons>
    );
  }
  if (error !== null) {
    return (
      <ErrorState
        what={t("screens.feed.editor.loadFailed")}
        reason={error}
        did={t("screens.feed.editor.nothingChanged")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  }
  const update = (key: string, patch: Partial<InterestRow>) =>
    onRowsChange(rows.map((r) => (r.key === key ? ({ ...r, ...patch } as EditableRow) : r)));
  const remove = (key: string) => onRowsChange(rows.filter((r) => r.key !== key));
  const topics = rows.filter((r) => r.kind === "topic");
  const avoid = rows.filter((r) => r.kind !== "topic");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor={textId} className="px-1 text-title-3 text-label-primary">
          {t("screens.feed.editor.instructions")}
        </label>
        <Textarea
          id={textId}
          value={instructions}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(e) => onInstructionsChange(e.target.value)}
          placeholder={t("screens.feed.editor.placeholder")}
          className="min-h-28 text-reading"
          aria-describedby={`${textId}-hint`}
        />
        <p id={`${textId}-hint`} className="flex gap-3 px-1 text-callout text-label-secondary">
          <span className="min-w-0 flex-1">{t("screens.feed.editor.hint")}</span>
          <span className="shrink-0 tabular-nums" aria-live="polite">
            {t("screens.feed.editor.count", { n: instructions.length, max: INSTRUCTIONS_MAX })}
          </span>
        </p>
      </div>

      <GroupedList
        title={t("screens.feed.editor.interests")}
        footer={t("screens.feed.editor.interestsHint")}
      >
        {topics.length === 0 ? <GroupedRow label={t("screens.feed.editor.noInterests")} /> : null}
        {topics.map((r) =>
          r.kind === "topic" ? (
            <GroupedRow
              key={r.key}
              label={
                <Input
                  value={r.topic}
                  aria-label={t("screens.feed.editor.topic")}
                  placeholder={t("screens.feed.editor.topicPlaceholder")}
                  onChange={(e) => update(r.key, { topic: e.target.value })}
                  className="h-7"
                />
              }
              {...(r.why ? { description: r.why } : {})}
              control={
                <>
                  <NativeSelect
                    size="sm"
                    aria-label={t("screens.feed.editor.weightFor", { topic: r.topic || "…" })}
                    value={String(nearestWeight(r.weight))}
                    onChange={(e) => update(r.key, { weight: Number(e.target.value) })}
                  >
                    {WEIGHTS.map((w) => (
                      <option key={w.id} value={String(w.value)}>
                        {t(`screens.feed.editor.weight.${w.id}`)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("screens.feed.editor.remove", { topic: r.topic || "…" })}
                    onClick={() => remove(r.key)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </>
              }
            />
          ) : null,
        )}
        <div className="px-1.5 py-1">
          <Button
            type="button"
            size="sm"
            variant="plain"
            onClick={() =>
              onRowsChange([
                ...rows,
                { kind: "topic", topic: "", weight: 0.6, why: "", key: newKey() },
              ])
            }
          >
            <Plus aria-hidden="true" />
            {t("screens.feed.editor.addTopic")}
          </Button>
        </div>
      </GroupedList>

      {avoid.length > 0 ? (
        <GroupedList title={t("screens.feed.editor.avoid")}>
          {avoid.map((r) => (
            <GroupedRow
              key={r.key}
              label={
                r.kind === "exclude"
                  ? t("screens.feed.editor.excluded", { topic: r.topic })
                  : r.kind === "hide_source"
                    ? t("screens.feed.editor.hidden", { host: r.host })
                    : null
              }
              {...(r.why ? { description: r.why } : {})}
              control={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(r.key)}
                  aria-label={t("screens.feed.editor.allowAgain", {
                    what: r.kind === "hide_source" ? r.host : r.kind === "exclude" ? r.topic : "",
                  })}
                >
                  {t("screens.feed.editor.allow")}
                </Button>
              }
            />
          ))}
        </GroupedList>
      ) : null}

      <GroupedList title={t("screens.feed.editor.schedule")}>
        <GroupedRow
          leading={<CalendarClock className="size-4" aria-hidden="true" />}
          label={
            schedule === null
              ? t("screens.feed.editor.noSchedule")
              : t("screens.feed.editor.scheduleLine", { when: schedule })
          }
          {...(onSchedule
            ? {
                control: (
                  <Button type="button" size="sm" variant="ghost" onClick={onSchedule}>
                    {t("screens.feed.editor.changeSchedule")}
                  </Button>
                ),
              }
            : {})}
        />
      </GroupedList>
    </div>
  );
}

interface LoadedFile {
  content: string;
  /** null when the file doesn't exist yet. */
  etag: string | null;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/** Reads a workspace file; a missing file reads as empty (the editor creates it on save). */
function useWorkspaceFile(path: string, active: boolean) {
  const call = useCall();
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads on Try again
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError(null);
    call("memory.read", { path }).then(
      (res) => {
        if (live) setFile({ content: res.content, etag: res.etag ?? null });
      },
      (err: unknown) => {
        if (!live) return;
        if (hasCode(err, "not_found")) setFile({ content: "", etag: null });
        else setError(describeError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [call, path, active, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  /** Reads the latest version (after a conflict) without touching what the sheet shows. */
  const latest = async (): Promise<LoadedFile> => {
    try {
      const res = await call("memory.read", { path });
      return { content: res.content, etag: res.etag ?? null };
    } catch (err) {
      if (hasCode(err, "not_found")) return { content: "", etag: null };
      throw err;
    }
  };
  const save = async (content: string, against: LoadedFile | null = file) => {
    const res = await call("memory.write", {
      path,
      content,
      ...(against?.etag == null ? {} : { etag: against.etag }),
    });
    setFile({ content, etag: res.etag ?? null });
  };
  return { file, error, reload, latest, save };
}

function toRows(ledger: InterestLedger): EditableRow[] {
  return ledger.rows.map((r, i) => ({ ...r, origin: i, key: `row-${i}` }));
}

export interface FeedInstructionsSheetProps {
  open: boolean;
  /** Closing the sheet (×, Escape, the backdrop); the route returns to `/feed`. */
  onClose: () => void;
  /** Opens the briefing's schedule (Upcoming in the agent sheet). */
  onSchedule?: () => void;
  /** "Generate now": defaults to `feed.generate`. */
  onGenerate?: () => Promise<unknown> | undefined;
  /** Holds the sheet in its saving state (stories); the sheet sets it itself while it writes. */
  saving?: boolean;
}

/**
 * "What should I write about" (issue #614): an opaque sheet over the Feed (the materials
 * decision: modal sheets aren't glass). It edits `feed/INSTRUCTIONS.md` (free text the briefing
 * reads ahead of the ledger) and the rows of `interests.md`, each saved through `memory.write`
 * with its etag, so an edit made meanwhile is never overwritten. Generate now runs `feed.generate`.
 */
export function FeedInstructionsSheet({
  open,
  onClose,
  onSchedule,
  onGenerate,
  saving: savingProp = false,
}: FeedInstructionsSheetProps): ReactElement {
  const call = useCall();
  const textFile = useWorkspaceFile(FEED_INSTRUCTIONS_PATH, open);
  const ledgerFile = useWorkspaceFile(INTERESTS_PATH, open);
  const automations = useAutomations();
  const [text, setText] = useState<string | null>(null);
  const [rows, setRows] = useState<EditableRow[] | null>(null);
  const [savingNow, setSaving] = useState(false);
  const saving = savingProp || savingNow;
  const [generating, setGenerating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const ledger = ledgerFile.file === null ? null : parseInterests(ledgerFile.file.content);
  const shownText = text ?? textFile.file?.content ?? "";
  const shownRows = rows ?? (ledger === null ? [] : toRows(ledger));
  const nextLedger = ledger === null ? null : serializeInterests(ledger, shownRows);
  const textDirty = textFile.file !== null && shownText !== textFile.file.content;
  const ledgerDirty =
    ledgerFile.file !== null &&
    nextLedger !== null &&
    rows !== null &&
    nextLedger !== ledgerFile.file.content;
  const loading =
    open &&
    (textFile.file === null || ledgerFile.file === null) &&
    !textFile.error &&
    !ledgerFile.error;
  const loadError = textFile.error ?? ledgerFile.error;
  const briefing = automations.automations.find((a: Automation) => a.kind === "briefing") ?? null;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (textDirty)
        await textFile.save(
          shownText.endsWith("\n") || shownText === "" ? shownText : `${shownText}\n`,
        );
      if (ledgerDirty && nextLedger !== null && ledger !== null) {
        try {
          await ledgerFile.save(nextLedger);
        } catch (err) {
          if (!hasCode(err, "conflict")) throw err;
          // Feedback rewrote interests.md meanwhile: re-read it and re-apply these edits once.
          const fresh = await ledgerFile.latest();
          await ledgerFile.save(mergeInterests(ledger, shownRows, fresh.content), fresh);
        }
      }
      setText(null);
      setRows(null);
      toast(t("screens.feed.editor.saved"));
    } catch (err) {
      setSaveError(
        hasCode(err, "conflict") ? t("screens.feed.editor.conflict") : describeError(err),
      );
    } finally {
      setSaving(false);
    }
  };

  const generate = () => {
    setGenerating(true);
    Promise.resolve(onGenerate ? onGenerate() : call("feed.generate", {}))
      .then(() => toast(t("screens.feed.editor.generating")))
      .catch((err: unknown) =>
        toast.error(t("screens.feed.generateFailed", { reason: describeError(err) })),
      )
      .finally(() => setGenerating(false));
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setText(null);
          setRows(null);
          setSaveError(null);
          onClose();
        }
      }}
    >
      <SheetContent
        side="right"
        data-testid="feed-instructions"
        // Focus lands in the instructions box, not on the footer's Generate now.
        initialFocus={() =>
          document.querySelector<HTMLElement>('[data-testid="feed-instructions"] textarea')
        }
        className="gap-0 bg-surface-overlay shadow-elevation-3 data-[side=right]:w-full data-[side=right]:border-0 data-[side=right]:sm:max-w-[480px]"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-title-2 text-label-primary">
            {t("screens.feed.instructions")}
          </SheetTitle>
          <SheetDescription className="text-callout text-label-secondary">
            {t("screens.feed.editor.description")}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <FeedInstructionsView
            instructions={shownText}
            onInstructionsChange={setText}
            rows={shownRows}
            onRowsChange={setRows}
            schedule={briefing === null ? null : scheduleSentence(briefing)}
            loading={loading}
            error={loadError}
            onRetry={() => {
              textFile.reload();
              ledgerFile.reload();
            }}
            {...(onSchedule ? { onSchedule } : {})}
          />
          {saveError ? (
            <p role="alert" className="mt-3 text-body text-label-primary">
              <span className="font-semibold text-danger-text">
                {t("screens.feed.editor.saveFailed")}
              </span>{" "}
              {saveError}
            </p>
          ) : null}
        </div>
        <SheetFooter className="flex-row items-center justify-end gap-2 border-t border-separator px-5 py-3">
          <Button
            type="button"
            variant="outline"
            disabled={generating}
            onClick={generate}
            className="me-auto"
          >
            <Sparkles aria-hidden="true" />
            {generating
              ? t("screens.feed.editor.generatingShort")
              : t("screens.feed.editor.generate")}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={saving || loading || loadError !== null || (!textDirty && !ledgerDirty)}
            onClick={() => void save()}
          >
            {saving ? t("screens.feed.editor.saving") : t("common.save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
