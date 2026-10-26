// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  desktopScreenReader,
  SCREEN_READER_HOLD_MS,
  type ScreenReaderSource,
  watchScreenReader,
} from "../../src/shell/screen-reader.ts";

/** VoiceOver ducking (voice-mode-2026 §4.10): inferred from focus moves and live-region updates. */

function setup(initiallyOn = true) {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const speaking: boolean[] = [];
  let change: (on: boolean) => void = () => {};
  const source: ScreenReaderSource = {
    isOn: async () => initiallyOn,
    onChange: (cb) => {
      change = cb;
      return () => {
        change = () => {};
      };
    },
  };
  const stop = watchScreenReader({
    source,
    onSpeaking: (s) => speaking.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length + 1 };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { speaking, timers, stop, settle, change: (on: boolean) => change(on) };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("watchScreenReader", () => {
  it("ducks on a focus move and releases after the hold", async () => {
    document.body.innerHTML = '<button id="b">Send</button>';
    const w = setup();
    await w.settle();
    (document.getElementById("b") as HTMLElement).focus();
    expect(w.speaking).toEqual([true]);
    expect(w.timers.at(-1)?.ms).toBe(SCREEN_READER_HOLD_MS);
    w.timers.splice(0)[0]?.fn();
    expect(w.speaking).toEqual([true, false]);
    w.stop();
  });

  it("ducks on a live-region update, not on other changes, and stays ducked through a run", async () => {
    document.body.innerHTML = '<p role="status" id="s">Listening</p><div id="plain">x</div>';
    const w = setup();
    await w.settle();
    (document.getElementById("plain") as HTMLElement).textContent = "changed";
    await w.settle();
    expect(w.speaking).toEqual([]);
    (document.getElementById("s") as HTMLElement).textContent = "Speaking";
    await w.settle();
    (document.getElementById("s") as HTMLElement).textContent = "Thinking";
    await w.settle();
    // One duck, one pending release: the second update restarted the hold.
    expect(w.speaking).toEqual([true]);
    expect(w.timers).toHaveLength(1);
    w.stop();
  });

  it("watches nothing while no screen reader runs, follows it on and off, and releases on stop", async () => {
    document.body.innerHTML = '<button id="b">Send</button>';
    const w = setup(false);
    await w.settle();
    (document.getElementById("b") as HTMLElement).focus();
    expect(w.speaking).toEqual([]);
    w.change(true);
    (document.getElementById("b") as HTMLElement).blur();
    (document.getElementById("b") as HTMLElement).focus();
    expect(w.speaking).toEqual([true]);
    // The screen reader quitting mid-duck releases it at once.
    w.change(false);
    expect(w.speaking).toEqual([true, false]);
    w.change(true);
    (document.getElementById("b") as HTMLElement).blur();
    (document.getElementById("b") as HTMLElement).focus();
    w.stop();
    expect(w.speaking.at(-1)).toBe(false);
  });

  it("reads VoiceOver from the desktop bridge, and is absent in a browser", async () => {
    expect(desktopScreenReader()).toBeUndefined();
    let push: (e: unknown) => void = () => {};
    (globalThis as { psyche?: unknown }).psyche = {
      voice: {
        screenReader: async () => true,
        onSystem: (cb: (e: unknown) => void) => {
          push = cb;
          return () => {};
        },
      },
    };
    try {
      const source = desktopScreenReader() as ScreenReaderSource;
      expect(await source.isOn()).toBe(true);
      const seen: boolean[] = [];
      source.onChange((on) => seen.push(on));
      push({ event: "lock" });
      push({ event: "screenReader", on: false });
      push({ event: "screenReader", on: true });
      expect(seen).toEqual([false, true]);
    } finally {
      delete (globalThis as { psyche?: unknown }).psyche;
    }
  });
});
