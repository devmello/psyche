import { describe, expect, it, vi } from "vitest";
import {
  attachNativeGlass,
  glassMode,
  glassWindowOptions,
  NATIVE_GLASS_CSS,
} from "../../src/main/glass.ts";

describe("Liquid Glass spike gate", () => {
  it("is on only for PSYCHE_GLASS=native on macOS", () => {
    expect(glassMode({ PSYCHE_GLASS: "native" }, "darwin")).toBe("native");
    expect(glassMode({ PSYCHE_GLASS: "native" }, "linux")).toBe("off");
    expect(glassMode({ PSYCHE_GLASS: "css" }, "darwin")).toBe("off");
    expect(glassMode({}, "darwin")).toBe("off");
  });

  it("makes the window transparent only when native glass is on", () => {
    expect(glassWindowOptions("native")).toEqual({ transparent: true });
    expect(glassWindowOptions("off")).toEqual({});
  });

  it("clears the sidebar regions and keeps the content column opaque", () => {
    expect(NATIVE_GLASS_CSS).toContain(".rail-slot");
    expect(NATIVE_GLASS_CSS).toContain(".threads-slot");
    expect(NATIVE_GLASS_CSS).toMatch(/\.shell > main \{\s*background: var\(--canvas/);
  });
});

describe("attachNativeGlass", () => {
  const fakeView = () => {
    const wc = {
      insertCSS: vi.fn(async () => ""),
      executeJavaScript: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    return { view: { setBackgroundColor: vi.fn(), webContents: wc }, wc };
  };
  const win = { getNativeWindowHandle: () => Buffer.alloc(8) };

  it("does nothing when the addon is missing or the OS has no glass", async () => {
    const { view, wc } = fakeView();
    expect(await attachNativeGlass(win as never, view as never, async () => null)).toBe(-1);
    const unsupported = { addView: vi.fn(() => 0), isGlassSupported: () => false };
    expect(await attachNativeGlass(win as never, view as never, async () => unsupported)).toBe(-1);
    expect(unsupported.addView).not.toHaveBeenCalled();
    expect(view.setBackgroundColor).not.toHaveBeenCalled();
    expect(wc.insertCSS).not.toHaveBeenCalled();
  });

  it("adds the glass view, clears the view's background and marks the page", async () => {
    const { view, wc } = fakeView();
    const addon = { addView: vi.fn(() => 3), isGlassSupported: () => true };
    expect(await attachNativeGlass(win as never, view as never, async () => addon)).toBe(3);
    expect(addon.addView).toHaveBeenCalledWith(expect.any(Buffer), {});
    expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(wc.insertCSS).toHaveBeenCalledWith(NATIVE_GLASS_CSS);
    expect(wc.executeJavaScript).toHaveBeenCalledWith(
      'document.documentElement.dataset.glass = "native";',
    );
    expect(wc.on).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
  });
});
