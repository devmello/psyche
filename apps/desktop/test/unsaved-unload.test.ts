import { describe, expect, it, vi } from "vitest";

const showMessageBoxSync = vi.fn();
vi.mock("electron", () => ({ dialog: { showMessageBoxSync } }));
vi.mock("@psyche/ui/i18n-core", () => ({
  createI18n: () => ({ t: (k: string) => k }),
}));
const { askBeforeUnload, loadUnloadStrings, unloadChoice } = await import(
  "../src/main/unsaved-unload.ts"
);

const words = { ask: "Discard unsaved changes?", discard: "Discard", keep: "Keep editing" };

describe("a reload or quit blocked by unsaved Files edits", () => {
  it("goes ahead when the owner picks Discard", () => {
    expect(unloadChoice(() => 0, words)).toBe(true);
  });
  it("stops when the owner picks Keep editing, which is also Escape", () => {
    const ask = vi.fn(() => 1);
    expect(unloadChoice(ask, words)).toBe(false);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ["Discard", "Keep editing"], cancelId: 1, defaultId: 1 }),
    );
  });
  it("never traps the owner when the words haven't loaded", () => {
    const ask = vi.fn(() => 1);
    expect(unloadChoice(ask, undefined)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("a hidden renderer with unsaved Files edits", () => {
  const probe = async (unsaved: boolean | undefined) => {
    const { HAS_UNSENT_TEXT } = await import("../src/main/release.ts");
    const win = unsaved === undefined ? {} : { psycheUnsavedFiles: () => unsaved };
    return new Function("window", "document", `return ${HAS_UNSENT_TEXT}`)(win, {
      querySelectorAll: () => [],
    }) as boolean;
  };
  it("is kept, even when the draft is for a tab that isn't showing", async () => {
    expect(await probe(true)).toBe(true);
  });
  it("is freed when nothing is unsaved, or on a page without the Files pane", async () => {
    expect(await probe(false)).toBe(false);
    expect(await probe(undefined)).toBe(false);
  });
});

describe("the will-prevent-unload wiring", () => {
  const wire = (win: { isDestroyed: () => boolean; isVisible: () => boolean }) => {
    let listener: ((e: { preventDefault: () => void }) => void) | undefined;
    const contents = { on: (_n: string, fn: typeof listener) => (listener = fn) };
    askBeforeUnload(contents as never, win as never);
    return () => {
      const event = { preventDefault: vi.fn() };
      listener?.(event);
      return event.preventDefault;
    };
  };
  it("lets the unload go ahead on Discard and stops it on Keep editing", async () => {
    loadUnloadStrings(() => "en");
    await new Promise((r) => setTimeout(r, 0));
    const win = { isDestroyed: () => false, isVisible: () => true };
    const fire = wire(win);
    showMessageBoxSync.mockReturnValueOnce(0);
    expect(fire()).toHaveBeenCalled();
    expect(showMessageBoxSync).toHaveBeenLastCalledWith(win, expect.anything());
    showMessageBoxSync.mockReturnValueOnce(1);
    expect(fire()).not.toHaveBeenCalled();
  });
  it("asks without a parent when the window is hidden or gone", () => {
    const fire = wire({ isDestroyed: () => true, isVisible: () => false });
    showMessageBoxSync.mockReturnValueOnce(1);
    fire();
    expect(showMessageBoxSync.mock.lastCall).toHaveLength(1);
  });
});
