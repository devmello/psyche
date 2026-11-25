import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * An email send that offers Always keeps it for the whole recipient set. The card names that set
 * from the request's own target, in the shape the Gateway sends (`details` = {tool, params, target}).
 */

const NOW = Date.parse(FIXTURE_NOW);
const ACCOUNT = "me@example.com";

/** The broker's canonical target for a send to `recipients` (sorted, deduped, to + cc + bcc). */
function sendApproval(
  recipients: string[],
  params: { to: string[]; cc?: string[]; bcc?: string[] },
  over: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  const value = [...new Set(recipients)].sort().join(",");
  return {
    ...base,
    kind: "send_email",
    sideEffect: "write",
    summary: "Send an email",
    details: {
      tool: "gmail_send",
      params: { subject: "Lunch", body: "Noon?", cc: [], bcc: [], ...params },
      target: { kind: "recipient", value, display: value.split(",").join(", ") },
    },
    target: { kind: "recipient", value, display: value.split(",").join(", ") },
    grantKey: `send_email:${ACCOUNT}:${value}`,
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

const recipientChoice = (name: string | RegExp = /^Always allow sending to/) =>
  screen.queryByRole("button", { name });
const allow = () =>
  screen.getByRole("button", { name: /^(Allow|Allow sending to .* for this task)$/ });

describe("Always allow for this recipient on an email send card", () => {
  it("names the one recipient and the account on the one second choice", () => {
    show(sendApproval(["jane@example.com"], { to: ["jane@example.com"] }));
    expect(
      screen.getByRole("button", {
        name: `Always allow sending to jane@example.com from ${ACCOUNT}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("names a bcc recipient too: to jane plus bcc evil lists both", () => {
    show(
      sendApproval(["jane@example.com", "evil@example.net"], {
        to: ["jane@example.com"],
        bcc: ["evil@example.net"],
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Always allow sending to evil@example.net, jane@example.com from ${ACCOUNT}`,
      }),
    ).toBeTruthy();
  });

  it("lists every address when there are several", () => {
    show(
      sendApproval(["a@example.com", "b@example.com", "c@example.com"], {
        to: ["a@example.com", "b@example.com"],
        cc: ["c@example.com"],
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Always allow sending to a@example.com, b@example.com, c@example.com from ${ACCOUNT}`,
      }),
    ).toBeTruthy();
  });

  it("choosing it sends always, and the floor confirm still comes before the answer", async () => {
    const onAnswer = show(sendApproval(["jane@example.com"], { to: ["jane@example.com"] }));
    await userEvent.click(recipientChoice() as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(recipientChoice() as HTMLElement);
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Always allow" }),
    );
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "always", undefined));
  });

  it("plain Allow sends the narrowest scope offered, never always", async () => {
    const onAnswer = show(
      sendApproval(
        ["jane@example.com"],
        { to: ["jane@example.com"] },
        { scopesOffered: ["task", "always"] },
      ),
    );
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("approve", "task", undefined));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not show the choice when Always is not offered", () => {
    show(
      sendApproval(["jane@example.com"], { to: ["jane@example.com"] }, { scopesOffered: ["once"] }),
    );
    expect(recipientChoice()).toBeNull();
  });

  it("does not show the choice on a tainted send, which offers Allow once only", () => {
    show(sendApproval(["jane@example.com"], { to: ["jane@example.com"] }, { taint: true }));
    expect(recipientChoice()).toBeNull();
    expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
  });

  it("without a recipient set it does not claim one (control: with it, the names show)", () => {
    const control = render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={sendApproval(["jane@example.com"], { to: ["jane@example.com"] })}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={vi.fn()}
        />
      </UiSlotsProvider>,
    );
    expect(recipientChoice()).toBeTruthy();
    control.unmount();
    show(sendApproval(["jane@example.com"], { to: ["jane@example.com"] }, { target: undefined }));
    expect(recipientChoice()).toBeNull();
    expect(screen.queryByTestId("approval-second-choice")).toBeNull();
  });
});
