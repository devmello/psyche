import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/** An email send that offers Always keeps it for this recipient, as a visible choice on the card. */

const NOW = Date.parse(FIXTURE_NOW);

function approval(over: Partial<ApprovalRequest>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "send_email",
    sideEffect: "write",
    summary: "Send an email to Jane",
    details: { to: ["jane@example.com"], subject: "Lunch", account: "me@example.com" },
    deviceOnly: false,
    taint: false,
    scopesOffered: ["once", "always"],
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

const recipientChoice = () => screen.queryByRole("checkbox", { name: /Always allow sending to/ });
const allow = () => screen.getByRole("button", { name: "Allow with scope" });

describe("Always allow for this recipient on an email send card", () => {
  it("shows the named choice when Always is offered", () => {
    show(approval({}));
    const box = screen.getByRole("checkbox", {
      name: "Always allow sending to jane@example.com",
    });
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("ticking it selects Always, which still confirms before the answer", async () => {
    const onAnswer = show(approval({}));
    await userEvent.click(screen.getByRole("checkbox", { name: /Always allow sending to/ }));
    expect((screen.getByRole("combobox", { name: "Allow for" }) as HTMLSelectElement).value).toBe(
      "always",
    );
    await userEvent.click(allow());
    const dialog = await screen.findByRole("alertdialog");
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not show the choice when Always is not offered", () => {
    show(approval({ scopesOffered: ["once"] }));
    expect(recipientChoice()).toBeNull();
  });

  it("does not show the choice on a tainted send, which offers Allow once only", () => {
    show(approval({ taint: true }));
    expect(recipientChoice()).toBeNull();
    expect(screen.queryByRole("option", { name: "Always allow" })).toBeNull();
  });

  it("uses the generic wording when there is no single recipient", () => {
    show(approval({ details: { to: ["a@example.com", "b@example.com"] } }));
    expect(screen.getByRole("checkbox", { name: "Always allow for this recipient" })).toBeTruthy();
    expect(recipientChoice()).toBeNull();
  });
});
