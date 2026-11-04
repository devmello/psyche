import type { CatchUpItem, SearchHit } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatchUp } from "../src/home/CatchUp.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const item = (over: Partial<CatchUpItem> = {}): CatchUpItem => ({
  entityId: "e1",
  kind: "assignment",
  title: "Q3 board deck",
  titleProvenance: "owner",
  urgency: "soon",
  status: "not_started",
  statusAsOf: "2026-11-01T10:00:00.000Z",
  stale: false,
  line: "Q3 board deck: due tomorrow. New: Sam: “Updated numbers”",
  changes: [],
  actions: ["open"],
  provenance: "untrusted",
  ...over,
});

const hit = (id: string): SearchHit => ({
  scope: "connectors",
  id,
  title: "Updated numbers",
  snippet: "The numbers are in the <b>attached</b> sheet",
  score: 1,
  threadId: null,
  route: null,
  provenance: "untrusted",
  createdAt: Date.parse("2026-11-02T09:00:00.000Z"),
});

const mount = (items: CatchUpItem[], onOpen?: (route: string) => void) =>
  render(
    <StoryWorld
      edit={(w) => {
        w.searchHits = [hit("mail:1")];
      }}
    >
      <CatchUp items={items} onOpen={onOpen} />
    </StoryWorld>,
  );

describe("source chips on a catch-up line", () => {
  it("shows a chip for each source and opens the passage in the viewer", async () => {
    mount([item({ sources: [{ docId: "mail:1", sourceKind: "mail" }] })]);
    const chip = screen.getByTestId("catch-up-source");
    expect(chip.textContent).toBe("From Mail");
    expect(screen.queryByTestId("source-viewer")).toBeNull();
    fireEvent.click(chip);
    const text = await screen.findByTestId("source-text");
    expect(text.textContent).toContain("<b>attached</b>");
    expect(text.querySelector("b")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByTestId("source-viewer")).toBeNull();
  });

  it("does not open the item when a chip is clicked, and the line still opens it", () => {
    const onOpen = vi.fn();
    mount([item({ sources: [{ docId: "mail:1", sourceKind: "mail" }] })], onOpen);
    fireEvent.click(screen.getByTestId("catch-up-source"));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Q3 board deck" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("/memory?entity=e1");
  });

  it("names each source kind and keeps one passage open at a time", () => {
    mount([
      item({
        sources: [
          { docId: "mail:1", sourceKind: "mail" },
          { docId: "notes:2", sourceKind: "notes" },
        ],
      }),
    ]);
    const chips = screen.getAllByTestId("catch-up-source");
    expect(chips.map((c) => c.textContent)).toEqual(["From Mail", "From Notes"]);
    fireEvent.click(chips[0] as HTMLElement);
    fireEvent.click(chips[1] as HTMLElement);
    expect(screen.getAllByTestId("source-viewer")).toHaveLength(1);
  });

  it("shows no chip for a line without sources (older, withheld or remote)", () => {
    mount([item(), item({ entityId: "e2", title: "Quiz 3", sources: [] })]);
    expect(screen.queryByTestId("catch-up-source")).toBeNull();
  });
});
