import { approvalCode } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { answerFailureText, classifyAnswerError } from "../src/blocks/answer-error.ts";
import { GatewayRequestError } from "../src/data/client.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { en } from "../src/i18n/messages/index.ts";
import { PasswordPresenceGroup } from "../src/screens/settings/PasswordPresenceGroup.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * Password presence on Linux (linux design §9): the card says what the system dialog is for while
 * it waits, each refusal reads as its fix, and Settings → Devices names the state.
 */

const NOW = Date.parse(FIXTURE_NOW);

function approval(): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "policy_change",
    summary: "Change a security setting",
    requiresAuthentication: true,
    deviceOnly: true,
    taint: false,
    scopesOffered: ["once"],
  } as ApprovalRequest;
}

function show(onAnswer: (...a: unknown[]) => Promise<void>, a = approval()) {
  render(
    <UiSlotsProvider value={{ passwordPresence: true, touchIdOnceOnly: true }}>
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
}

const fail = (code: string, reason: string) =>
  new GatewayRequestError("approvals.approveWithPassword", code, "x", { reason });

describe("approval card with password presence", () => {
  it("says it needs a password and that approvals here are once only", () => {
    show(async () => undefined);
    expect(screen.getByText(en["blocks.approval.password.needsAuth"])).toBeTruthy();
    expect(screen.queryByText(en["blocks.approval.password.waiting"])).toBeNull();
  });

  it("names the code and waits for the password while the system dialog is up", async () => {
    let finish: () => void = () => undefined;
    const a = approval();
    show(() => new Promise<void>((r) => (finish = r)), a);
    await userEvent.click(screen.getByRole("button", { name: "Allow with scope" }));
    const waiting = await screen.findByTestId("password-waiting");
    expect(waiting.textContent).toContain(approvalCode(a.bindingHash));
    expect(waiting.textContent).toContain("Waiting for your password");
    finish();
    await waitFor(() => expect(screen.queryByTestId("password-waiting")).toBeNull());
  });

  it("shows a refusal as its fix, and no waiting text afterwards", async () => {
    show(async () => {
      throw fail("presence_agent_missing", "agent_missing");
    });
    await userEvent.click(screen.getByRole("button", { name: "Allow with scope" }));
    expect((await screen.findByRole("alert")).textContent).toContain("polkit agent");
    expect(screen.queryByTestId("password-waiting")).toBeNull();
  });
});

describe("password refusals", () => {
  const text = (e: unknown) => answerFailureText(classifyAnswerError(e));
  it("maps the four presence codes, the dialog outcomes and a missing bus", () => {
    expect(text(fail("presence_unavailable_here", "no_session"))).toBe(
      en["blocks.approval.password.unavailableHere"],
    );
    expect(text(fail("presence_agent_missing", "agent_missing"))).toBe(
      en["blocks.approval.password.agentMissing"],
    );
    expect(text(fail("presence_policy_missing", "policy_missing"))).toBe(
      en["blocks.approval.password.policyMissing"],
    );
    expect(text(fail("presence_not_enforced", "not_enforced"))).toBe(
      en["blocks.approval.password.notEnforced"],
    );
    expect(text(fail("cancelled", "presence_cancelled"))).toBe(
      en["blocks.approval.password.cancelled"],
    );
    expect(text(fail("forbidden", "password_failed"))).toBe(en["blocks.approval.password.failed"]);
    expect(text(fail("unavailable", "polkit_unreachable"))).toBe(
      en["blocks.approval.password.unreachable"],
    );
  });
});

describe("Settings → Devices password row", () => {
  it.each([
    ["ready", "settings.devices.password.state.ready"],
    ["policy_missing", "settings.devices.password.state.policyMissing"],
    ["not_enforced", "settings.devices.password.state.notEnforced"],
    ["no_session", "settings.devices.password.state.noSession"],
    ["agent_missing", "settings.devices.password.state.agentMissing"],
  ] as const)("shows %s", (state, chip) => {
    render(<PasswordPresenceGroup row={{ state }} />);
    expect(screen.getByText(en[chip])).toBeTruthy();
    expect(screen.queryByTestId("password-x11-warning")).toBeNull();
  });

  it("warns on a ready X11 session only", () => {
    const { unmount } = render(<PasswordPresenceGroup row={{ state: "ready", detail: "x11" }} />);
    expect(screen.getByTestId("password-x11-warning").textContent).toContain("X11");
    unmount();
    render(<PasswordPresenceGroup row={{ state: "no_session", detail: "x11" }} />);
    expect(screen.queryByTestId("password-x11-warning")).toBeNull();
  });
});
