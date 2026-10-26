import type { ScreenCaptureRefusal, ScreenImageChoice } from "@psyche/protocol";
import { Crop, ExternalLink, Mic, Pin, PinOff, RotateCw, Square, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Markdown } from "../blocks/Markdown.tsx";
import { GlassSurface } from "../components/glass-surface.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * The ask panel (docs/design/screen-ask-2026.md §2–§4): a chip with the capture's thumbnail
 * (✕ drops it, the pin always sends the image, ↻ captures again, the crop button selects an
 * area), one line to type or speak the request, where it goes, and the answer streaming in below
 * with Open in Psyche. Esc closes from anywhere in the panel. The window is the desktop's.
 */

export interface ScreenAskCaptureView {
  status: "capturing" | "ready" | "none" | "failed";
  mode: "window" | "region";
  thumbnail: string | null;
  appName: string | null;
  refusal?: ScreenCaptureRefusal;
  image: ScreenImageChoice;
}

export interface ScreenAskDictation {
  phase: "idle" | "starting" | "listening" | "finishing" | "unavailable";
  partial?: string;
  reason?: string;
  toggle: () => void;
}

export interface ScreenAskAnswer {
  status: "sending" | "streaming" | "done" | "failed";
  text: string;
}

export interface ScreenAskViewProps {
  /** Absent for voice mode: no screen context, so no chip and no capture controls. */
  capture?: ScreenAskCaptureView;
  /** Overrides the input placeholder (voice mode asks anything, not only about the screen). */
  placeholder?: string;
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDrop?: () => void;
  onTogglePin?: () => void;
  onRecapture?: () => void;
  onSelectArea?: () => void;
  /** Opens Screen Recording in System Settings (only with `permission_missing`). */
  onAllowCapture?: () => void;
  destination: "new" | "current";
  onDestination: (d: "new" | "current") => void;
  dictation?: ScreenAskDictation;
  answer?: ScreenAskAnswer;
  onOpen?: () => void;
  /** The panel's content height changed (the desktop resizes the window to fit). */
  onHeight?: (px: number) => void;
}

function chipLabel(c: ScreenAskCaptureView): string {
  const app = c.appName ?? "";
  if (c.status === "capturing") return t("screenAsk.capturing");
  if (c.status === "none" || c.status === "failed" || !app) return t("screenAsk.chip.none");
  if (c.thumbnail === null) return t("screenAsk.chip.textOnly", { app });
  return c.mode === "region"
    ? t("screenAsk.chip.region", { app })
    : t("screenAsk.chip.window", { app });
}

export function ScreenAskView(p: ScreenAskViewProps): ReactElement {
  const { capture: c, answer } = p;
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sent = answer !== undefined;
  const listening = p.dictation?.phase === "listening" || p.dictation?.phase === "finishing";

  useEffect(() => {
    if (!sent) input.current?.focus();
  }, [sent]);

  // The desktop sizes the window to the content.
  const onHeight = p.onHeight;
  useEffect(() => {
    const el = root.current;
    if (!el || !onHeight || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onHeight(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      p.onCancel();
    }
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (p.text.trim() !== "") p.onSubmit();
  };
  const refusal =
    c === undefined
      ? null
      : c.refusal === undefined
        ? c.status === "failed"
          ? t("screenAsk.captureFailed")
          : null
        : t(`screenAsk.refusal.${c.refusal}`, { app: c.appName ?? "" });
  const hasCapture = c?.status === "ready";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the panel closes it
    <div ref={root} className="p-2" onKeyDown={onKeyDown} data-testid="screen-ask">
      <GlassSurface impl="refraction" radius={20} as="section" aria-label={t("screenAsk.label")}>
        <div className="flex flex-col gap-2 p-3">
          {c ? (
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-md bg-fill-quaternary py-1 pr-1 pl-1 text-xs text-label-secondary",
                  c.image === "dropped" && "opacity-50",
                )}
                data-testid="screen-ask-chip"
              >
                {c.thumbnail ? (
                  <img src={c.thumbnail} alt="" className="h-8 w-12 rounded-sm object-cover" />
                ) : null}
                <span className="truncate">{chipLabel(c)}</span>
                {hasCapture && c.thumbnail && c.image !== "dropped" ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-pressed={c.image === "pinned"}
                    aria-label={c.image === "pinned" ? t("screenAsk.unpin") : t("screenAsk.pin")}
                    title={c.image === "pinned" ? t("screenAsk.unpin") : t("screenAsk.pin")}
                    onClick={p.onTogglePin ?? (() => undefined)}
                    disabled={sent}
                  >
                    {c.image === "pinned" ? <Pin /> : <PinOff />}
                  </Button>
                ) : null}
                {hasCapture && c.image !== "dropped" ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("screenAsk.drop")}
                    title={t("screenAsk.drop")}
                    onClick={p.onDrop ?? (() => undefined)}
                    disabled={sent}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("screenAsk.recapture")}
                  title={t("screenAsk.recapture")}
                  onClick={p.onRecapture ?? (() => undefined)}
                  disabled={sent || c.status === "capturing"}
                >
                  <RotateCw />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("screenAsk.selectArea")}
                  title={t("screenAsk.selectArea")}
                  onClick={p.onSelectArea ?? (() => undefined)}
                  disabled={sent}
                >
                  <Crop />
                </Button>
              </div>
            </div>
          ) : null}
          {refusal ? (
            <p className="flex items-center gap-2 text-xs text-label-secondary" role="status">
              {refusal}
              {c?.refusal === "permission_missing" && p.onAllowCapture ? (
                <Button size="xs" variant="outline" onClick={p.onAllowCapture}>
                  {t("screenAsk.allowCapture")}
                </Button>
              ) : null}
            </p>
          ) : null}
          <form className="flex items-end gap-2" onSubmit={submit}>
            <textarea
              ref={input}
              rows={1}
              className="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm text-label-primary outline-none placeholder:text-label-tertiary"
              placeholder={p.placeholder ?? t("screenAsk.placeholder")}
              aria-label={t("screenAsk.label")}
              value={listening && p.dictation?.partial ? p.dictation.partial : p.text}
              readOnly={sent || listening}
              onChange={(e) => p.onText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
              }}
            />
            {p.dictation && !sent ? (
              <Button
                type="button"
                size="icon-sm"
                variant={listening ? "default" : "ghost"}
                aria-pressed={listening}
                aria-label={listening ? t("screenAsk.mic.stop") : t("screenAsk.mic.start")}
                title={p.dictation.phase === "unavailable" ? p.dictation.reason : undefined}
                disabled={p.dictation.phase === "unavailable"}
                onClick={p.dictation.toggle}
              >
                {listening ? <Square /> : <Mic />}
              </Button>
            ) : null}
            {!sent ? (
              <Button type="submit" size="sm" disabled={p.text.trim() === "" || listening}>
                {t("screenAsk.send")}
              </Button>
            ) : null}
          </form>
          {!sent ? (
            <div className="flex items-center gap-2 text-xs text-label-tertiary">
              <span>{t("screenAsk.dest.label")}</span>
              {(["new", "current"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={p.destination === d}
                  className={cn(
                    "rounded-sm px-1.5 py-0.5",
                    p.destination === d
                      ? "bg-fill-secondary text-label-primary"
                      : "hover:bg-fill-quaternary",
                  )}
                  onClick={() => p.onDestination(d)}
                >
                  {d === "new" ? t("screenAsk.dest.new") : t("screenAsk.dest.current")}
                </button>
              ))}
              <span className="ml-auto">{t("screenAsk.cancelHint")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="max-h-56 overflow-y-auto text-sm">
                {answer.status === "failed" ? (
                  <p className="text-label-secondary">{t("screenAsk.answer.failed")}</p>
                ) : answer.text === "" ? (
                  <p className="text-label-tertiary">{t("screenAsk.answer.thinking")}</p>
                ) : (
                  <Markdown streaming={answer.status === "streaming"}>{answer.text}</Markdown>
                )}
              </div>
              {p.onOpen ? (
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={p.onOpen}>
                    <ExternalLink data-icon="inline-start" />
                    {t("screenAsk.open")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </GlassSurface>
    </div>
  );
}

type Box = { x: number; y: number; width: number; height: number };

export interface ScreenAskRegionViewProps {
  /** The dragged box in CSS px of the overlay, or null (Esc, or a click without a drag). */
  onDone: (rect: Box | null) => void;
}

/** The region overlay: dims the display; drag a box, release to capture it, Esc to keep the window. */
export function ScreenAskRegionView({ onDone }: ScreenAskRegionViewProps): ReactElement {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  const at = (e: PointerEvent<HTMLDivElement>) => ({ x: e.clientX, y: e.clientY });
  const toBox = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="application"
      aria-label={t("screenAsk.region.label")}
      data-testid="screen-ask-region"
      className="fixed inset-0 cursor-crosshair bg-black/30 outline-none select-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone(null);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setStart(at(e));
        setBox(null);
      }}
      onPointerMove={(e) => {
        if (start) setBox(toBox(start, at(e)));
      }}
      onPointerUp={(e) => {
        if (!start) return;
        const b = toBox(start, at(e));
        setStart(null);
        onDone(b.width >= 8 && b.height >= 8 ? b : null);
      }}
    >
      <p className="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm text-white">
        {t("screenAsk.region.hint")}
      </p>
      {box ? (
        <div
          className="pointer-events-none absolute border-2 border-white bg-white/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      ) : null}
    </div>
  );
}
