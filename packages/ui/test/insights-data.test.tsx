import type { Run } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider, GatewayStore, useInsights } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, insightsFixtures } from "../src/fixtures/index.ts";

/** `useInsights` over the MockGateway's `insights.summary` (agent-overview-2026 §6.2). */

function setup(state?: "new" | "typical" | "heavy") {
  const gateway = new MockGateway(
    state === undefined ? {} : { insights: insightsFixtures(state) },
    {
      now: () => FIXTURE_NOW,
    },
  );
  const request = vi.spyOn(gateway, "request");
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  const calls = () => request.mock.calls.filter(([m]) => m === "insights.summary").length;
  return { gateway, wrapper, calls };
}

afterEach(() => vi.useRealTimers());

describe("insights fixtures", () => {
  it("cover a new user, a typical month and a heavy year", () => {
    const fresh = insightsFixtures("new");
    expect(fresh["7d"].days).toHaveLength(7);
    expect(fresh["7d"].totals.runs.chat + fresh["7d"].totals.runs.task).toBeGreaterThan(0);
    expect(fresh["7d"].firstActivityAt).toBe("2026-10-17T14:05:00.000Z");
    const month = insightsFixtures("typical");
    expect(month["30d"].days).toHaveLength(30);
    expect(month["30d"].previous).not.toBeNull();
    expect(month["30d"].topEntities.length).toBeGreaterThan(3);
    const year = insightsFixtures("heavy");
    expect(year.all.days).toHaveLength(371);
    expect(year.all.previous).toBeNull();
    expect(year.all.topEntities).toHaveLength(12);
    expect(year.all.totals.runs.chat).toBeGreaterThan(month["30d"].totals.runs.chat);
  });
});

describe("useInsights", () => {
  it("loads the window's summary", async () => {
    const { wrapper } = setup("typical");
    const { result } = renderHook(() => useInsights("30d", { timeZone: "UTC" }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.window).toBe("30d");
    expect(result.current.data?.days).toHaveLength(30);
  });

  it("answers a brand-new install with zeros and no first activity", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useInsights("7d"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.firstActivityAt).toBeNull();
    expect(result.current.data?.totals.runsDone).toBe(0);
  });

  it("refetches once, 2 s after a burst of run and approval events", async () => {
    const { gateway, wrapper, calls } = setup("typical");
    const { result } = renderHook(() => useInsights("7d", { timeZone: "UTC" }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(calls()).toBe(1);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = createFixtureWorld().runs[0] as Run;
    act(() => {
      gateway.emit("run.updated", { run });
      gateway.emit("run.updated", { run });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(calls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await waitFor(() => expect(calls()).toBe(2));
  });
});
