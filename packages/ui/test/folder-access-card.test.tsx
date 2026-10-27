import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * The folder-access card (security §3.5): shows what the agent asked for, the owner's own pick
 * is what is sent, taint leaves only Allow once, and Allow stays off until a folder is chosen.
 */

const NOW = Date.parse(FIXTURE_NOW);

function folderApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "folder_access",
    summary: "Share a folder: ~/Projects/app",
    details: { requestedPath: "~/Projects/app", reason: "to read the build notes", access: "rw" },
    scopesOffered: ["once", "always"],
    deviceOnly: true,
    requiresAuthentication: false,
    taint: false,
    ...over,
  } as ApprovalRequest;
}

function show(
  approval: ApprovalRequest,
  pickFolder?: () => Promise<string | null>,
  onAnswer = vi.fn(),
) {
  render(
    <UiSlotsProvider value={pickFolder ? { pickFolder } : {}}>
      <ApprovalCard approval={approval} canAnswer now={NOW} armDelayMs={0} onAnswer={onAnswer} />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

describe("folder-access card", () => {
  it("shows the folder asked for, the reason and the access level", () => {
    show(folderApproval(), async () => null);
    expect(screen.getByText("~/Projects/app", { selector: "code,span" })).toBeTruthy();
    expect(screen.getByText("to read the build notes")).toBeTruthy();
    expect(screen.getByText("Read and write")).toBeTruthy();
  });

  it("offers Allow once, Always allow and Deny", () => {
    show(folderApproval(), async () => null);
    for (const name of ["Allow once", "Always allow", "Deny"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("sends the folder the owner picked with the chosen scope, never the agent's string", async () => {
    const pick = vi.fn(async () => "/Users/me/Projects/app");
    const onAnswer = show(folderApproval(), pick);
    const allow = screen.getByRole("button", { name: "Allow with scope" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() =>
      expect(screen.getByTestId("folder-picked").textContent).toBe("/Users/me/Projects/app"),
    );
    await userEvent.click(screen.getByRole("radio", { name: "Always allow" }));
    await userEvent.click(screen.getByRole("button", { name: "Allow with scope" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(onAnswer).toHaveBeenCalledWith("approve", "always", {
      folderPath: "/Users/me/Projects/app",
    });
  });

  it("a tainted request offers only Allow once", () => {
    show(folderApproval({ taint: true, scopesOffered: ["once"] }), async () => null);
    expect(screen.getByRole("radio", { name: "Allow once" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Always allow" })).toBeNull();
    expect(screen.getByText(/Only Allow once is offered/)).toBeTruthy();
  });

  it("Deny needs no folder", async () => {
    const onAnswer = show(folderApproval(), async () => null);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("deny", undefined, undefined));
  });
});
