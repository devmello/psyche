import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Skills Psyche wrote itself: the Settings badge and history, and the approval card's content. */

const base = {
  id: "apr_1",
  summary: 'Update skill "weekly-report" (made by Psyche)',
  kind: "skill_install",
  bindingHash: "sha256:x",
  grantKey: null,
  scopesOffered: ["once"],
  deviceOnly: true,
  requiresAuthentication: false,
  taint: false,
  status: "pending",
  requestedAt: "2026-10-19T15:30:00.000Z",
  expiresAt: "2026-10-19T15:45:00.000Z",
  surfaces: ["desktop"],
  sideEffect: "destructive",
  requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1", toolCallId: "c1" },
};

describe("Settings → Skills, agent-made skills", () => {
  it("badges a skill Psyche made and lists its earlier versions", async () => {
    render(
      <StoryWorld>
        <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="skills" />
      </StoryWorld>,
    );
    const row = await screen.findByTestId("skill-weekly-report");
    expect(within(row).getByText(/^Made by /)).toBeTruthy();
    // Owner-installed skills carry no such badge.
    expect(
      within(await screen.findByTestId("skill-receipt-filer")).queryByText(/Made by/),
    ).toBeNull();
    // Removable like any installed skill.
    expect(within(row).getByRole("button", { name: /More/i })).toBeTruthy();
    const history = within(row).getByTestId("skill-history");
    expect(history.textContent).toContain("1 earlier version");
    expect(history.textContent).toContain("v1");
  });
});

describe("approval card for an agent-written skill", () => {
  const details = {
    action: "update",
    madeBy: "agent",
    name: "weekly-report",
    hash: `sha256:${"a".repeat(64)}`,
    fromHash: `sha256:${"b".repeat(64)}`,
    text: "---\nname: weekly-report\n---\n\n# Weekly report\n\n3. Post nothing anywhere.\n",
    diff: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -5,1 +5,2 @@\n 2. Summarize.\n+3. Post nothing anywhere.\n",
    files: ["SKILL.md"],
  };

  it("shows the full text and the diff against the approved version", async () => {
    const { container } = render(
      <ApprovalDetails approval={{ ...base, details } as unknown as ApprovalRequest} />,
    );
    expect(container.textContent).toMatch(/Change a skill made by/i);
    await userEvent.click(screen.getByText("View full text"));
    expect(container.textContent).toContain("3. Post nothing anywhere.");
    await userEvent.click(screen.getByText("View diff"));
    await waitFor(() => expect(container.textContent).toContain("+3. Post nothing anywhere."));
  });

  it("other skill_install cards (MCP servers, connectors) render as before", () => {
    const { container } = render(
      <ApprovalDetails
        approval={
          {
            ...base,
            details: { kind: "mcp_server", id: "x", name: "My server" },
          } as unknown as ApprovalRequest
        }
      />,
    );
    expect(container.textContent).not.toContain("View full text");
    expect(container.textContent).toContain("My server");
  });
});
