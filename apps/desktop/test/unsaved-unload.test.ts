import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ dialog: { showMessageBoxSync: vi.fn() } }));
const { unloadChoice } = await import("../src/main/unsaved-unload.ts");

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
