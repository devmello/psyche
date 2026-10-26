import type { Meta, StoryObj } from "@storybook/react-vite";
import { subscriptionUsageSummary, usageSummary } from "../fixtures/usage.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { ShellMotion } from "./motion.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { UsageCard, UsageFooter, type UsageSummaryData } from "./UsageFooter.tsx";

const meta = {
  title: "Shell/Usage",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const withBudget = (spent: number, budget: number): UsageSummaryData => ({
  ...usageSummary(),
  month: { ...usageSummary().month, costUsd: spent },
  budgetUsd: budget,
});

const withWindow = (usedFraction: number): UsageSummaryData => ({
  ...subscriptionUsageSummary(),
  planWindow: {
    modelRef: "claude-code/sonnet",
    usedFraction,
    resetsAt: "2026-10-18T14:00:00.000Z",
  },
});

/** The sidebar with a given usage summary in its footer. */
function InSidebar({
  summary,
  mode = "full",
}: {
  summary: UsageSummaryData;
  mode?: "full" | "rail";
}) {
  return (
    <ShellMotion>
      <div className="flex h-[560px]">
        <Sidebar
          route="/feed"
          onNavigate={() => {}}
          activeThreadId={null}
          onOpenThread={() => {}}
          mode={mode}
          now={STORY_NOW}
          renderUsage={(variant, name) => (
            <UsageFooter summary={summary} variant={variant} name={name} />
          )}
        />
      </div>
    </ShellMotion>
  );
}

export const ApiKey: Story = { render: () => <InSidebar summary={usageSummary()} /> };
export const ApiKeyBudget: Story = { render: () => <InSidebar summary={withBudget(12.6, 40)} /> };
export const ApiKeyBudgetWarning: Story = {
  render: () => <InSidebar summary={withBudget(34, 40)} />,
};
export const ApiKeyOverBudget: Story = { render: () => <InSidebar summary={withBudget(43, 40)} /> };
export const Subscription: Story = {
  render: () => <InSidebar summary={subscriptionUsageSummary()} />,
};
export const SubscriptionWindow: Story = { render: () => <InSidebar summary={withWindow(0.62)} /> };
/** #606: a Claude Code primary whose CLI reports turns but no token counts. */
export const SubscriptionTurnsOnly: Story = {
  render: () => (
    <InSidebar
      summary={{
        ...subscriptionUsageSummary(),
        today: { tokens: 0, costUsd: 0, turns: 3, byModel: [] },
        primary: "claude-code/haiku",
      }}
    />
  ),
};

/** No usage yet today: "No usage today", never "$0.00 today · 0 tokens". */
export const NoUsageToday: Story = {
  render: () => (
    <InSidebar
      summary={{ ...usageSummary(), today: { tokens: 0, costUsd: 0, turns: 0, byModel: [] } }}
    />
  ),
};

export const Rail: Story = { render: () => <InSidebar summary={usageSummary()} mode="rail" /> };
export const RailWindow: Story = {
  render: () => <InSidebar summary={withWindow(0.86)} mode="rail" />,
};

/** The hover/focus card on its own. */
export const Card: Story = {
  render: () => (
    <div className="w-72 rounded-lg bg-surface-raised p-3 shadow-elevation-2">
      <UsageCard summary={withBudget(12.6, 40)} />
    </div>
  ),
};

export const CardSubscription: Story = {
  render: () => (
    <div className="w-72 rounded-lg bg-surface-raised p-3 shadow-elevation-2">
      <UsageCard summary={subscriptionUsageSummary()} />
    </div>
  ),
};
