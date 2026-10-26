import type { RunStep } from "@psyche/protocol";
import { ArrowLeft } from "lucide-react";
import { useReducedMotionConfig } from "motion/react";
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTicker } from "../../components/steps/ticker.ts";
import { timeScale } from "../../components/timeline/scale.ts";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { useStoreState } from "../../data/provider.tsx";
import { useRun, useRunFrames, useRunSteps } from "../../data/runs.ts";
import { t } from "../../i18n/core.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { FailureBanner } from "./FailureBanner.tsx";
import { Thumbs } from "./FrameViewer.tsx";
import { timelineAction, zoomStep } from "./keyboard.ts";
import { ListView } from "./ListView.tsx";
import {
  allRows,
  ancestorsOf,
  buildRows,
  defaultFolded,
  failedStep,
  inRange,
  issueRows,
  matchesQuery,
  ms,
  traceGaps,
  visibleRows,
} from "./model.ts";
import { RunHeader, runTitle, type TimelineMode } from "./RunHeader.tsx";
import {
  advance,
  advanceReduced,
  eventTimes,
  failureTimes,
  nextEvent,
  prevEvent,
  REDUCED_STEP_MS,
  type ReplaySpeed,
  stepAtTime,
  stepsAt,
} from "./replay.ts";
import { Scrubber, type ScrubberMarker } from "./Scrubber.tsx";
import { type InspectorTab, StepInspector, type StepLinks } from "./StepInspector.tsx";
import { DURATION_PX, LABEL_PX, Waterfall } from "./Waterfall.tsx";

/**
 * The Timeline (docs/design/run-trace-2026.md §3.3–§3.5, §3.8): one task's steps over time in the
 * agent sheet. The run header (with the failure diagnosis), the waterfall or the searchable List,
 * the step inspector (beside the waterfall from 900 px, under it below, pushed on compact web),
 * and the replay scrubber. A failed task opens on its failed step's Output.
 */

/** The inspector sits beside the waterfall from this container width; below it, under it. */
const SIDE_BY_SIDE = 900;
const INSPECTOR_PX = 360;
/** Compact web: the waterfall becomes a list of rows and the inspector a pushed screen. */
const COMPACT = 520;

type Replay = { t: number; how: "scrub" | "jump" } | null;

/** Loads a helper's steps (one loader per child run, so hooks stay unconditional). */
function ChildSteps({ runId }: { runId: string }): null {
  useRunSteps(runId);
  return null;
}

function downloadBase64(fileName: string, mime: string, data: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface TimelineViewProps extends StepLinks {
  runId: string;
  /** Open on this step (`?step=`); a failed task opens on its failed step otherwise. */
  initialStepId?: string;
  /** A fixed clock for stories and tests. */
  now?: number;
  onBack?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onRetry?: () => void;
  /** Opens the account behind an authorisation failure. */
  onReconnect?: (step: RunStep) => void;
  onCopyLink?: (stepId: string | null) => void;
  threadTitle?: string;
  retentionDays?: number;
  /** The inspector tab to open on (stories; a failed task opens on Output by itself). */
  initialTab?: InspectorTab;
  /** Open paused mid-replay at this time (stories and deep links). */
  initialReplayAt?: number;
}

export function TimelineView({
  runId,
  initialStepId,
  now: fixedNow,
  onBack,
  onStop,
  onPause,
  onRetry,
  onReconnect,
  onCopyLink,
  threadTitle,
  retentionDays = 7,
  initialTab,
  initialReplayAt,
  ...links
}: TimelineViewProps): ReactElement {
  const { run, steps, children, loading, error, reload, exportTrace, deleteTrace } = useRun(runId);
  const { frames, image } = useRunFrames(runId);
  const allSteps = useStoreState((s) => s.runSteps);
  const runs = useStoreState((s) => s.runs);
  const reduce = useReducedMotionConfig() === true;
  const running = run?.status === "running";
  const clock = useTicker(running && fixedNow === undefined);
  const now = fixedNow ?? clock;

  const rootRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const [mode, setMode] = useState<TimelineMode>("waterfall");
  const [selectedId, setSelectedId] = useState<string | null>(initialStepId ?? null);
  const [tab, setTab] = useState<InspectorTab>(initialTab ?? "overview");
  const [pushed, setPushed] = useState(false);
  const [folded, setFolded] = useState<Set<string> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [query, setQuery] = useState("");
  const [replay, setReplay] = useState<Replay>(
    initialReplayAt === undefined ? null : { t: initialReplayAt, how: "scrub" },
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [skipWaits, setSkipWaits] = useState(true);
  const [stopAtFailures, setStopAtFailures] = useState(true);
  const [frameSeq, setFrameSeq] = useState<number | null>(null);

  const childKey = children.map((c) => c.id).join(",");
  const childIds = useMemo(() => (childKey === "" ? [] : childKey.split(",")), [childKey]);
  const childSteps = useMemo(() => {
    const out: Record<string, readonly RunStep[]> = {};
    for (const id of childIds) out[id] = allSteps[id] ?? [];
    return out;
  }, [allSteps, childIds]);

  // Full rows (for gaps, the failed step and folding defaults), then rows at the playhead.
  const fullRows = useMemo(() => buildRows(steps, childSteps, runs), [steps, childSteps, runs]);
  const scrubbing = replay !== null && replay.how === "scrub";
  const rows = useMemo(() => {
    if (!scrubbing || replay === null) return fullRows;
    const at = replay.t;
    const kids: Record<string, readonly RunStep[]> = {};
    for (const [id, list] of Object.entries(childSteps)) kids[id] = stepsAt(list, at);
    return buildRows(stepsAt(steps, at), kids, runs);
  }, [scrubbing, replay, fullRows, steps, childSteps, runs]);

  const start = ms(run?.startedAt) ?? now;
  const end = Math.max(start + 1000, ms(run?.endedAt) ?? now);
  const gaps = useMemo(() => traceGaps(fullRows, end), [fullRows, end]);
  const failed = useMemo(() => failedStep(fullRows), [fullRows]);
  const flat = useMemo(() => allRows(fullRows), [fullRows]);
  const flatSteps = useMemo(() => flat.flatMap((r) => (r.step ? [r.step] : [])), [flat]);
  const events = useMemo(() => eventTimes(flatSteps), [flatSteps]);
  const failures = useMemo(() => failureTimes(flatSteps), [flatSteps]);

  // Fold defaults once there are rows; a failed task opens on its failed step's Output (§3.3).
  useEffect(() => {
    if (folded !== null || fullRows.length === 0) return;
    const f = defaultFolded(fullRows);
    const target = initialStepId ?? failed?.id ?? null;
    if (target) for (const id of ancestorsOf(fullRows, target)) f.delete(id);
    setFolded(f);
    if (selectedId === null && failed) {
      setSelectedId(failed.id);
      if (initialTab === undefined) setTab("output");
    } else if (initialTab === undefined && initialStepId && failed?.id === initialStepId)
      setTab("output");
  }, [folded, fullRows, failed, initialStepId, selectedId, initialTab]);

  const visible = useMemo(() => visibleRows(rows, folded ?? new Set()), [rows, folded]);
  const selected = flat.find((r) => r.id === selectedId) ?? null;
  const selectedRow =
    (scrubbing ? allRows(rows).find((r) => r.id === selectedId) : selected) ?? selected;

  const side = width >= SIDE_BY_SIDE;
  const compact = width > 0 && width < COMPACT;
  const paneWidth = side ? width - INSPECTOR_PX - 16 : width;
  const trackPx = Math.max(
    160,
    Math.round((Math.max(0, paneWidth) - LABEL_PX - DURATION_PX - 24) * zoom),
  );
  const scale = useMemo(
    () => timeScale({ start, end, width: trackPx, gaps }),
    [start, end, trackPx, gaps],
  );

  const select = useCallback(
    (id: string, focus = false) => {
      setSelectedId(id);
      setFolded((f) => {
        const anc = ancestorsOf(fullRows, id);
        if (!f || anc.every((a) => !f.has(a))) return f;
        const next = new Set(f);
        for (const a of anc) next.delete(a);
        return next;
      });
      if (compact) setPushed(true);
      // While replaying, clicking a step jumps the playhead to its start and dims what follows.
      if (replay !== null) {
        const row = allRows(fullRows).find((r) => r.id === id);
        if (row) setReplay({ t: row.start, how: "jump" });
        setPlaying(false);
      }
      if (focus) {
        requestAnimationFrame(() => {
          gridRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
        });
      }
    },
    [fullRows, replay, compact],
  );

  const toggle = useCallback((id: string, open?: boolean) => {
    setFolded((f) => {
      const next = new Set(f ?? []);
      const isOpen = !next.has(id);
      if (open === undefined ? isOpen : !open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const seek = useCallback(
    (at: number) => {
      const clamped = Math.min(end, Math.max(start, at));
      setPlaying(false);
      setFrameSeq(null);
      setReplay({ t: clamped, how: "scrub" });
    },
    [start, end],
  );

  // The inspector follows the playhead while scrubbing or playing.
  useEffect(() => {
    if (replay === null || replay.how !== "scrub") return;
    const s = stepAtTime(steps, replay.t);
    if (s) setSelectedId(s.id);
  }, [replay, steps]);

  // The replay clock: animation frames at full motion, one event every 600 ms when reduced.
  useEffect(() => {
    if (!playing) return;
    const opts = { end, gaps, skipWaits, stopAtFailures, failures };
    if (reduce) {
      const id = setInterval(() => {
        setReplay((r) => {
          const res = advanceReduced(r?.t ?? start, events, opts);
          if (res.stop) setPlaying(false);
          return { t: res.t, how: "scrub" };
        });
      }, REDUCED_STEP_MS);
      return () => clearInterval(id);
    }
    let last = performance.now();
    let frame = requestAnimationFrame(function loop(ts) {
      const dt = ts - last;
      last = ts;
      let stop = false;
      setReplay((r) => {
        const res = advance(r?.t ?? start, dt, { ...opts, speed });
        stop = res.stop !== null;
        return { t: res.t, how: "scrub" };
      });
      if (stop) setPlaying(false);
      else frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, reduce, end, gaps, skipWaits, stopAtFailures, failures, events, speed, start]);

  const playPause = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Playing from the end (or live) starts over.
    setReplay((r) =>
      r === null || r.t >= end ? { t: start, how: "scrub" } : { ...r, how: "scrub" },
    );
    setPlaying(true);
  }, [playing, start, end]);

  const copyStep = useCallback(() => {
    const s = selected?.step;
    if (!s) return;
    void navigator.clipboard?.writeText(JSON.stringify(s, null, 2));
  }, [selected]);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const action = timelineAction(e, rtl);
    if (action === null) return;
    const i = visible.findIndex((r) => r.id === selectedId);
    const row = i === -1 ? undefined : visible[i];
    const go = (j: number) => {
      const r = visible[Math.min(visible.length - 1, Math.max(0, j))];
      if (r) select(r.id, true);
    };
    switch (action) {
      case "prev":
        go(i - 1);
        break;
      case "next":
        go(i + 1);
        break;
      case "first":
        go(0);
        break;
      case "last":
        go(visible.length - 1);
        break;
      case "fold":
        if (row?.foldable && row.expanded) toggle(row.id, false);
        else if (row && row.level > 0) {
          const parent = ancestorsOf(fullRows, row.id).at(-1);
          if (parent) select(parent, true);
        }
        break;
      case "unfold":
        if (row?.foldable && !row.expanded) toggle(row.id, true);
        else if (row?.foldable) go(i + 1);
        break;
      case "inspect":
        inspectorRef.current?.focus();
        break;
      case "back":
        return;
      case "playPause":
        playPause();
        break;
      case "eventBack": {
        const at = prevEvent(events, replay?.t ?? end);
        if (at !== null) seek(at);
        break;
      }
      case "eventForward": {
        const at = nextEvent(events, replay?.t ?? start);
        if (at !== null) seek(at);
        break;
      }
      case "prevIssue":
      case "nextIssue": {
        const issues = issueRows(fullRows);
        const order = flat.map((r) => r.id);
        const at = order.indexOf(selectedId ?? "");
        const pick =
          action === "nextIssue"
            ? issues.find((r) => order.indexOf(r.id) > at)
            : [...issues].reverse().find((r) => order.indexOf(r.id) < at);
        if (pick) select(pick.id, true);
        break;
      }
      case "copy":
        copyStep();
        break;
      case "zoomIn":
        setZoom((z) => zoomStep(z, 1));
        break;
      case "zoomOut":
        setZoom((z) => zoomStep(z, -1));
        break;
      case "zoomFit":
        setZoom(1);
        break;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Escape in the inspector returns to the step (§3.3); ⌘F finds in the List view.
  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setMode("list");
      requestAnimationFrame(() => searchRef.current?.focus());
      return;
    }
    if (e.key === "Escape" && inspectorRef.current?.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
      if (compact) setPushed(false);
      if (selectedId) select(selectedId, true);
    }
  };

  const doExport = useCallback(
    (format: "psyche-trace+json" | "markdown", includeFrames?: boolean) => {
      void exportTrace(format, includeFrames === undefined ? {} : { includeFrames }).then(
        (res) => {
          if (res.dataBase64) downloadBase64(res.fileName, res.mime, res.dataBase64);
        },
        () => undefined,
      );
    },
    [exportTrace],
  );

  const frameAt = replay?.t ?? end;
  const shownFrame =
    frameSeq ??
    [...frames]
      .filter((f) => (selected?.step ? f.stepId === selected.step.id : true))
      .filter((f) => (ms(f.at) ?? 0) <= frameAt)
      .at(-1)?.seq ??
    null;

  if (run === null) {
    return (
      <div
        ref={(el) => {
          rootRef.current = el;
        }}
        className="flex flex-col gap-2 p-1"
        data-testid="timeline"
      >
        {onBack ? <BackButton onBack={onBack} /> : null}
        {error ? (
          <p role="alert" className="text-body text-label-secondary">
            {t("agent.timeline.loadFailed", { reason: error })}{" "}
            <Button size="xs" variant="outline" onClick={() => reload()}>
              {t("agent.activity.tryAgain")}
            </Button>
          </p>
        ) : (
          <div
            role="status"
            aria-busy={loading}
            aria-label={t("agent.timeline.loading")}
            className="flex flex-col gap-2"
          >
            {Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
              <Skeleton key={i} className="psy-shimmer h-5" style={{ width: `${90 - i * 12}%` }} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const listRows = flat.filter(
    (r) => r.type === "step" && inRange(r, range, now) && matchesQuery(r, query),
  );
  const markers: ScrubberMarker[] = [
    ...failures.map((at) => ({ at, kind: "failed" as const })),
    ...flatSteps
      .filter((s) => s.kind === "approval" || s.kind === "question")
      .map((s) => ({ at: ms(s.startedAt) ?? start, kind: "approval" as const })),
  ];
  const behindLive = running && replay !== null;
  const inspector = (
    <StepInspector
      row={selectedRow}
      runSteps={selectedRow ? (allSteps[selectedRow.runId] ?? steps) : steps}
      tab={tab}
      onTabChange={setTab}
      frames={frames}
      frameSeq={shownFrame}
      onFrameSelect={setFrameSeq}
      image={image}
      now={now}
      retentionDays={retentionDays}
      panelRef={inspectorRef}
      {...links}
    />
  );
  const showInspectorOnly = compact && pushed;
  return (
    <section
      ref={rootRef}
      aria-label={t("agent.timeline.label", { title: runTitle(run) })}
      className="flex min-h-0 flex-1 flex-col gap-3"
      onKeyDown={onRootKey}
      data-testid="timeline"
      data-compact={compact || undefined}
    >
      {childIds.map((id) => (
        <ChildSteps key={id} runId={id} />
      ))}
      <RunHeader
        run={run}
        stepCount={run.stepCount ?? steps.length}
        now={now}
        mode={mode}
        onModeChange={setMode}
        {...(threadTitle ? { threadTitle } : {})}
        {...(onStop ? { onStop } : {})}
        {...(onPause ? { onPause } : {})}
        {...(onRetry ? { onRetry } : {})}
        onExport={doExport}
        {...(onCopyLink ? { onCopyLink: () => onCopyLink(selectedId) } : {})}
        onDelete={() => void deleteTrace()}
        leading={onBack ? <BackButton onBack={onBack} /> : undefined}
      />
      {run.status === "failed" && failed?.step ? (
        <FailureBanner
          step={failed.step}
          {...(onRetry ? { onRetry } : {})}
          {...(onReconnect ? { onReconnect: () => onReconnect(failed.step as RunStep) } : {})}
          onShowStep={() => {
            select(failed.id, true);
            setTab("output");
          }}
        />
      ) : null}
      {range ? (
        <p className="flex items-center gap-2 text-callout text-label-secondary tabular-nums">
          {t("agent.timeline.range", {
            from: formatTime(new Date(range.from).toISOString()),
            to: formatTime(new Date(range.to).toISOString()),
          })}
          <Button size="xs" variant="ghost" onClick={() => setRange(null)}>
            {t("agent.timeline.clearRange")}
          </Button>
        </p>
      ) : null}
      {showInspectorOnly ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Button size="xs" variant="ghost" className="self-start" onClick={() => setPushed(false)}>
            <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />{" "}
            {t("agent.timeline.steps.label")}
          </Button>
          {inspector}
        </div>
      ) : (
        <div className={cn("flex min-h-0 flex-1 gap-4", side ? "flex-row" : "flex-col")}>
          <div className="flex min-h-[12rem] min-w-0 flex-1 flex-col">
            {mode === "list" || compact ? (
              <ListView
                rows={listRows}
                query={query}
                onQueryChange={setQuery}
                selectedId={selectedId}
                onSelect={(id) => select(id)}
                searchRef={searchRef}
                now={now}
              />
            ) : (
              <Waterfall
                rows={visible}
                scale={scale}
                selectedId={selectedId}
                onSelect={(id) => select(id)}
                onToggle={(id) => toggle(id)}
                onKeyDown={onGridKey}
                gridRef={gridRef}
                scrollRef={scrollRef}
                playhead={replay?.t ?? null}
                dimAfter={replay?.how === "jump"}
                onSeek={seek}
                onRange={setRange}
                range={range}
                onZoom={(dir) => setZoom((z) => zoomStep(z, dir))}
                now={now}
                label={t("agent.timeline.steps.label")}
              />
            )}
          </div>
          {compact ? null : (
            <div
              className={cn(
                "flex min-h-0 flex-col",
                side
                  ? "w-[360px] shrink-0 border-s border-separator ps-4"
                  : "max-h-[45%] border-t border-separator pt-3",
              )}
            >
              {inspector}
            </div>
          )}
        </div>
      )}
      <Scrubber
        start={start}
        end={end}
        at={replay?.t ?? end}
        gaps={gaps}
        markers={markers}
        live={running && replay === null}
        behindLive={behindLive}
        playing={playing}
        speed={speed}
        skipWaits={skipWaits}
        stopAtFailures={stopAtFailures}
        onSeek={seek}
        onPlayPause={playPause}
        onSpeed={setSpeed}
        onSkipWaits={setSkipWaits}
        onStopAtFailures={setStopAtFailures}
        onBackToLive={() => {
          setPlaying(false);
          setReplay(null);
        }}
        onPrevEvent={() => {
          const at = prevEvent(events, replay?.t ?? end);
          if (at !== null) seek(at);
        }}
        onNextEvent={() => {
          const at = nextEvent(events, replay?.t ?? start);
          if (at !== null) seek(at);
        }}
        frames={
          frames.length > 0 ? (
            <Thumbs
              runId={runId}
              frames={frames}
              image={image}
              current={shownFrame}
              onSelect={(seq) => {
                const f = frames.find((x) => x.seq === seq);
                const at = ms(f?.at);
                if (at !== null) seek(at);
                setFrameSeq(seq);
                if (f?.stepId) {
                  setSelectedId(f.stepId);
                  setTab("frames");
                }
              }}
            />
          ) : undefined
        }
      />
    </section>
  );
}

function BackButton({ onBack }: { onBack: () => void }): ReactElement {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={t("agent.timeline.back")}
      onClick={onBack}
      className="shrink-0"
    >
      <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
    </Button>
  );
}
