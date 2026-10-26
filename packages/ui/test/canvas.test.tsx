import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CanvasPane } from "../src/canvas/CanvasPane.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { CANVAS_IDS, canvasFixtures } from "../src/fixtures/canvas.ts";
import { IDS } from "../src/fixtures/ids.ts";
import { applyOpsLocal, diffToOps, setCellOp, viewRows } from "../src/lib/artifact-ops.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("diffToOps", () => {
  it("emits one unique replace for a local edit", () => {
    const before = "Day 1\n- walk\n\nDay 2\n- walk\n- museum\n";
    const after = before.replace("- museum", "- museum, then lunch");
    const ops = diffToOps(before, after);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.op).toBe("replace");
    expect(applyOpsLocal("doc", before, null, ops).content).toBe(after);
  });

  it("widens an ambiguous change until it is unique", () => {
    const before = "- walk\n- walk\n- walk";
    const after = "- walk\n- run\n- walk";
    const ops = diffToOps(before, after);
    expect(ops[0]?.op).toBe("replace");
    expect(applyOpsLocal("doc", before, null, ops).content).toBe(after);
  });

  it("rewrites when most of it changed, and is empty when nothing did", () => {
    expect(diffToOps("abc", "xyz")).toEqual([{ op: "rewrite", content: "xyz" }]);
    expect(diffToOps("same", "same")).toEqual([]);
  });

  it("addresses cells in A1 over data rows and applies views", () => {
    expect(setCellOp(0, 27, 1)).toEqual({ op: "set", cell: "AB1", value: 1 });
    const t = { columns: ["n"], rows: [[3], [1], [2]] };
    expect(viewRows(t, { sort: { column: "n", dir: "asc" } }).map((r) => r.index)).toEqual([
      1, 2, 0,
    ]);
  });
});

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

describe("CanvasPane", () => {
  it("shows the latest version with recents tabs and the version picker", async () => {
    mount(CANVAS_IDS.doc);
    expect(await screen.findByText(/tram 28 back/)).toBeTruthy();
    const tabs = await screen.findByRole("tablist");
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Lisbon itinerary", "Trip budget"]);
    const picker = screen.getByRole("combobox", { name: "Version" });
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(3));
    expect(within(picker).getAllByRole("option")[0]?.textContent).toMatch(/^v3 · you/);
  });

  it("opens an old version read-only and restores it as a new version", async () => {
    mount(CANVAS_IDS.doc);
    const picker = await screen.findByRole("combobox", { name: "Version" });
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(3));
    await userEvent.selectOptions(picker, "1");
    expect(await screen.findByText(/Viewing version 1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore as new version" }));
    await waitFor(() => expect(screen.queryByText(/Viewing version/)).toBeNull());
    expect(screen.queryByText(/Day 2/)).toBeNull();
  });

  it("saves a text edit as the smallest op", async () => {
    const gw = mount(CANVAS_IDS.doc);
    await screen.findByText(/tram 28 back/);
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const box = screen.getByRole("textbox", { name: "Lisbon itinerary" }) as HTMLTextAreaElement;
    await userEvent.type(box, "\n- Pastéis");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gw().world.artifactHistory[CANVAS_IDS.doc]?.versions.at(-1)).toMatchObject({
        version: 4,
        author: "user",
        ops: [{ op: "replace" }],
      }),
    );
  });

  it("edits a table cell with one set op", async () => {
    const gw = mount(CANVAS_IDS.table);
    const user = userEvent.setup();
    const cell = await screen.findByText("690");
    await user.dblClick(cell);
    const input = screen.getByRole("textbox", { name: "Cost 2" });
    await user.clear(input);
    await user.type(input, "720{Enter}");
    await waitFor(() =>
      expect(gw().world.artifactHistory[CANVAS_IDS.table]?.versions.at(-1)?.ops).toEqual([
        { op: "set", cell: "C2", value: 720 },
      ]),
    );
    expect(await screen.findByText("720")).toBeTruthy();
  });
});
