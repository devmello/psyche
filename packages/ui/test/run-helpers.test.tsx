import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TimelineView } from "../src/agent/timeline/TimelineView.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, runTraceWorld, TRACE_IDS } from "../src/fixtures/index.ts";

/** The Helpers section of a run: its children from `runs.children`, opened in the same view. */

const R = TRACE_IDS.runs;
const NOW = Date.parse(FIXTURE_NOW);
const HELPER_TITLE = "Compare neighbourhoods";

function setup(extra?: (w: ReturnType<typeof runTraceWorld>) => void) {
  const world = runTraceWorld();
  extra?.(world);
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, wrapper };
}

describe("run Helpers section", () => {
  it("lists a run's helpers with their status, budget and deadline", async () => {
    const { wrapper } = setup((w) => {
      const helper = w.runs.find((r) => r.id === R.helper);
      if (helper) {
        helper.budget = {
          limit: { costUsd: 0.1 },
          used: { steps: 2, tokens: 420, wallMs: 1000, costUsd: 0.021 },
        };
        helper.deadline = "2026-11-24T10:00:00Z";
      }
    });
    render(<TimelineView runId={R.done} now={NOW} />, { wrapper });
    const section = await screen.findByTestId("run-helpers");
    const row = within(section).getByRole("button", { name: new RegExp(HELPER_TITLE) });
    expect(row.textContent).toContain("Helper");
    expect(row.textContent).toContain("Done");
    expect(row.textContent).toMatch(/Spent .+ of .+/);
    expect(row.textContent).toContain("Due ");
  });

  it("is hidden when the run has no helpers", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.failed} now={NOW} onRetry={() => {}} />, { wrapper });
    await screen.findByTestId("failure-banner");
    expect(screen.queryByTestId("run-helpers")).toBeNull();
  });

  it("opens a helper in the same view and goes back to the parent", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.done} now={NOW} />, { wrapper });
    const section = await screen.findByTestId("run-helpers");
    fireEvent.click(within(section).getByRole("button", { name: new RegExp(HELPER_TITLE) }));

    // The view now shows the helper run, with a way back to the parent.
    await screen.findByRole("region", { name: `Timeline for ${HELPER_TITLE}` });
    const back = screen.getByRole("button", { name: "Back to Lisbon research" });
    expect(back).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Timeline for Lisbon research/ })).toBeNull();

    fireEvent.click(back);
    await screen.findByRole("region", { name: /Timeline for Lisbon research/ });
    expect(screen.queryByRole("button", { name: /Back to Lisbon research/ })).toBeNull();
  });

  it("shows a failed load inline and retries it", async () => {
    const { gateway, wrapper } = setup();
    gateway.failNext("runs.children", "unavailable", "Gateway busy");
    render(<TimelineView runId={R.done} now={NOW} />, { wrapper });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("helpers");
    fireEvent.click(within(alert).getByRole("button"));
    const section = await screen.findByTestId("run-helpers");
    await waitFor(() =>
      expect(within(section).getByRole("button", { name: new RegExp(HELPER_TITLE) })).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
