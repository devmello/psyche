import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryStoreGroups } from "../src/screens/settings/DataControlsSection.tsx";

/** The Markdown/embeddings recall-mode radio is retired (owner decision 2026-11-25). */

describe("Memory store groups: no recall-mode radio", () => {
  it("shows no recall mode, even when the setting is still stored as embeddings", () => {
    render(
      <MemoryStoreGroups
        values={{ "memory.recall.mode": "embeddings" }}
        onChange={() => undefined}
        persona="Wren"
        store={{ encrypted: false, state: "off", reason: null, restartNeeded: false }}
      />,
    );
    // Positive control: the group beside it still draws.
    expect(screen.getByRole("switch", { name: "Encrypt memory on disk" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("How memory is recalled")).toBeNull();
    expect(screen.queryByRole("radio", { name: /Markdown/ })).toBeNull();
  });
});
