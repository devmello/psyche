import type { DailyWorkflowProposal } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationWorkflowBlockView,
  AutomationWorkflowCardView,
} from "../src/blocks/AutomationWorkflowCard.tsx";
import { blockRenderer } from "../src/blocks/registry.tsx";
import type { GatewayClient } from "../src/data/client.ts";
import { GatewayProvider } from "../src/data/provider.tsx";
import "../src/blocks/MessageBlocks.tsx";

const proposal: DailyWorkflowProposal = {
  groupId: "canvas-assignments-ab12cd",
  title: "Canvas assignments",
  timezone: "America/Los_Angeles",
  notify: "notification",
  obstacles: ["Canvas needs a sign-in; a calendar feed avoids 2FA."],
  offerSkill: true,
  tainted: true,
  runs: [
    {
      name: "Morning check",
      kind: "cron",
      schedule: "0 9 * * *",
      humanSchedule: "Every day at 9:00 AM",
      prompt: "x",
      steps: ["Read Canvas for assignments due", "Add reminders due 10pm"],
      approvals: ["Add reminders: asks each run"],
    },
    {
      name: "Evening check",
      kind: "cron",
      schedule: "30 23 * * *",
      humanSchedule: "Every day at 11:30 PM",
      prompt: "y",
      steps: ["Check the morning's reminders are submitted"],
      approvals: [],
    },
  ],
};

describe("workflow confirm card", () => {
  it("lists each schedule with time, timezone, steps, approvals, notification and obstacles", () => {
    render(
      <AutomationWorkflowCardView
        proposal={proposal}
        state="idle"
        onConfirm={() => {}}
        onDecline={() => {}}
      />,
    );
    const runs = screen.getAllByTestId("workflow-run");
    expect(runs).toHaveLength(2);
    expect(
      within(runs[0] as HTMLElement).getByText(
        "Morning check · Every day at 9:00 AM (America/Los_Angeles)",
      ),
    ).toBeTruthy();
    expect(within(runs[0] as HTMLElement).getByText("Add reminders: asks each run")).toBeTruthy();
    expect(within(runs[1] as HTMLElement).getByText("No approvals needed.")).toBeTruthy();
    expect(screen.getByText("Tells you with a notification when it needs you.")).toBeTruthy();
    expect(screen.getByText(/Canvas needs a sign-in/)).toBeTruthy();
    expect(screen.getByText(/planned after reading content from the web/)).toBeTruthy();
    expect(screen.getByText(/save these steps as a skill/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeTruthy();
  });

  it("is registered, and confirming calls daily.workflows.confirm with the proposal", async () => {
    expect(blockRenderer("automation_workflow")).toBeDefined();
    const request = vi.fn().mockResolvedValue({ automations: [{ id: "a1" }, { id: "a2" }] });
    const client = {
      request,
      subscribe: () => () => {},
      connectionState: () => "open",
      onConnectionState: () => () => {},
    } as unknown as GatewayClient;
    render(
      <GatewayProvider client={client}>
        <AutomationWorkflowBlockView proposal={proposal} />
      </GatewayProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(screen.getByText(/Scheduled 2 runs/)).toBeTruthy());
    expect(request).toHaveBeenCalledWith(
      "daily.workflows.confirm",
      { proposal },
      expect.anything(),
    );
    expect(screen.queryByRole("button", { name: "Schedule" })).toBeNull();
  });

  it("says so when scheduling fails, and keeps the buttons; Not now settles the card", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error("bad schedule")),
      subscribe: () => () => {},
      connectionState: () => "open",
      onConnectionState: () => () => {},
    } as unknown as GatewayClient;
    render(
      <GatewayProvider client={client}>
        <AutomationWorkflowBlockView proposal={proposal} />
      </GatewayProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(screen.getByText(/Couldn't schedule this/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText("Not scheduled.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Schedule" })).toBeNull();
  });
});
