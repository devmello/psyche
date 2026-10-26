import type { Artifact, Message, Run } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Card } from "../src/blocks/card.tsx";
import { MessageBlocks } from "../src/blocks/MessageBlocks.tsx";
import { CanvasPane } from "../src/canvas/CanvasPane.tsx";
import { niceTicks } from "../src/canvas/ChartView.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { CANVAS_IDS, canvasFixtures } from "../src/fixtures/canvas.ts";
import { IDS } from "../src/fixtures/ids.ts";
import { createFixtureWorld } from "../src/fixtures/index.ts";
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

describe("chart, diff and diagram in the canvas", () => {
  it("draws a chart with a legend and a hidden data table", async () => {
    mount(CANVAS_IDS.chart);
    expect(await screen.findByText("Trip cost by item")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Trip cost by item" })).toBeTruthy();
    expect(screen.getAllByText("Planned").length).toBeGreaterThan(0);
    const cell = screen.getAllByRole("cell").find((c) => c.textContent === "690");
    expect(cell).toBeTruthy();
  });

  it("shows a diff without an Edit button", async () => {
    mount(CANVAS_IDS.diff);
    expect(await screen.findByTestId("diff-block")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  it("round-trips a chart patch locally and picks round ticks", () => {
    const c = JSON.stringify({
      kind: "bar",
      categories: ["a"],
      series: [{ name: "s", values: [1] }],
    });
    const out = applyOpsLocal("chart", c, null, [{ op: "patch", patch: { kind: "line" } }]);
    expect(JSON.parse(out.content).kind).toBe("line");
    expect(niceTicks(690)).toEqual([0, 200, 400, 600, 800]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

function mountWithPreview(id: string) {
  render(
    <StoryWorld
      edit={withCanvas}
      slots={{
        renderArtifact: ({ artifact, content }) =>
          artifact.type === "html" ? (
            <div data-testid="live-preview">{content.content}</div>
          ) : undefined,
      }}
    >
      <CanvasPane artifactId={id} threadId={IDS.threads.lisbon} onSelect={() => {}} />
    </StoryWorld>,
  );
}

describe("html artifacts (chat-experience-2026 §4.6)", () => {
  it("previews trusted html at once", async () => {
    mountWithPreview(CANVAS_IDS.html);
    expect(await screen.findByTestId("live-preview")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("keeps html from untrusted sources off until Run, and off again on a new version", async () => {
    mountWithPreview(CANVAS_IDS.htmlUntrusted);
    expect(await screen.findByText(/preview is off/)).toBeTruthy();
    expect(screen.queryByTestId("live-preview")).toBeNull();
    // The source is readable, never executed.
    expect(screen.getByText(/onclick/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("live-preview")).toBeTruthy();
    expect(screen.queryByText(/preview is off/)).toBeNull();
  });

  it("says so when the host has no preview", async () => {
    mount(CANVAS_IDS.html);
    expect(await screen.findByText(/can't preview HTML/)).toBeTruthy();
  });
});

describe("CanvasPane", () => {
  it("shows the latest version with recents tabs and the version picker", async () => {
    mount(CANVAS_IDS.doc);
    expect(await screen.findByText(/tram 28 back/)).toBeTruthy();
    const tabs = await screen.findByRole("tablist");
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual([
      "Lisbon itinerary",
      "Trip budget",
      "Trip cost chart",
      "Itinerary changes",
      "Packing page",
    ]);
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

describe("canvas auto-open", () => {
  const fresh = (id: string): Artifact => ({
    id,
    libraryItemId: "lib_x",
    type: "doc",
    title: "Fresh",
    version: 1,
    nameSlug: "fresh",
    sourceRef: null,
    updatedAt: new Date().toISOString(),
    threadId: IDS.threads.lisbon,
  });
  const message = (artifactId: string, runId: string) =>
    ({
      id: `m_${artifactId}`,
      threadId: IDS.threads.lisbon,
      role: "agent",
      runId,
      provenance: "trusted",
      blocks: [{ type: "artifact", artifactId }],
      createdAt: new Date().toISOString(),
    }) as unknown as Message;
  const run = (id: string, origin: Run["origin"]): Run => ({
    ...(createFixtureWorld().runs[0] as Run),
    id,
    threadId: IDS.threads.lisbon,
    status: "running",
    origin,
    taskId: null,
    automationRunId: null,
    parentRunId: null,
  });

  async function show(artifactId: string, origin: Run["origin"]) {
    const openArtifact = vi.fn();
    // The first wave of cards has rendered: later cards count as live.
    render(<Card label="settle" title="settle" />);
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        edit={(w) => {
          (w.artifacts as Artifact[]).push(fresh(artifactId));
        }}
        onGateway={(g) => {
          gateway = g;
        }}
        slots={{ openArtifact }}
      >
        <MessageBlocks message={message(artifactId, `run_${artifactId}`)} />
      </StoryWorld>,
    );
    await screen.findByRole("article", { name: /Fresh/ });
    // The live run reaches the store the way it does in a chat: as a run event.
    act(() => gateway?.emit("run.updated", { run: run(`run_${artifactId}`, origin) }));
    return openArtifact;
  }

  it("opens a new artifact from the owner's own live run once", async () => {
    const open = await show("art_fg", "owner");
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open.mock.calls[0]?.[0]).toMatchObject({ id: "art_fg" });
  });

  it("leaves an automation's artifact as a card", async () => {
    const open = await show("art_bg", "automation");
    await new Promise((r) => setTimeout(r, 50));
    expect(open).not.toHaveBeenCalled();
  });
});
