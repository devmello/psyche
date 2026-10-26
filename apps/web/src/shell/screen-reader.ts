/**
 * VoiceOver ducking (docs/voice/voice-mode-2026.md §4.10): while a screen reader is running and
 * speaks, Psyche's own voice drops to a duck so the two aren't heard over each other.
 *
 * Nothing reports when VoiceOver speaks, so it is inferred from what makes it speak: focus moving
 * and a live region (`aria-live`, `status`, `alert`, `log`) changing. Each such event ducks for
 * `holdMs`, and a run of them keeps it ducked. With no screen reader running, nothing is watched.
 */

/** The reply's volume while the screen reader is talking. */
export const SCREEN_READER_DUCK_VOLUME = 0.2;
/** A focus move or live-region update is read within about this long. */
export const SCREEN_READER_HOLD_MS = 1500;

/** Whether a screen reader is running, and when that changes (the desktop's accessibility flag). */
export interface ScreenReaderSource {
  isOn(): Promise<boolean>;
  onChange(cb: (on: boolean) => void): () => void;
}

const LIVE = '[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]';

export interface ScreenReaderDuckOptions {
  source: ScreenReaderSource;
  /** True while the screen reader is probably speaking. */
  onSpeaking: (speaking: boolean) => void;
  doc?: Document;
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** Starts watching; returns a stop that also releases the duck. */
export function watchScreenReader(o: ScreenReaderDuckOptions): () => void {
  const doc = o.doc ?? document;
  const holdMs = o.holdMs ?? SCREEN_READER_HOLD_MS;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let on = false;
  let timer: unknown = null;
  let speaking = false;
  let stopped = false;

  const set = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    o.onSpeaking(next);
  };
  const heard = () => {
    if (!on || stopped) return;
    set(true);
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      set(false);
    }, holdMs);
  };
  const release = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    set(false);
  };

  const onFocus = () => heard();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      if (el?.closest(LIVE)) {
        heard();
        return;
      }
    }
  });
  const attach = () => {
    doc.addEventListener("focusin", onFocus, true);
    observer.observe(doc.body, { childList: true, characterData: true, subtree: true });
  };
  const detach = () => {
    doc.removeEventListener("focusin", onFocus, true);
    observer.disconnect();
    release();
  };
  const apply = (next: boolean) => {
    if (stopped || next === on) return;
    on = next;
    if (on) attach();
    else detach();
  };

  void o.source.isOn().then(apply, () => undefined);
  const off = o.source.onChange(apply);
  return () => {
    stopped = true;
    off();
    detach();
  };
}

/** The desktop bridge's screen reader state (`window.psyche.voice`), when running in Psyche.app. */
export function desktopScreenReader(): ScreenReaderSource | undefined {
  const voice = (
    globalThis as {
      psyche?: {
        voice?: {
          screenReader?: () => Promise<unknown>;
          onSystem?: (cb: (e: unknown) => void) => () => void;
        };
      };
    }
  ).psyche?.voice;
  if (!voice?.screenReader || !voice.onSystem) return undefined;
  const { screenReader, onSystem } = voice;
  return {
    isOn: async () => (await screenReader()) === true,
    onChange: (cb) =>
      onSystem((e) => {
        const ev = e as { event?: string; on?: boolean } | null;
        if (ev?.event === "screenReader") cb(ev.on === true);
      }),
  };
}

/**
 * Ducks the terminal's reply while the desktop's screen reader speaks; a no-op in a browser or
 * without a bridge. Returns the stop.
 */
export function duckForScreenReader(
  terminal: { setScreenReaderSpeaking(speaking: boolean): void },
  source: ScreenReaderSource | undefined = desktopScreenReader(),
): () => void {
  if (!source) return () => {};
  return watchScreenReader({ source, onSpeaking: (s) => terminal.setScreenReaderSpeaking(s) });
}
