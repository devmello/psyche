import type { SearchHit } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchSurface } from "../src/screens/search/SearchSurface.tsx";
import {
  SemanticSearchSettingsGroup,
  semanticStatusText,
} from "../src/screens/settings/SemanticSearchSettings.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** S3 (docs/design/search-2026.md §3): the switch, its live status and the "Related" label. */
describe("semantic search settings", () => {
  it("turns on from the switch and shows the engine choice once on", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StoryWorld>
        <SemanticSearchSettingsGroup values={{}} onChange={onChange} />
      </StoryWorld>,
    );
    expect(screen.getByText("Off: search matches words")).toBeTruthy();
    expect(screen.queryByText("Built-in model")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Semantic search (on-device)" }));
    expect(onChange).toHaveBeenCalledWith("search.semantic.enabled", true);
    rerender(
      <StoryWorld>
        <SemanticSearchSettingsGroup
          values={{ "search.semantic.enabled": true }}
          onChange={onChange}
          status={{
            enabled: true,
            engine: "builtin",
            state: "downloading",
            receivedBytes: 40_000_000,
            totalBytes: 135_000_000,
          }}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("Downloading the model: 40 of 135 MB")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /My local model server/ }));
    expect(onChange).toHaveBeenCalledWith("search.semantic.engine", "router");
  });

  it("offers the cloud opt-in only for the router engine, with the warning", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StoryWorld>
        <SemanticSearchSettingsGroup
          values={{ "search.semantic.enabled": true }}
          onChange={onChange}
        />
      </StoryWorld>,
    );
    expect(screen.queryByRole("switch", { name: "Allow a cloud embedding service" })).toBeNull();
    rerender(
      <StoryWorld>
        <SemanticSearchSettingsGroup
          values={{ "search.semantic.enabled": true, "search.semantic.engine": "router" }}
          onChange={onChange}
        />
      </StoryWorld>,
    );
    expect(screen.getByText(/sent to it to be indexed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Allow a cloud embedding service" }));
    expect(onChange).toHaveBeenCalledWith("search.semantic.allowCloud", true);
    expect(
      semanticStatusText({
        enabled: true,
        engine: "router",
        state: "ready",
        cloud: true,
        vectors: 3,
      }).text,
    ).toBe("On, with a cloud service: 3 passages indexed");
  });

  it("says why it is blocked or what it indexed", () => {
    expect(
      semanticStatusText({
        enabled: true,
        engine: "router",
        state: "blocked",
        blocked: "cloud_not_allowed",
      }).text,
    ).toMatch(/cloud service/);
    expect(
      semanticStatusText({ enabled: true, engine: "builtin", state: "ready", vectors: 1200 }).text,
    ).toBe("On: 1,200 passages indexed");
  });

  it("labels hits found by meaning as Related", () => {
    const hit: SearchHit = {
      scope: "messages",
      id: "m1",
      title: "Plans",
      snippet: "How much can we spend in Lisbon",
      score: 1,
      threadId: "t1",
      route: "/chat/t1",
      match: "semantic",
    };
    render(
      <StoryWorld>
        <SearchSurface
          variant="palette"
          query="trip budget"
          onQueryChange={() => undefined}
          hits={[hit]}
          actions={[]}
          preview={false}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("Related")).toBeTruthy();
  });
});
