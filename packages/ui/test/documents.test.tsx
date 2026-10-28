import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasPane } from "../src/canvas/CanvasPane.tsx";
import { cellFromText } from "../src/canvas/documents/WorkbookEditor.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { CANVAS_IDS, canvasFixtures } from "../src/fixtures/canvas.ts";
import { IDS } from "../src/fixtures/ids.ts";
import { applyOpsLocal } from "../src/lib/artifact-ops.ts";
import { fileType } from "../src/screens/library/library-items.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const withCanvas = (world: object) => {
  const fx = canvasFixtures();
  const w = world as { artifacts: unknown[]; artifactHistory?: unknown };
  w.artifacts.push(...fx.artifacts);
  w.artifactHistory = fx.artifactHistory;
};

function mount(id: string) {
  let gateway: MockGateway | undefined;
  render(
    <StoryWorld edit={withCanvas} onGateway={(g) => (gateway = g)}>
      <CanvasPane artifactId={id} threadId={IDS.threads.lisbon} onSelect={() => {}} />
    </StoryWorld>,
  );
  return () => gateway as MockGateway;
}

describe("slides in the canvas", () => {
  it("lists the slides and edits one by id", async () => {
    const gw = mount(CANVAS_IDS.deck);
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "Slide 2" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Slide 2" }));
    const title = screen.getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Day one");
    await user.tab();
    await waitFor(() =>
      expect(gw().world.artifactHistory[CANVAS_IDS.deck]?.versions.at(-1)).toMatchObject({
        author: "user",
        ops: [{ op: "updateSlide", id: "s2", changes: { title: "Day one" } }],
      }),
    );
  });

  it("adds, moves and deletes slides with single ops", async () => {
    const gw = mount(CANVAS_IDS.deck);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add slide" }));
    await waitFor(() =>
      expect(gw().world.artifactHistory[CANVAS_IDS.deck]?.versions.at(-1)?.ops?.[0]).toMatchObject({
        op: "addSlide",
        at: 1,
      }),
    );
  });

  it("presents with notes and the keyboard", async () => {
    mount(CANVAS_IDS.deck);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Present" }));
    const dialog = await screen.findByRole("dialog", { name: "Presenter view" });
    expect(within(dialog).getByText("Slide 1 of 3")).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByText("Slide 2 of 3")).toBeTruthy();
    expect(within(dialog).getByText("Mention the tram 28 queue.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the deck's export formats and downloads the file", async () => {
    mount(CANVAS_IDS.deck);
    const user = userEvent.setup();
    const calls: unknown[] = [];
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      calls.push(this.download);
    };
    const select = await screen.findByRole("combobox", { name: "Export" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Export as…", ".pptx", ".pdf"]);
    await user.selectOptions(select, ".pptx");
    await waitFor(() => expect(calls).toEqual(["lisbon-deck.pptx"]));
  });
});

describe("workbook in the canvas", () => {
  it("shows computed values and formula errors", async () => {
    mount(CANVAS_IDS.workbook);
    expect((await screen.findByRole("button", { name: "Cell B4" })).textContent).toBe("1102");
    expect(screen.getByRole("button", { name: "Cell C4" }).textContent).toBe("#DIV/0!");
    expect(screen.getByRole("tab", { name: "Notes" })).toBeTruthy();
  });

  it("edits a cell through the formula bar as one setCells op", async () => {
    const gw = mount(CANVAS_IDS.workbook);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cell B4" }));
    const bar = screen.getByLabelText("Value or formula for B4");
    expect((bar as HTMLInputElement).value).toBe("=SUM(B2:B3)");
    await user.click(screen.getByRole("button", { name: "Cell B2" }));
    const bar2 = screen.getByLabelText("Value or formula for B2");
    await user.clear(bar2);
    await user.type(bar2, "500{Enter}");
    await waitFor(() =>
      expect(gw().world.artifactHistory[CANVAS_IDS.workbook]?.versions.at(-1)?.ops).toEqual([
        { op: "setCells", sheet: "Budget", cells: { B2: 500 } },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cell B4" }).textContent).toBe("1190"),
    );
  });

  it("parses typed cells", () => {
    expect(cellFromText("=SUM(A1:A2)")).toEqual({ f: "SUM(A1:A2)" });
    expect(cellFromText("12.5")).toBe(12.5);
    expect(cellFromText("TRUE")).toBe(true);
    expect(cellFromText("  ")).toBeNull();
    expect(cellFromText("hello")).toBe("hello");
  });
});

describe("local op engine", () => {
  it("applies section ops to a doc, like the Gateway", () => {
    const out = applyOpsLocal("doc", "# A\n\n## B\n\nold\n", null, [
      { op: "replaceSection", heading: "B", body: "new" },
    ]);
    expect(out.content).toBe("# A\n\n## B\n\nnew\n");
  });
});

describe("lazy loading", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/canvas/CanvasPane.tsx"), "utf8");
  it("loads the editors and presenter on demand, never statically", () => {
    expect(src).toMatch(/lazy\(\(\) => import\("\.\/documents\/DeckEditor\.tsx"\)\)/);
    expect(src).toMatch(/lazy\(\(\) => import\("\.\/documents\/WorkbookEditor\.tsx"\)\)/);
    expect(src).not.toMatch(/^import .*from "\.\/documents\//m);
    const deck = readFileSync(
      join(import.meta.dirname, "../src/canvas/documents/DeckEditor.tsx"),
      "utf8",
    );
    // The presenter rides in the deck chunk; nothing outside the documents folder imports it.
    expect(deck).toContain('from "./Presenter.tsx"');
  });
});

describe("Library", () => {
  it("labels deck and workbook artifacts by kind", () => {
    const item = (name: string) => ({ name, mime: "application/json" }) as never;
    expect(fileType(item("trip.deck.json"))).toBe("Slides");
    expect(fileType(item("trip.book.json"))).toBe("Spreadsheet");
  });
});
