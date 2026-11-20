import type { BrowserRecording, BrowserRecordingEvent, LibraryItem } from "@psyche/protocol";
import { Pause, Play } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";

/**
 * Replays an agent browser session (feature I10; `browser.recordings.*`): the recorded screencast
 * frame for the step on show, a scrubber, Play, and the event list. Everything shown was redacted
 * when it was recorded. Event summaries and URLs are page-influenced, so they are rendered as
 * plain text only; a URL is never a link.
 */

/** How long Play stays on each step. */
export const STEP_MS = 1000;

interface Loaded {
  recording: BrowserRecording;
  events: BrowserRecordingEvent[];
  /** Frame seqs in time order, for the nearest-frame lookup. */
  frameSeqs: number[];
}

/** The frame to show for step `i`: its own, else the latest earlier one, else none. */
export function frameFor(events: readonly BrowserRecordingEvent[], i: number): number | null {
  for (let k = Math.min(i, events.length - 1); k >= 0; k--) {
    const seq = events[k]?.frameSeq;
    if (seq !== undefined) return seq;
  }
  return null;
}

export function BrowserRecordingViewer({
  item,
  onClose,
}: {
  item: LibraryItem;
  onClose: () => void;
}): ReactElement {
  const call = useCall();
  const [loaded, setLoaded] = useState<Loaded | "missing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const frames = useRef(new Map<number, string>());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let cursor: string | undefined;
        let found: BrowserRecording | undefined;
        do {
          const page = await call("browser.recordings.list", {
            ...(cursor === undefined ? {} : { cursor }),
          });
          found = page.recordings.find((r) => r.libraryItemId === item.id);
          cursor = found === undefined ? (page.nextCursor ?? undefined) : undefined;
        } while (found === undefined && cursor !== undefined);
        if (found === undefined) {
          if (live) setLoaded("missing");
          return;
        }
        const got = await call("browser.recordings.get", { recordingId: found.id });
        if (live) {
          setLoaded({
            recording: got.recording,
            events: got.events,
            frameSeqs: got.frames.map((f) => f.seq),
          });
        }
      } catch (err) {
        if (live)
          setError(t("screens.library.recording.loadFailed", { reason: describeError(err) }));
      }
    })();
    return () => {
      live = false;
    };
  }, [call, item.id]);

  const data = loaded !== null && loaded !== "missing" ? loaded : null;
  const total = data?.events.length ?? 0;
  const frameSeq = data === null ? null : frameFor(data.events, index);

  // Play steps forward and stops on the last step.
  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex((i) => i + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, total]);

  // Frames load one at a time, on demand, and are kept for this viewer.
  const recordingId = data?.recording.id;
  useEffect(() => {
    if (recordingId === undefined || frameSeq === null) {
      setSrc(null);
      return;
    }
    const hit = frames.current.get(frameSeq);
    if (hit !== undefined) {
      setSrc(hit);
      return;
    }
    let live = true;
    setSrc(null);
    call("browser.recordings.frame", { recordingId, seq: frameSeq }).then(
      (r) => {
        const url = `data:${r.mime};base64,${r.data}`;
        frames.current.set(frameSeq, url);
        if (live) setSrc(url);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [call, recordingId, frameSeq]);

  const current = data?.events[index];
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="recording-viewer"
      >
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>{t("screens.library.recording.description")}</DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-callout text-danger-text">
            {error}
          </p>
        ) : loaded === "missing" ? (
          <p className="text-label-secondary">{t("screens.library.recording.notFound")}</p>
        ) : data === null ? (
          <Skeleton className="h-64 w-full" aria-label={t("screens.library.recording.loading")} />
        ) : total === 0 ? (
          <p className="text-label-secondary">{t("screens.library.recording.empty")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-fill-secondary">
              {src !== null ? (
                <img
                  src={src}
                  alt={t("screens.library.recording.frameAlt", { n: index + 1 })}
                  className="max-h-[50vh] w-full object-contain"
                />
              ) : (
                <p className="p-6 text-label-secondary">{t("screens.library.recording.noFrame")}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!playing && index >= total - 1) setIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                {playing
                  ? t("screens.library.recording.pause")
                  : t("screens.library.recording.play")}
              </Button>
              <input
                type="range"
                min={0}
                max={total - 1}
                value={index}
                aria-label={t("screens.library.recording.scrub")}
                aria-valuetext={t("screens.library.recording.step", { n: index + 1, total })}
                className="min-w-0 flex-1"
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
              />
              <span className="text-callout text-label-secondary tabular-nums">
                {t("screens.library.recording.step", { n: index + 1, total })}
              </span>
            </div>
            {current?.url ? (
              <p className="truncate text-callout text-label-secondary">{current.url}</p>
            ) : null}
            <h3 className="text-headline">{t("screens.library.recording.steps")}</h3>
            <ol className="flex max-h-56 flex-col overflow-y-auto">
              {data.events.map((e, i) => (
                <li key={e.seq}>
                  <button
                    type="button"
                    aria-current={i === index ? "step" : undefined}
                    className={cn(
                      "flex w-full items-baseline gap-3 rounded-sm px-2 py-1 text-left hover:bg-fill-secondary",
                      i === index && "bg-fill-secondary",
                    )}
                    onClick={() => {
                      setPlaying(false);
                      setIndex(i);
                    }}
                  >
                    <span className="shrink-0 text-callout text-label-tertiary tabular-nums">
                      {formatTime(e.at)}
                    </span>
                    <span className="min-w-0 break-words">{e.summary}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
