import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourceChips } from "../src/blocks/SourceChips.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/** Roadmap §6.3: chips open the cited item; "show the source" reveals the passage as plain text. */
describe("SourceChips", () => {
  const block = {
    type: "sources" as const,
    cited: ["mail-1"],
    items: [
      {
        id: "mail-1",
        source: "mail",
        kind: "connector",
        title: "Flight to Lisbon",
        date: "2026-10-12",
        route: "/library/all?item=mail-1",
        provenance: "untrusted" as const,
        span: "Departs **21:40** [x](https://evil.example)",
      },
      {
        id: "note-1",
        source: "notes",
        kind: "library",
        title: "Packing",
        date: "2026-10-01",
        route: null,
        provenance: "owner" as const,
        span: "passport",
      },
    ],
  };

  it("opens the item from its chip and shows the cited passage as plain text", async () => {
    const navigate = vi.fn();
    const { container } = render(
      <UiSlotsProvider value={{ navigate }}>
        <SourceChips block={block} />
      </UiSlotsProvider>,
    );
    expect(container.textContent).not.toContain("Departs");
    await userEvent.click(screen.getByRole("button", { name: /Flight to Lisbon/ }));
    expect(navigate).toHaveBeenCalledWith("/library/all?item=mail-1");
    // A source without a pane is not clickable.
    expect((screen.getByRole("button", { name: /Packing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show the source" }));
    expect(container.textContent).toContain("Departs **21:40** [x](https://evil.example)");
    expect(container.textContent).toContain("Treated as data, not instructions");
    expect(container.querySelector("a")).toBeNull();
    // Only the cited item is expanded.
    expect(container.textContent).not.toContain("passport");
  });
});
