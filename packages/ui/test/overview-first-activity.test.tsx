import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { type FixtureWorld, insightsFixtures } from "../src/fixtures/index.ts";
import { useOverviewData } from "../src/overview/data.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Shows what the Overview's shell reads for the new-user state. */
function Probe(): ReactElement {
  const { firstActivityAt } = useOverviewData();
  return (
    <p data-testid="first">{firstActivityAt === undefined ? "unknown" : String(firstActivityAt)}</p>
  );
}

describe("the Overview's first-activity time (insights.summary)", () => {
  it("is unknown until the Gateway answers, then the first activity of the install", async () => {
    render(
      <StoryWorld
        edit={(w: FixtureWorld) => {
          Object.assign(w, { insights: insightsFixtures("new") });
        }}
      >
        <Probe />
      </StoryWorld>,
    );
    expect(screen.getByTestId("first").textContent).toBe("unknown");
    await waitFor(() =>
      expect(screen.getByTestId("first").textContent).toBe("2026-10-17T14:05:00.000Z"),
    );
  });

  it("is null for an install with no activity, which the new-user page keys on", async () => {
    render(
      <StoryWorld>
        <Probe />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getByTestId("first").textContent).toBe("null"));
  });
});
