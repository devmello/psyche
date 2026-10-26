import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchView } from "../src/screens/search/SearchScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** S2 (docs/design/search-2026.md §7): backfill progress and the rebuild action. */
describe("search index status", () => {
  it("shows progress while the backfill runs", () => {
    render(
      <StoryWorld>
        <SearchView
          query="dentist"
          hits={[]}
          indexStatus={{ docs: 40, backfill: { state: "running", done: 40 } }}
          onReindex={() => undefined}
        />
      </StoryWorld>,
    );
    expect(screen.getByText(/Indexing your history: 40 items so far/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild search index" })).toBeNull();
  });

  it("offers a rebuild when a search finds nothing", async () => {
    const onReindex = vi.fn();
    render(
      <StoryWorld>
        <SearchView
          query="dentist"
          hits={[]}
          indexStatus={{ docs: 0, backfill: { state: "done", done: 0 } }}
          onReindex={onReindex}
        />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rebuild search index" }));
    expect(onReindex).toHaveBeenCalledOnce();
  });

  it("stays out of the way before a query", () => {
    render(
      <StoryWorld>
        <SearchView query="" hits={[]} onReindex={() => undefined} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("button", { name: "Rebuild search index" })).toBeNull();
  });
});
