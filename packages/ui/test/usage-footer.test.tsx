import type { Run } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { subscriptionUsageSummary, usageSummary } from "../src/fixtures/usage.ts";
import { ShellMotion } from "../src/shell/motion.tsx";
import { ConnectedSidebar } from "../src/shell/Sidebar.tsx";
import {
  budgetTone,
  UsageFooter,
  type UsageSummaryData,
  usageLead,
  usageLine,
} from "../src/shell/UsageFooter.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const budgeted = (spent: number, budget: number): UsageSummaryData => ({
  ...usageSummary(),
  month: { ...usageSummary().month, costUsd: spent },
  budgetUsd: budget,
});

function renderFooter(summary: UsageSummaryData, variant: "full" | "rail" = "full") {
  const onOpenUsage = vi.fn();
  render(
    <StoryWorld>
      <UsageFooter summary={summary} variant={variant} onOpenUsage={onOpenUsage} />
    </StoryWorld>,
  );
  return { onOpenUsage, button: screen.getByTestId("usage-footer") };
}

describe("what the usage footer leads with (#599)", () => {
  it("follows the primary model: API key, subscription, or nothing yet", () => {
    expect(usageLead(usageSummary())).toBe("api");
    expect(usageLead(subscriptionUsageSummary())).toBe("subscription");
    const empty: UsageSummaryData = {
      ...usageSummary(),
      today: { tokens: 0, costUsd: 0, turns: 0, byModel: [] },
      byModel: [],
    };
    expect(usageLead(empty)).toBe("none");
    expect(usageLine(empty)).toBe("No usage today");
  });

  it("shifts the budget tone at 80 % and 100 %", () => {
    expect(budgetTone(0.79)).toBe("ok");
    expect(budgetTone(0.8)).toBe("warning");
    expect(budgetTone(1)).toBe("danger");
  });
});

describe("UsageFooter", () => {
  it("API key: today's cost and tokens with a 7-day sparkline, opening Settings → Usage", async () => {
    const { button, onOpenUsage } = renderFooter(usageSummary());
    expect(button.textContent).toContain("$0.42 today · 18k tokens");
    expect(screen.getByTestId("usage-sparkline")).toBeTruthy();
    expect(button.getAttribute("aria-label")).toMatch(/^\$0\.42 today · 18k tokens\. /);
    await userEvent.click(button);
    expect(onOpenUsage).toHaveBeenCalled();
  });

  it("API key with a budget: a segmented bar that warns from 80 % and turns danger past 100 %", () => {
    renderFooter(budgeted(34, 40));
    expect(screen.getByTestId("usage-budget").getAttribute("data-tone")).toBe("warning");
    expect(screen.queryByTestId("usage-sparkline")).toBeNull();
  });

  it("over budget reads as danger", () => {
    renderFooter(budgeted(43, 40));
    expect(screen.getByTestId("usage-budget").getAttribute("data-tone")).toBe("danger");
  });

  it("subscription without a window: turns and tokens only, never a percentage", async () => {
    const { button } = renderFooter(subscriptionUsageSummary());
    expect(button.textContent).toContain("12 turns today · ≈ 18k tokens");
    expect(screen.queryByTestId("usage-ring")).toBeNull();
    expect(button.textContent).not.toMatch(/%/);
    await userEvent.hover(button);
    const card = await screen.findByTestId("usage-card");
    expect(card.textContent).toContain("isn't available from this CLI");
    expect(card.textContent).not.toMatch(/%/);
  });

  it("subscription with the plan's window: a ring, and the share with its reset in the card", async () => {
    const { button } = renderFooter({
      ...subscriptionUsageSummary(),
      planWindow: {
        modelRef: "claude-code/sonnet",
        usedFraction: 0.62,
        resetsAt: "2026-10-18T14:00:00.000Z",
      },
    });
    expect(screen.getByTestId("usage-ring")).toBeTruthy();
    await userEvent.hover(button);
    const card = await screen.findByTestId("usage-card");
    expect(card.textContent).toMatch(/62% of the plan window used · resets/);
  });

  it("focus opens the card with the week by model", async () => {
    const { button } = renderFooter(budgeted(12.6, 40));
    button.focus();
    const card = await screen.findByTestId("usage-card");
    expect(within(card).getByText("This week by model")).toBeTruthy();
    expect(card.textContent).toContain("claude-sonnet-5-5");
    expect(card.textContent).toMatch(/\$12\.60 of \$40\.00 this month \(32%\)/);
  });

  it("the rail shows the graphic alone, with the numbers in its name", () => {
    const { button } = renderFooter(usageSummary(), "rail");
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toContain("$0.42 today");
    expect(screen.getByTestId("usage-sparkline")).toBeTruthy();
  });
});

describe("the connected footer", () => {
  it("reads usage.summary in this device's time zone and refreshes after a run ends", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld onGateway={(g) => (gateway = g)}>
        <ShellMotion>
          <ConnectedSidebar
            route="/feed"
            onNavigate={() => {}}
            activeThreadId={null}
            onOpenThread={() => {}}
            now={STORY_NOW}
          />
        </ShellMotion>
      </StoryWorld>,
    );
    const footer = await screen.findByTestId("usage-footer");
    expect(footer.textContent).toContain("$0.42 today");
    const g = gateway as MockGateway;
    const calls = () => g.calls.filter((c) => c.method === "usage.summary");
    expect(calls()[0]?.params).toMatchObject({ days: 7 });
    const first = calls()[0]?.params as { timeZone?: unknown } | undefined;
    expect(typeof first?.timeZone).toBe("string");
    const before = calls().length;
    const run = g.world.runs[0] as Run;
    g.emit("run.updated", {
      run: { ...run, status: "done", endedAt: "2026-10-18T10:13:00.000Z" },
    });
    await waitFor(() => expect(calls().length).toBeGreaterThan(before), { timeout: 3000 });
  });
});
