import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActivityPanel } from "../src/agent/ActivityPanel.tsx";
import { usualDuration } from "../src/agent/MissionControl.tsx";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { runTraceWorld } from "../src/fixtures/runs.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** Run trace T3: Activity as mission control (run-trace §3.6). */

function withTrace(w: FixtureWorld) {
  const tw = runTraceWorld();
  w.runs = [...w.runs.filter((r) => !tw.runs.some((x) => x.id === r.id)), ...tw.runs];
  w.runSteps = tw.runSteps;
  w.runFrames = tw.runFrames;
  w.automationRuns = tw.automationRuns;
}

describe("usual durations (principle 7: honest numbers)", () => {
  it("needs at least 3 past runs and takes the middle one", () => {
    expect(usualDuration(undefined)).toBeNull();
    expect(usualDuration([60_000, 70_000])).toBeNull();
    expect(usualDuration([90_000, 50_000, 70_000])).toBe(70_000);
  });
});

describe("Activity mission control", () => {
  it("shows Needs you, Now, Next up and Recent, and opens a run's Timeline", async () => {
    render(
      <StoryWorld edit={withTrace}>
        <ActivityPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const now = await screen.findByRole("region", { name: /^Now/ });
    // The live Task run shows its current step (the thread's chat run is a separate row).
    const rows = await within(now).findAllByRole("button", { name: /Dentist booking/ });
    expect(rows.some((r) => r.textContent?.includes("Checking open slots"))).toBe(true);
    expect(screen.getByRole("region", { name: /^Needs you/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Next up" })).toBeTruthy();
    const recent = screen.getByRole("region", { name: "Recent" });
    await within(recent).findByRole("button", { name: /Subscription audit/ });
    // Recent filters: Failed keeps only failed runs.
    await userEvent.click(within(recent).getByRole("button", { name: "Failed" }));
    await waitFor(() =>
      expect(within(recent).queryByRole("button", { name: /Lisbon research/ })).toBeNull(),
    );
    expect(within(recent).getByRole("button", { name: /Subscription audit/ })).toBeTruthy();
    // A row opens its Timeline, which opens on the failed step.
    await userEvent.click(within(recent).getByRole("button", { name: /Subscription audit/ }));
    expect(await screen.findByTestId("failure-banner")).toBeTruthy();
    // Back returns to Activity.
    await userEvent.click(screen.getByRole("button", { name: "Back to Activity" }));
    expect(await screen.findByRole("region", { name: "Recent" })).toBeTruthy();
  });

  it("says nothing is running, naming the next automation", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.runs = [];
          w.tasks = [];
          w.approvals = [];
          w.inputRequests = [];
        }}
      >
        <ActivityPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    expect(await screen.findByText(/^Nothing running\. .+'s next automation is /)).toBeTruthy();
  });
});
