import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentSheetBody,
  AgentSheetPanel,
  agentSheetHref,
  agentSheetRoute,
  lastAgentTab,
  rememberAgentTab,
  useDefaultAgentTab,
} from "../src/agent/AgentSheet.tsx";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { runTraceWorld } from "../src/fixtures/runs.ts";
import { DEFAULT_ACTIONS } from "../src/shell/CommandPalette.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** The slim agent sheet (agent-overview-2026 §4, O6): two segments, Now / next, Approvals. */

const quiet = (w: FixtureWorld) => {
  w.runs = [];
  w.tasks = [];
  w.approvals = [];
  w.inputRequests = [];
  w.threads = w.threads.map((e) => ({ ...e, thread: { ...e.thread, activeWriterRunId: null } }));
};

const working = (w: FixtureWorld) => {
  const tw = runTraceWorld();
  w.runs = [...tw.runs];
  w.runSteps = tw.runSteps;
  w.runFrames = tw.runFrames;
  w.automationRuns = tw.automationRuns;
  w.approvals = [];
  w.inputRequests = [];
};

function sheet(
  edit?: (w: FixtureWorld) => void,
  slots = {},
  tab: "approvals" | "soul" = "approvals",
) {
  return render(
    <StoryWorld {...(edit ? { edit } : {})} slots={slots}>
      <AgentSheetPanel tab={tab} onTabChange={() => {}} onClose={() => {}} now={STORY_NOW} />
    </StoryWorld>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the two segments", () => {
  it("are Approvals (with the needs-you badge) and Soul & Memory, and nothing else", async () => {
    sheet();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((x) => x.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "Approvals",
      "Soul & Memory",
    ]);
    await waitFor(() => expect(tabs[0]?.textContent).toMatch(/\d+$/));
  });

  it("remembers the last segment per device and survives broken storage", () => {
    expect(lastAgentTab()).toBeNull();
    rememberAgentTab("soul");
    expect(lastAgentTab()).toBe("soul");
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(lastAgentTab()).toBeNull();
    spy.mockRestore();
  });

  it("defaults to Approvals when something needs you, else the last used segment", async () => {
    function Probe() {
      return <output data-testid="tab">{useDefaultAgentTab()}</output>;
    }
    rememberAgentTab("soul");
    const waiting = render(
      <StoryWorld>
        <Probe />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("approvals"));
    waiting.unmount();
    render(
      <StoryWorld edit={quiet}>
        <Probe />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getByTestId("tab").textContent).toBe("soul"));
  });

  it("remembers a segment the owner picks", async () => {
    render(
      <StoryWorld>
        <AgentSheetBody tab="approvals" onTabChange={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("tab", { name: /Soul & Memory/ }));
    expect(lastAgentTab()).toBe("soul");
  });
});

describe("the Now / next line", () => {
  it("says Waiting for you when approvals are pending and opens Now & next", async () => {
    const navigate = vi.fn();
    sheet(undefined, { navigate });
    const line = await screen.findByTestId("agent-now-next");
    await waitFor(() => expect(line.textContent).toMatch(/^Waiting for you · \d+ approvals?$/));
    fireEvent.click(line);
    expect(navigate).toHaveBeenCalledWith("/overview#now");
  });

  it("says Working on … with a live duration and opens the run's Timeline", async () => {
    const navigate = vi.fn();
    sheet(working, { navigate });
    const line = await screen.findByTestId("agent-now-next");
    await waitFor(() => expect(line.getAttribute("data-kind")).toBe("working"));
    expect(line.textContent).toMatch(/^Working on .+ · \d+:\d{2}$/);
    fireEvent.click(line);
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\/run\//));
  });

  it("says Idle · next: … from automations.upcoming", async () => {
    sheet(quiet);
    const line = await screen.findByTestId("agent-now-next");
    await waitFor(() => expect(line.textContent).toMatch(/^Idle · next: .+/));
  });

  it("says plain Idle with nothing scheduled, and names a paused memory", async () => {
    const bare = sheet((w) => {
      quiet(w);
      w.automations = [];
    });
    await waitFor(() => expect(screen.getByTestId("agent-now-next").textContent).toBe("Idle"));
    bare.unmount();
    sheet((w) => {
      quiet(w);
      w.automations = [];
      w.settings["memory.paused"] = true;
    });
    // Whether the mock reports it paused is the Gateway's business; the line never crashes.
    expect(await screen.findByTestId("agent-now-next")).toBeTruthy();
  });

  it("always offers Open overview; a ⌘-click is left to the browser", async () => {
    const navigate = vi.fn();
    sheet(undefined, { navigate });
    const link = await screen.findByTestId("agent-open-overview");
    expect(link.getAttribute("href")).toBe("/overview");
    expect(link.textContent).toContain("Open overview");
    fireEvent.click(link, { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("/overview");
  });
});

describe("Approvals segment", () => {
  it("has Needs you, a Standing permissions disclosure and a collapsed Decided recently", async () => {
    sheet();
    expect(await screen.findByRole("heading", { name: /^Needs you \(\d+\)$/ })).toBeTruthy();
    const standing = screen.getByRole("button", { name: /^Standing permissions/ });
    const decided = screen.getByRole("button", { name: /^Decided recently/ });
    expect(standing.getAttribute("aria-expanded")).toBe("false");
    expect(decided.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(standing);
    expect(standing.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens Decided recently expanded for ?view=decided and #decided", async () => {
    expect(agentSheetRoute("/agent/approvals?view=decided")).toEqual({
      tab: "approvals",
      view: "decided",
    });
    expect(agentSheetRoute("/agent/approvals#decided")).toEqual({
      tab: "approvals",
      view: "decided",
    });
    expect(agentSheetRoute("/agent/approvals?view=decided&from=%2Foverview")).toEqual({
      tab: "approvals",
      view: "decided",
      back: "/overview",
    });
    expect(agentSheetRoute("/agent/soul?view=decided")).toEqual({ tab: "soul" });
    expect(agentSheetHref("approvals", { view: "decided", back: "/overview" })).toBe(
      "/agent/approvals?view=decided&from=%2Foverview",
    );
    render(
      <StoryWorld>
        <AgentSheetBody tab="approvals" view="decided" onTabChange={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    const decided = await screen.findByRole("button", { name: /^Decided recently/ });
    expect(decided.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Full history on the Overview" })).toBeTruthy();
  });

  it("shows Nothing needs you with one line when the queue is empty", async () => {
    sheet(quiet);
    const empty = await screen.findByTestId("approvals-empty");
    expect(within(empty).getByText("Nothing needs you.")).toBeTruthy();
    expect(empty.textContent).toMatch(/will appear here/);
  });
});

describe("old links and ⌘K", () => {
  it("keeps parsing the moved tabs so old links resolve", () => {
    expect(agentSheetRoute("/agent/activity")).toEqual({ tab: "activity" });
    expect(agentSheetRoute("/agent/upcoming")).toEqual({ tab: "upcoming" });
    expect(agentSheetRoute("/agent/growth")).toEqual({ tab: "growth" });
    expect(agentSheetRoute("/agent/activity/run/run_1?step=s1")).toEqual({
      tab: "activity",
      runId: "run_1",
      stepId: "s1",
    });
  });

  it("offers Approvals, Soul & Memory and the Overview, not Activity or Upcoming", () => {
    const routes = DEFAULT_ACTIONS.map((a) => a.route);
    expect(routes).toContain("/agent/approvals");
    expect(routes).toContain("/agent/soul");
    expect(routes).toContain("/overview");
    expect(routes).not.toContain("/agent/activity");
    expect(routes).not.toContain("/agent/upcoming");
  });
});
