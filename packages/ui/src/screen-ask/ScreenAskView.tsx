import type { Message, ScreenCaptureRefusal, ScreenImageChoice } from "@psyche/protocol";
import { ArrowUp, Ellipsis, ExternalLink, Mic, Square, X } from "lucide-react";
import {
  type FormEvent,
  type PointerEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "../blocks/Markdown.tsx";
import { MessageBlocks } from "../blocks/MessageBlocks.tsx";
import { indexThreadBlocks, ThreadBlocksProvider } from "../blocks/thread-blocks.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { t } from "../i18n/core.ts";
import { type OrbState, ScreenAskOrb } from "./ScreenAskOrb.tsx";

/**
 * The ask panel (docs/design/screen-ask-2026.md, "Redesign: Siri-simple"): one rounded bar with
 * the orb, a small chip with the capture's thumbnail (✕ removes it), one line to type or speak the
 * request, and mic / send. The answer grows downward under the bar and is the chat's own
 * rendering (`MessageBlocks`: cards, artifacts, maps, charts), scrolling past a maximum. The
 * rarely used controls (capture again, select area, always send the screenshot, send to the
 * current chat) sit behind ⋯. Esc closes from anywhere. The window is the desktop's.
 *
 * The surface is opaque (`surface-overlay`, which follows light and dark): the panel floats over
 * any wallpaper, and glass has nothing to refract in a window of its own.
 */

/** Window heights move in steps of this many pixels. */
const HEIGHT_STEP = 8;

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
  /** The agent's messages after the ask, drawn by the chat's block registry. */
  messages: readonly Message[];
  /** Text still arriving; the smooth-streaming buffer reveals it. */
  streamingText?: string;
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

/** What the orb shows: listening, thinking (waiting on the reply), or answering. */
export function orbState(
  p: Pick<ScreenAskViewProps, "dictation" | "answer" | "capture">,
): OrbState {
  const d = p.dictation?.phase;
  if (d === "listening" || d === "finishing") return "listening";
  const a = p.answer;
  if (a !== undefined) {
    if (a.status === "failed" || a.status === "done") return "idle";
    const hasContent = a.messages.length > 0 || (a.streamingText ?? "") !== "";
    return hasContent ? "answering" : "thinking";
  }
  return p.capture?.status === "capturing" ? "thinking" : "idle";
}

/** Within this many px of the bottom the answer keeps following new text. */
const STICK_PX = 48;

function Answer({
  answer,
  onOpen,
}: {
  answer: ScreenAskAnswer;
  onOpen: (() => void) | undefined;
}): ReactElement {
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const index = useMemo(() => indexThreadBlocks(answer.messages), [answer.messages]);
  const streamed = answer.streamingText ?? "";
  const empty = answer.messages.length === 0 && streamed === "";

  // Follow the text while the owner is at the bottom; scrolling up lets go.
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    // Announced once, when the answer is complete: `aria-busy` holds the live region back while it
    // streams, so a reader is not interrupted per chunk.
    <div
      className="psy-ask-in border-separator border-t-[0.5px]"
      aria-live="polite"
      aria-busy={answer.status !== "done" && answer.status !== "failed"}
    >
      {answer.status === "failed" ? (
        <p className="px-4 py-3 text-callout text-label-secondary">
          {t("screenAsk.answer.failed")}
        </p>
      ) : empty ? (
        <p className="sr-only">{t("screenAsk.answer.thinking")}</p>
      ) : (
        <div
          ref={scroll}
          data-testid="screen-ask-answer"
          className="max-h-[420px] overflow-y-auto px-4 py-3 text-reading text-label-primary"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
          }}
        >
          <ThreadBlocksProvider index={index}>
            {answer.messages.map((m) => (
              <MessageBlocks key={m.id} message={m} />
            ))}
          </ThreadBlocksProvider>
          {streamed !== "" ? <Markdown streaming>{streamed}</Markdown> : null}
        </div>
      )}
      {onOpen ? (
        <div className="flex justify-end px-3 pb-3">
          <Button size="sm" variant="outline" onClick={onOpen}>
            <ExternalLink data-icon="inline-start" />
            {t("screenAsk.open")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ScreenAskView(p: ScreenAskViewProps): ReactElement {
  const { capture: c, answer } = p;
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const sent = answer !== undefined;
  const listening = p.dictation?.phase === "listening" || p.dictation?.phase === "finishing";

  useEffect(() => {
    if (!sent) input.current?.focus();
  }, [sent]);

  // The desktop sizes the window to the content. Heights are rounded up to a step, sent at most
  // once per frame and only when they changed, so streaming an answer does not cost an IPC call
  // per token (smoothness-2026 C6).
  const onHeight = p.onHeight;
  useEffect(() => {
    const el = root.current;
    if (!el || !onHeight || typeof ResizeObserver === "undefined") return;
    let last = -1;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const h = Math.ceil(el.getBoundingClientRect().height / HEIGHT_STEP) * HEIGHT_STEP;
      if (h === last) return;
      last = h;
      onHeight(h);
    };
    const ro = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(flush);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [onHeight]);

  // Esc closes from anywhere in the panel's own window, focus or not.
  const onCancel = p.onCancel;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
  const showChip =
    c !== undefined && c.image !== "dropped" && (c.status === "capturing" || c.status === "ready");
  const chipText = c ? chipLabel(c) : "";

  return (
    <div ref={root} className="p-2" data-testid="screen-ask">
      <section
        aria-label={t("screenAsk.label")}
        className="psy-ask-in overflow-hidden rounded-[28px] border-[0.5px] border-separator-strong bg-surface-overlay text-label-primary"
      >
        <form className="flex min-h-14 items-center gap-2.5 py-2 pr-2.5 pl-4" onSubmit={submit}>
          <ScreenAskOrb state={orbState(p)} />
          {showChip && c ? (
            <div
              className="flex h-9 max-w-40 shrink-0 items-center gap-1.5 rounded-lg bg-fill-secondary py-1 pr-1 pl-1 text-xs text-label-secondary"
              data-testid="screen-ask-chip"
              title={chipText}
            >
              {c.thumbnail ? (
                <img
                  src={c.thumbnail}
                  alt=""
                  className="h-7 w-10 shrink-0 rounded-md object-cover"
                />
              ) : c.status === "capturing" ? (
                // The thumbnail's slot is reserved while the capture runs, so the chip keeps its width.
                <Skeleton
                  data-testid="screen-ask-thumb-slot"
                  className="h-7 w-10 shrink-0 rounded-md"
                />
              ) : null}
              <span className="truncate">{chipText}</span>
              {hasCapture && !sent ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("screenAsk.drop")}
                  title={t("screenAsk.drop")}
                  onClick={p.onDrop ?? (() => undefined)}
                >
                  <X />
                </Button>
              ) : null}
            </div>
          ) : null}
          <textarea
            ref={input}
            rows={1}
            className="max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 text-reading text-label-primary outline-none [field-sizing:content] placeholder:text-label-secondary"
            placeholder={p.placeholder ?? t("screenAsk.placeholder")}
            aria-label={t("screenAsk.label")}
            value={listening && p.dictation?.partial ? p.dictation.partial : p.text}
            readOnly={sent || listening}
            onChange={(e) => p.onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
          />
          {!sent ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="rounded-full"
              aria-label={t("common.more")}
              aria-expanded={more}
              onClick={() => setMore((m) => !m)}
            >
              <Ellipsis />
            </Button>
          ) : null}
          {p.dictation && !sent ? (
            <Button
              type="button"
              size="icon"
              variant={listening ? "default" : "ghost"}
              className="rounded-full"
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
            <Button
              type="submit"
              size="icon"
              className="rounded-full"
              aria-label={t("screenAsk.send")}
              disabled={p.text.trim() === "" || listening}
            >
              <ArrowUp />
            </Button>
          ) : null}
        </form>
        {refusal ? (
          <p
            className="flex items-center gap-2 px-4 pb-3 text-xs text-label-secondary"
            role="status"
          >
            {refusal}
            {c?.refusal === "permission_missing" && p.onAllowCapture ? (
              <Button size="xs" variant="outline" onClick={p.onAllowCapture}>
                {t("screenAsk.allowCapture")}
              </Button>
            ) : null}
          </p>
        ) : null}
        {more && !sent ? (
          <div
            className="psy-ask-in flex flex-wrap items-center gap-1.5 px-4 pb-3"
            data-testid="screen-ask-more"
          >
            {c ? (
              <>
                <Button size="sm" variant="secondary" onClick={p.onRecapture ?? (() => undefined)}>
                  {t("screenAsk.recapture")}
                </Button>
                <Button size="sm" variant="secondary" onClick={p.onSelectArea ?? (() => undefined)}>
                  {t("screenAsk.selectArea")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-pressed={c.image === "pinned"}
                  onClick={p.onTogglePin ?? (() => undefined)}
                >
                  {c.image === "pinned" ? t("screenAsk.unpin") : t("screenAsk.pin")}
                </Button>
              </>
            ) : null}
            {(["new", "current"] as const).map((d) => (
              <Button
                key={d}
                size="sm"
                variant={p.destination === d ? "default" : "secondary"}
                aria-pressed={p.destination === d}
                onClick={() => p.onDestination(d)}
              >
                {d === "new" ? t("screenAsk.dest.new") : t("screenAsk.dest.current")}
              </Button>
            ))}
          </div>
        ) : null}
        {answer ? <Answer answer={answer} onOpen={p.onOpen} /> : null}
      </section>
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
