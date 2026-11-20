import { describe, expect, it } from "vitest";
import { openLibraryItemAction } from "../../src/shell/ShellApp.tsx";

describe("Library items open in the Files pane's viewer", () => {
  it("names the item by its Library path, the way the Files pane reads a library target", () => {
    expect(openLibraryItemAction({ path: "documents/plan.pdf" })).toEqual({
      type: "open",
      pane: "files",
      target: "library:documents/plan.pdf",
    });
  });
});
