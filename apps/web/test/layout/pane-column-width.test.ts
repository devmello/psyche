import { describe, expect, it } from "vitest";
import { CHAT_MIN_PX, PANE_MIN_PX, paneColumnWidth } from "../../src/shell/layout/index.ts";

describe("paneColumnWidth", () => {
  it("is the pane share of the content area", () => {
    expect(paneColumnWidth(0.5, 1200)).toBe(600);
    expect(paneColumnWidth(0.6, 1000)).toBe(400);
  });

  it("clamps a saved width larger than the container so the chat keeps its minimum", () => {
    // A fraction saved on a wide window: the pane would take 90% of a 1000 px content area.
    expect(paneColumnWidth(0.1, 1000)).toBe(1000 - CHAT_MIN_PX);
  });

  it("never goes under one pane minimum, nor over the container", () => {
    expect(paneColumnWidth(0.95, 1600)).toBe(PANE_MIN_PX);
    expect(paneColumnWidth(0.5, 300)).toBe(300);
    expect(paneColumnWidth(0.5, 0)).toBe(0);
  });

  it("falls back to the default split for a bad fraction", () => {
    expect(paneColumnWidth(Number.NaN, 1200)).toBe(600);
    expect(paneColumnWidth(0, 1200)).toBe(600);
  });
});
