import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";
import { checkLibraryReveal, revealLibraryItem } from "../src/lib/library-reveal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A home with `library/` holding one file, and a secret file outside the Library. */
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "psyche-desk-reveal-")));
  dirs.push(home);
  const root = join(home, "library");
  mkdirSync(join(root, "documents"), { recursive: true });
  writeFileSync(join(root, "documents", "plan.pdf"), "x");
  writeFileSync(join(home, "secret.txt"), "outside");
  return { home, root };
}

const item = (path: unknown) => ({ item: { id: "lib_1", path } });

describe("Reveal in Finder takes an item id and nothing else", () => {
  it("accepts a Library item id", () => {
    expect(checkLibraryReveal({ itemId: "lib_invoice_download" })).toEqual({
      itemId: "lib_invoice_download",
    });
  });

  it("rejects a path, a traversal, an empty id and anything else in place of an id", () => {
    for (const bad of [
      null,
      {},
      { path: "/Users/me/a.pdf" },
      { itemId: "" },
      { itemId: "../secret" },
      { itemId: "/etc/passwd" },
      { itemId: "a b" },
      { itemId: 7 },
    ])
      expect(() => checkLibraryReveal(bad), JSON.stringify(bad)).toThrow();
  });

  it("is refused in a window of a remote Gateway, which has no Library on this Mac", () => {
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.libraryReveal)).toBe(true);
  });
});

describe("revealLibraryItem", () => {
  it("reveals the item's file, found by the Gateway's Library-relative path", async () => {
    const { root } = fixture();
    const showItemInFolder = vi.fn();
    const result = await revealLibraryItem("lib_1", {
      getItem: async () => item("documents/plan.pdf"),
      libraryRoot: root,
      showItemInFolder,
    });
    expect(result).toBe("file");
    expect(showItemInFolder).toHaveBeenCalledWith(join(root, "documents", "plan.pdf"));
  });

  it("reveals nothing for a path that climbs out of the Library", async () => {
    const { root, home } = fixture();
    const showItemInFolder = vi.fn();
    const result = await revealLibraryItem("lib_1", {
      getItem: async () => item("../secret.txt"),
      libraryRoot: root,
      showItemInFolder,
    });
    expect(result).toBe("none");
    expect(showItemInFolder).not.toHaveBeenCalledWith(join(home, "secret.txt"));
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals nothing for a link inside the Library that points outside it", async () => {
    const { root, home } = fixture();
    symlinkSync(join(home, "secret.txt"), join(root, "link.txt"));
    const showItemInFolder = vi.fn();
    const result = await revealLibraryItem("lib_1", {
      getItem: async () => item("link.txt"),
      libraryRoot: root,
      showItemInFolder,
    });
    expect(result).toBe("none");
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals nothing for a file that is no longer there, or a folder", async () => {
    const { root } = fixture();
    const showItemInFolder = vi.fn();
    for (const path of ["documents/gone.pdf", "documents"]) {
      const result = await revealLibraryItem("lib_1", {
        getItem: async () => item(path),
        libraryRoot: root,
        showItemInFolder,
      });
      expect(result, path).toBe("none");
    }
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals nothing when the Gateway has no such item", async () => {
    const { root } = fixture();
    const showItemInFolder = vi.fn();
    await expect(
      revealLibraryItem("lib_1", {
        getItem: async () => ({ item: null }),
        libraryRoot: root,
        showItemInFolder,
      }),
    ).rejects.toThrow();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
