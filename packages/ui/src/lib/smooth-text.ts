import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { documentPrefersReducedMotion } from "./reduced-motion.ts";

/**
 * Streaming smoothing. Gateway deltas arrive in bursts (a whole sentence at once, then nothing for
 * 200 ms). Painting them as they come looks like stutter. The buffer instead releases text at a
 * rate that follows the backlog: a trickle shows as it arrives, a burst is spread over a short,
 * bounded catch-up window, and once the stream ends the rest is flushed within `FLUSH_MS`.
 */

/** Time constant of the catch-up (ms): the backlog shrinks by 1 - 1/e every `TAU_MS`. */
export const TAU_MS = 90;
/** After the stream ends, the same constant shrinks so the tail never lags (ms). */
export const FLUSH_TAU_MS = 40;
/** Hard bound on how long a finished stream may keep revealing text (ms). */
export const FLUSH_MS = 250;
/** Floor on the release rate (chars/s), so a long backlog never crawls. */
export const MIN_CPS = 90;

/** Largest end index <= `i` that does not split a surrogate pair. */
function safeEnd(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return Math.max(0, Math.min(i, text.length));
  const c = text.charCodeAt(i - 1);
  return c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}

export class SmoothBuffer {
  private target = "";
  private shown = 0;
  /** Fractional characters carried between frames. */
  private carry = 0;
  private doneAt: number | null = null;

  /** The text to show now. */
  get text(): string {
    return this.target.slice(0, this.shown);
  }

  get backlog(): number {
    return this.target.length - this.shown;
  }

  get idle(): boolean {
    return this.backlog === 0;
  }

  /** Feeds the full text received so far. A text that is not an extension of the last one resets. */
  push(text: string): void {
    if (!text.startsWith(this.target.slice(0, this.shown))) {
      this.shown = 0;
      this.carry = 0;
    }
    this.target = text;
    if (this.shown > text.length) this.shown = text.length;
  }

  /** The stream ended at time `now` (ms): drain on the short flush schedule. */
  finish(now: number): void {
    if (this.doneAt === null) this.doneAt = now;
  }

  /** Shows everything immediately (reduced motion, static content). */
  flush(): void {
    this.shown = this.target.length;
    this.carry = 0;
  }

  /** Advances by `dt` ms at time `now`. Returns true when the visible text changed. */
  tick(dt: number, now: number): boolean {
    const backlog = this.backlog;
    if (backlog === 0) return false;
    if (this.doneAt !== null && now - this.doneAt >= FLUSH_MS) {
      this.flush();
      return true;
    }
    const tau = this.doneAt === null ? TAU_MS : FLUSH_TAU_MS;
    const step = Math.max(backlog * (1 - Math.exp(-dt / tau)), (MIN_CPS * dt) / 1000) + this.carry;
    const whole = Math.min(backlog, Math.floor(step));
    this.carry = step - whole;
    if (whole <= 0) return false;
    this.shown = safeEnd(this.target, this.shown + whole);
    return true;
  }
}

function prefersReduced(): boolean {
  return documentPrefersReducedMotion();
}

/**
 * `text` as it should be painted: while `streaming`, released through a `SmoothBuffer` one
 * animation frame at a time (one React render per frame at most, however many deltas arrive).
 * Not streaming, or under reduced motion: the text itself, instantly.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const buffer = useRef<SmoothBuffer | null>(null);
  if (buffer.current === null) buffer.current = new SmoothBuffer();
  const buf = buffer.current;
  // Once a text has streamed it keeps draining after `streaming` ends (bounded by FLUSH_MS).
  const engaged = useRef(streaming);
  if (streaming) engaged.current = true;
  const instant = !engaged.current || prefersReduced();
  // A message that mounts already complete (history) starts fully shown.
  const [shown, setShown] = useState(() => (instant ? text : ""));
  const raf = useRef<number | null>(null);
  const last = useRef(0);

  // Feed synchronously so the first frame after a delta already knows about it.
  buf.push(text);
  if (instant) buf.flush();

  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    if (wasStreaming.current && !streaming) buf.finish(performance.now());
    wasStreaming.current = streaming;
  }, [streaming, buf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` re-arms the loop on each delta
  useEffect(() => {
    if (instant) {
      setShown(text);
      return;
    }
    if (raf.current !== null || buf.idle) return;
    last.current = performance.now();
    const frame = (now: number) => {
      raf.current = null;
      const dt = Math.min(100, now - last.current);
      last.current = now;
      if (buf.tick(dt, now)) setShown(buf.text);
      if (!buf.idle) raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, [text, instant, buf]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    },
    [],
  );

  return instant ? text : shown;
}
