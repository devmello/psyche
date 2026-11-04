import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecentRows } from "../src/people/EntityCard.tsx";
import type { InteractionView } from "../src/people/types.ts";

/** A conversation's gist leads its row on a person's page (docs/design/memory-everything-2026.md §2.6). */
const row = (over: Partial<InteractionView>): InteractionView => ({
  id: "i1",
  kind: "mail",
  occurredAt: "2026-11-01T10:00:00.000Z",
  direction: "in",
  subject: "Re: Lisbon",
  with: [],
  ...over,
});

describe("conversation gists on a person's page", () => {
  it("shows the gist in place of the subject", () => {
    render(
      <RecentRows interactions={[row({ gist: "Talked about the Lisbon dates" })]} limit={5} />,
    );
    expect(screen.getByText("Talked about the Lisbon dates")).toBeTruthy();
    expect(screen.queryByText("Re: Lisbon")).toBeNull();
  });

  it("falls back to the subject when there is no gist (a sensitive one never arrives)", () => {
    render(<RecentRows interactions={[row({})]} limit={5} />);
    expect(screen.getByText("Re: Lisbon")).toBeTruthy();
  });
});
