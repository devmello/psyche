import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/blocks/Markdown.tsx";
import { FLUSH_MS, SmoothBuffer } from "../src/lib/smooth-text.ts";

/** Runs the buffer at 60 fps for `ms`, returning the time reached. */
function run(buf: SmoothBuffer, from: number, ms: number): number {
  let now = from;
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    buf.tick(16, now);
  }
  return now;
}

describe("SmoothBuffer", () => {
  it("spreads a fast burst over a bounded catch-up instead of one jump", () => {
    const buf = new SmoothBuffer();
    buf.push("x".repeat(2000));
    buf.tick(16, 16);
    expect(buf.text.length).toBeGreaterThan(0);
    expect(buf.text.length).toBeLessThan(500); // not a single paint
    run(buf, 16, 800);
    expect(buf.idle).toBe(true); // caught up well under a second
  });

  it("shows a slow trickle as it arrives, never holding characters back", () => {
    const buf = new SmoothBuffer();
    let now = 0;
    let text = "";
    for (let i = 0; i < 30; i++) {
      text += "ab"; // 2 chars every 100 ms
      buf.push(text);
      now = run(buf, now, 100);
      expect(buf.backlog).toBe(0);
    }
    expect(buf.text).toBe(text);
  });

  it("flushes the tail within FLUSH_MS of the end of the stream", () => {
    const buf = new SmoothBuffer();
    buf.push("y".repeat(20_000));
    buf.tick(16, 16);
    buf.finish(16);
    run(buf, 16, FLUSH_MS + 32);
    expect(buf.text.length).toBe(20_000);
  });

  it("restarts when the text is not an extension of what was shown", () => {
    const buf = new SmoothBuffer();
    buf.push("hello world");
    buf.flush();
    buf.push("goodbye");
    expect(buf.text).toBe("");
  });

  it("never splits a surrogate pair", () => {
    const buf = new SmoothBuffer();
    buf.push("😀".repeat(100));
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += 16;
      buf.tick(16, now);
      const last = buf.text.charCodeAt(buf.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe("Markdown streaming", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  });
  afterEach(() => vi.useRealTimers());

  it("does not touch finished blocks while the last block grows", async () => {
    const first = "First paragraph, finished.\n\n";
    const { container, rerender } = render(<Markdown streaming>{`${first}Second par`}</Markdown>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const done = container.querySelector("p");
    expect(done?.textContent).toBe("First paragraph, finished.");
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((r) => seen.push(...r));
    if (done)
      observer.observe(done, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    rerender(<Markdown streaming>{`${first}Second paragraph keeps growing and growing`}</Markdown>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    observer.takeRecords();
    expect(container.textContent).toContain("keeps growing and growing");
    expect(container.querySelector("p")).toBe(done);
    expect(seen).toHaveLength(0);
  });

  it("reveals bursty text over frames and ends on the full text", async () => {
    const full = "word ".repeat(300);
    const { container } = render(<Markdown streaming>{full}</Markdown>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect((container.textContent ?? "").length).toBeLessThan(full.length);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe(
      full.replace(/\s+/g, " ").trim(),
    );
  });

  it("shows everything at once under reduced motion", () => {
    document.documentElement.setAttribute("data-reduce-motion", "true");
    try {
      const { container } = render(<Markdown streaming>{"instant text ".repeat(50)}</Markdown>);
      expect(container.textContent?.trim()).toBe("instant text ".repeat(50).trim());
    } finally {
      document.documentElement.removeAttribute("data-reduce-motion");
    }
  });
});
