import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { type UiSlots, UiSlotsProvider } from "../src/slots.tsx";

/**
 * A card on a client of another computer's Gateway (remote-gateway design §6.2, owner decision
 * G3): a risky one needs a passkey from this computer, and without one it says "Answer on <host>"
 * with Allow off; an ordinary one is unaffected, and Deny always works.
 */

const NOW = Date.parse(FIXTURE_NOW);

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return { ...base, taint: false, scopesOffered: ["once"], ...over } as ApprovalRequest;
}

function show(a: ApprovalRequest, slots: UiSlots, onAnswer = vi.fn(async () => undefined)) {
  render(
    <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" }, ...slots }}>
      <ApprovalCard
        approval={a}
        persona="Wren"
        canAnswer
        now={NOW}
        armDelayMs={0}
        mode="balanced"
        onAnswer={onAnswer as never}
      />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const allow = () => screen.getByRole("button", { name: "Allow with scope" }) as HTMLButtonElement;

describe("risky card on a remote client", () => {
  const risky = () => approval({ requiresAuthentication: true });

  it("without a passkey says where to answer, and Allow stays off", async () => {
    const onAnswer = show(risky(), {
      remotePresence: { hostName: "studio-mac", hasPasskey: false },
    });
    expect(screen.getByTestId("answer-on-host").textContent).toContain("Answer on studio-mac");
    expect(allow().disabled).toBe(true);
    await userEvent.click(allow());
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Deny still works without a passkey", async () => {
    const onAnswer = show(risky(), {
      remotePresence: { hostName: "studio-mac", hasPasskey: false },
    });
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledWith("deny", undefined, undefined);
  });

  it("with a passkey Allow is on and there is no 'Answer on' line", async () => {
    const onAnswer = show(risky(), {
      remotePresence: { hostName: "studio-mac", hasPasskey: true },
    });
    expect(screen.queryByTestId("answer-on-host")).toBeNull();
    expect(allow().disabled).toBe(false);
    await userEvent.click(allow());
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});

describe("ordinary card on a remote client", () => {
  it("needs no passkey (G3)", async () => {
    const onAnswer = show(approval({ requiresAuthentication: false, deviceOnly: false }), {
      remotePresence: { hostName: "studio-mac", hasPasskey: false },
    });
    expect(screen.queryByTestId("answer-on-host")).toBeNull();
    expect(allow().disabled).toBe(false);
    await userEvent.click(allow());
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});

describe("a card on This Mac or the web", () => {
  it("is unchanged: no remote slot, no 'Answer on' line", () => {
    show(approval({ requiresAuthentication: true }), {});
    expect(screen.queryByTestId("answer-on-host")).toBeNull();
    expect(allow().disabled).toBe(false);
  });
});
