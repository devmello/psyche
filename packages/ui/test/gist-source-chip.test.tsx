import type { SearchHit } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecentRows } from "../src/people/EntityCard.tsx";
import type { InteractionView } from "../src/people/types.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

/**
 * A conversation gist with a source shows a quiet chip, in the style of the answer card's, that
 * opens the passage in the source viewer. The Gateway only sends the reference to a connection
 * that may open it, so a gist without one (older, blocked, remote) shows no chip.
 */
const row = (over: Partial<InteractionView>): InteractionView => ({
  id: "i1",
  kind: "mail",
  occurredAt: "2026-11-01T10:00:00.000Z",
  direction: "in",
  subject: "Re: Lisbon",
  with: [],
  ...over,
});

const hit = (id: string): SearchHit => ({
  scope: "connectors",
  id,
  title: "Lisbon dates",
  snippet: "We could go on the <b>12th</b>",
  score: 1,
  threadId: null,
  route: null,
  provenance: "untrusted",
  createdAt: Date.parse("2026-11-01T09:00:00.000Z"),
});

const mount = (interactions: InteractionView[], hits: SearchHit[] = []) =>
  render(
    <StoryWorld
      edit={(w) => {
        w.searchHits = hits;
      }}
    >
      <RecentRows interactions={interactions} limit={5} />
    </StoryWorld>,
  );

describe("the source chip on a gist", () => {
  it("shows a chip for a gist with a reference, and it opens the viewer", async () => {
    mount([row({ gist: "Talked about the Lisbon dates", gistDocId: "mail:1" })], [hit("mail:1")]);
    const chip = screen.getByTestId("gist-source");
    expect(chip.textContent).toBe("From Mail");
    expect(screen.queryByTestId("source-viewer")).toBeNull();
    fireEvent.click(chip);
    const text = await screen.findByTestId("source-text");
    // Plain text: the indexed passage is someone else's words.
    expect(text.textContent).toContain("<b>12th</b>");
    expect(text.querySelector("b")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByTestId("source-viewer")).toBeNull();
  });

  it("names the source a conversation came from", () => {
    mount([
      row({ id: "a", kind: "message", gist: "Sorted the lift", gistDocId: "messages:c|d|1" }),
      row({ id: "b", kind: "meeting", gist: "Planned the trip", gistDocId: "calendar:ev1" }),
    ]);
    expect(screen.getAllByTestId("gist-source").map((c) => c.textContent)).toEqual([
      "From Messages",
      "From Calendar",
    ]);
  });

  it("shows no chip for a gist with no reference (an older gist, or one the Gateway withheld)", () => {
    mount([row({ gist: "Talked about the Lisbon dates" })]);
    expect(screen.getByText("Talked about the Lisbon dates")).toBeTruthy();
    expect(screen.queryByTestId("gist-source")).toBeNull();
  });

  it("shows no chip when there is no gist to attach it to", () => {
    mount([row({ gistDocId: "mail:1" })]);
    expect(screen.getByText("Re: Lisbon")).toBeTruthy();
    expect(screen.queryByTestId("gist-source")).toBeNull();
  });

  it("says so when the passage is no longer in the index", async () => {
    mount([row({ gist: "Talked about the Lisbon dates", gistDocId: "mail:gone" })]);
    fireEvent.click(screen.getByTestId("gist-source"));
    // The viewer opens on "Loading the source…" and settles when the lookup answers.
    await waitFor(() =>
      expect(screen.getByTestId("source-viewer").textContent).toContain(
        "That source is no longer in the index.",
      ),
    );
  });
});
