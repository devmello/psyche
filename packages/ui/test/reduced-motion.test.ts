import { afterEach, describe, expect, it } from "vitest";
import { documentPrefersReducedMotion, smoothScrollBehavior } from "../src/lib/reduced-motion.ts";

describe("documentPrefersReducedMotion", () => {
  afterEach(() => document.documentElement.removeAttribute("data-reduce-motion"));

  it("follows the resolved data-reduce-motion attribute over the OS query", () => {
    document.documentElement.setAttribute("data-reduce-motion", "true");
    expect(documentPrefersReducedMotion()).toBe(true);
    document.documentElement.setAttribute("data-reduce-motion", "false");
    expect(documentPrefersReducedMotion()).toBe(false);
  });

  it("is false without a setting or matchMedia", () => {
    expect(documentPrefersReducedMotion()).toBe(false);
  });
});

describe("smoothScrollBehavior", () => {
  afterEach(() => document.documentElement.removeAttribute("data-reduce-motion"));

  it("scrolls smoothly, and instantly under reduced motion", () => {
    expect(smoothScrollBehavior()).toBe("smooth");
    document.documentElement.setAttribute("data-reduce-motion", "true");
    expect(smoothScrollBehavior()).toBe("auto");
  });
});
