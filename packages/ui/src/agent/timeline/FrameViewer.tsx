import type { MethodResult, RunFrame, RunStep } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import { Filmstrip } from "../../components/filmstrip.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { t } from "../../i18n/core.ts";
import { formatTime } from "../../lib/format.ts";
import { stepLabel } from "./model.ts";

/**
 * What Psyche saw (docs/design/run-trace-2026.md §3.4): the frame at full size with the action
 * over it (the step's label and target as a caption, the frame's time), and the step's filmstrip.
 * Frames are lazy: thumbnails at 96 px, the full frame only when shown. Secure fields were masked
 * at write time.
 */

export type FrameImage = (
  seq: number,
  size: "thumb" | "full",
) => Promise<MethodResult<"runs.frame">>;

const cache = new Map<string, string>();

/** A frame as a data URL, loaded once per run, seq and size. */
export function useFrameSrc(
  runId: string,
  image: FrameImage,
  seq: number | null,
  size: "thumb" | "full",
  skip = false,
): string | null {
  const key = seq === null ? null : `${runId}/${seq}/${size}`;
  const [src, setSrc] = useState<string | null>(key === null ? null : (cache.get(key) ?? null));
  useEffect(() => {
    if (key === null || seq === null || skip) {
      setSrc(null);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setSrc(hit);
      return;
    }
    let live = true;
    setSrc(null);
    image(seq, size).then(
      (r) => {
        const url = `data:${r.mime};base64,${r.dataBase64}`;
        cache.set(key, url);
        if (live) setSrc(url);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key, seq, size, image, skip]);
  return src;
}

export function Thumbs({
  runId,
  frames,
  image,
  current,
  onSelect,
}: {
  runId: string;
  frames: readonly RunFrame[];
  image: FrameImage;
  current: number | null;
  onSelect: (seq: number) => void;
}): ReactElement {
  const [srcs, setSrcs] = useState<Record<number, string>>({});
  useEffect(() => {
    let live = true;
    for (const f of frames) {
      if (f.expired) continue;
      const key = `${runId}/${f.seq}/thumb`;
      const hit = cache.get(key);
      if (hit) {
        setSrcs((s) => (s[f.seq] ? s : { ...s, [f.seq]: hit }));
        continue;
      }
      image(f.seq, "thumb").then(
        (r) => {
          const url = `data:${r.mime};base64,${r.dataBase64}`;
          cache.set(key, url);
          if (live) setSrcs((s) => ({ ...s, [f.seq]: url }));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [runId, frames, image]);
  return (
    <Filmstrip
      frames={frames.map((f) => ({
        seq: f.seq,
        at: f.at,
        ...(srcs[f.seq] ? { src: srcs[f.seq] } : {}),
      }))}
      {...(current === null ? {} : { current })}
      onSelect={onSelect}
    />
  );
}

export interface FrameViewerProps {
  runId: string;
  step: RunStep | null;
  /** The step's frames (or the run's, when no step is chosen). */
  frames: readonly RunFrame[];
  image: FrameImage;
  /** The frame to show: the newest at or before the playhead, or the step's last. */
  seq: number | null;
  onSelect: (seq: number) => void;
  retentionDays?: number;
}

export function FrameViewer({
  runId,
  step,
  frames,
  image,
  seq,
  onSelect,
  retentionDays = 7,
}: FrameViewerProps): ReactElement {
  const frame = frames.find((f) => f.seq === seq) ?? frames.at(-1) ?? null;
  const expired = frame?.expired === true;
  const src = useFrameSrc(runId, image, frame?.seq ?? null, "full", expired);
  if (frame === null) {
    return <p className="text-body text-label-secondary">{t("agent.timeline.frames.none")}</p>;
  }
  const caption = step
    ? step.target
      ? t("agent.timeline.frame.caption", { label: stepLabel(step), target: step.target })
      : stepLabel(step)
    : null;
  return (
    <div className="flex flex-col gap-2" data-testid="frame-viewer">
      <figure className="flex flex-col gap-1">
        <div
          className="relative w-full overflow-hidden rounded-md bg-fill-tertiary"
          style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
        >
          {expired ? (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-callout text-label-secondary">
              {t("agent.timeline.expired", { days: retentionDays })}
            </p>
          ) : src ? (
            <img
              src={src}
              alt={t("agent.timeline.frame.label", { seq: frame.seq, time: formatTime(frame.at) })}
              className="size-full object-contain"
            />
          ) : (
            <Skeleton className="absolute inset-0" aria-label={t("agent.timeline.frame.loading")} />
          )}
          {caption && !expired ? (
            <span className="absolute inset-x-2 bottom-2 truncate rounded-sm bg-black/60 px-2 py-1 text-callout text-white">
              {caption}
            </span>
          ) : null}
        </div>
        <figcaption className="text-subheadline text-label-tertiary tabular-nums">
          {t("agent.timeline.frame.label", { seq: frame.seq, time: formatTime(frame.at) })}
        </figcaption>
      </figure>
      {frames.length > 1 ? (
        <Thumbs
          runId={runId}
          frames={frames}
          image={image}
          current={frame.seq}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}
