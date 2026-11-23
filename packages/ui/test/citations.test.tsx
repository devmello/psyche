import type { AnswerSource, Artifact, Widget } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasPane } from "../src/canvas/CanvasPane.tsx";
import { CANVAS_IDS, canvasFixtures } from "../src/fixtures/canvas.ts";
import { IDS } from "../src/fixtures/ids.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";
import { progressSpec, progressWidget } from "../src/widgets/fixtures.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

/**
 * Citations on widgets and canvas documents use the chat's source chips: one chip per source that
 * opens it in its pane, and "show the source" for the passage as plain text.
 */

const sources: AnswerSource[] = [
  {
    id: "mail:m1",
    source: "mail",
    kind: "connector",
    title: "Flight to Lisbon",
    date: "2026-10-12",
    route: "/library/all?item=mail:m1",
    provenance: "untrusted",
    span: "Departs **21:40** [x](javascript:alert(1))",
  },
  {
    id: "notes:n1",
    source: "notes",
    kind: "library",
    title: "Packing",
    date: "2026-10-01",
    route: null,
    provenance: "owner",
    span: "passport",
  },
  {
    id: "files:f1",
    source: "files",
    kind: "library",
    title: "Budget",
    date: "2026-10-02",
    // Not an in-app path: must never become a navigation target.
    route: "javascript:alert(2)",
    provenance: "owner",
    span: "total 690",
  },
];

const cited: Widget = {
  ...progressWidget,
  spec: { ...progressSpec, sources },
};

function mountWidget(widget: Widget, navigate = vi.fn()) {
  render(
    <UiSlotsProvider value={{ navigate }}>
      <StoryWorld edit={(w) => (w.widgets = [widget])}>
        <WidgetBlockView block={{ type: "ui", widgetId: widget.id }} />
      </StoryWorld>
    </UiSlotsProvider>,
  );
  return navigate;
}

describe("citations on a widget", () => {
  it("renders the sources as chips under the widget", async () => {
    mountWidget(cited);
    const frame = await screen.findByTestId("widget");
    const footer = within(frame).getByTestId("sources-footer");
    expect(within(footer).getByRole("button", { name: /Flight to Lisbon/ })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: /Packing/ })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: /Budget/ })).toBeTruthy();
  });

  it("opens a source the way a chat chip does, and never a non-path route", async () => {
    const navigate = mountWidget(cited);
    const frame = await screen.findByTestId("widget");
    const user = userEvent.setup();
    await user.click(within(frame).getByRole("button", { name: /Flight to Lisbon/ }));
    expect(navigate).toHaveBeenCalledWith("/library/all?item=mail:m1");
    const budget = within(frame).getByRole("button", { name: /Budget/ }) as HTMLButtonElement;
    expect(budget.disabled).toBe(true);
    const packing = within(frame).getByRole("button", { name: /Packing/ }) as HTMLButtonElement;
    expect(packing.disabled).toBe(true);
  });

  it("shows the passage as plain text: no Markdown, no link, no javascript: href", async () => {
    mountWidget(cited);
    const frame = await screen.findByTestId("widget");
    await userEvent.setup().click(within(frame).getByRole("button", { name: "Show the source" }));
    expect(
      within(frame).getByText(/Departs \*\*21:40\*\* \[x\]\(javascript:alert\(1\)\)/),
    ).toBeTruthy();
    const hrefs = Array.from(frame.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("javascript:"))).toBe(false);
    expect(frame.querySelector("strong")).toBeNull();
  });

  it("an old payload without sources still renders, with no source row", async () => {
    mountWidget(progressWidget);
    const frame = await screen.findByTestId("widget");
    expect(within(frame).getByRole("heading", { name: "Inbox cleanup" })).toBeTruthy();
    expect(within(frame).queryByTestId("sources-footer")).toBeNull();
    expect(within(frame).queryByTestId("source-chips")).toBeNull();
  });
});

describe("citations on a canvas document", () => {
  function mountDoc(sourcesFor: AnswerSource[] | undefined) {
    const fx = canvasFixtures();
    const artifacts: Artifact[] = fx.artifacts.map((a) =>
      a.id === CANVAS_IDS.doc && sourcesFor !== undefined ? { ...a, sources: sourcesFor } : a,
    );
    render(
      <StoryWorld
        edit={(w) => {
          const world = w as { artifacts: unknown[]; artifactHistory?: unknown };
          world.artifacts.push(...artifacts);
          world.artifactHistory = fx.artifactHistory;
        }}
      >
        <CanvasPane artifactId={CANVAS_IDS.doc} threadId={IDS.threads.lisbon} onSelect={() => {}} />
      </StoryWorld>,
    );
  }

  it("renders the sources the document was made from as chips", async () => {
    mountDoc(sources);
    const footer = await screen.findByTestId("sources-footer");
    expect(within(footer).getByRole("button", { name: /Flight to Lisbon/ })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: /Packing/ })).toBeTruthy();
  });

  it("a document without sources (any older one) shows no source row", async () => {
    mountDoc(undefined);
    await screen.findAllByText("Lisbon itinerary", { exact: false });
    expect(screen.queryByTestId("sources-footer")).toBeNull();
  });
});
