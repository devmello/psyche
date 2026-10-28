import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { floorClassOf } from "../src/blocks/LiftFloorDialog.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * Security §3.12: a send / destructive / financial card offers Always allow behind a confirm; a
 * tainted one offers only Allow once (§3.6).
 */

const NOW = Date.parse(FIXTURE_NOW);

function approval(over: Partial<ApprovalRequest>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "connector_action",
    sideEffect: "destructive",
    summary: "Delete the note “Groceries” in Notes",
    details: {},
    deviceOnly: true,
    taint: false,
    scopesOffered: ["once", "task", "always"],
    ...over,
  } as ApprovalRequest;
}

function show(a: ApprovalRequest) {
  const onAnswer = vi.fn();
  render(
    <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
      <ApprovalCard
        approval={a}
        persona="Wren"
        canAnswer
        now={NOW}
        armDelayMs={0}
        onAnswer={onAnswer}
      />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const scopeSelect = () => screen.getByRole("combobox", { name: "Allow for" });
const allow = () => screen.getByRole("button", { name: "Allow with scope" });

describe("Always allow on a floored card (§3.12)", () => {
  it("classes cards like the broker", () => {
    expect(floorClassOf("connector_action", "destructive")).toBe("destructive");
    expect(floorClassOf("send_email", "write")).toBe("send");
    expect(floorClassOf("connector_action", "financial")).toBe("financial");
    expect(floorClassOf("purchase", "financial")).toBeNull();
    expect(floorClassOf("credential_fill", "write")).toBeNull();
    expect(floorClassOf("connector_action", "write")).toBeNull();
  });

  it("offers Always allow, confirms, then answers always", async () => {
    const onAnswer = show(approval({}));
    const options = within(scopeSelect())
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toContain("Always allow");
    await userEvent.selectOptions(scopeSelect(), "always");
    await userEvent.click(allow());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Wren can do this again");
    expect(dialog.textContent).toContain("may not be recoverable");
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "always", undefined));
  });

  it("cancelling the confirm answers nothing; Allow once needs no confirm", async () => {
    const onAnswer = show(approval({}));
    await userEvent.selectOptions(scopeSelect(), "always");
    await userEvent.click(allow());
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.selectOptions(scopeSelect(), "once");
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a tainted card offers only Allow once", () => {
    show(approval({ taint: true, kind: "send_email", sideEffect: "write" }));
    expect(screen.queryByRole("combobox", { name: "Allow for" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Always allow" })).toBeNull();
  });
});
