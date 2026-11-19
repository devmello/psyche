import type { Grant } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionsPanel } from "../src/screens/settings/PermissionsSection.tsx";

/** Settings → Permissions lists the recipient sets an email send is always allowed to, with Revoke. */

const ACCOUNT = "me@example.com";

/** A send grant in the broker's shape: subject = {grantKey, ...grantFields, target, sideEffect}. */
function sendGrant(recipient: string, over: Partial<Grant> = {}): Grant {
  const grantKey = `send_email:${ACCOUNT}:${recipient}`;
  return {
    id: `grant-${recipient}`,
    kind: "send_email",
    scope: "always",
    grantKey,
    subject: {
      grantKey,
      account: ACCOUNT,
      target: { kind: "recipient", value: recipient, display: recipient },
      sideEffect: "write",
    },
    binding: null,
    expiresAt: null,
    useCount: 3,
    lastUsedAt: null,
    createdFromApprovalId: null,
    taskId: null,
    createdAt: "2026-11-10T09:00:00.000Z",
    revokedAt: null,
    ...over,
  } as Grant;
}

function panel(grants: Grant[], onRevoke = vi.fn()) {
  render(
    <PermissionsPanel
      values={{}}
      onChange={() => {}}
      connectors={[]}
      grants={grants}
      onRevoke={onRevoke}
    />,
  );
  return onRevoke;
}

const region = () => screen.getByRole("region", { name: "Recipients you always allow" });

describe("Settings: recipients an email send is always allowed to", () => {
  it("names the recipient and account, and Remove calls the revoke for that grant", async () => {
    const g = sendGrant("jane@example.com");
    const onRevoke = panel([g]);
    expect(within(region()).getByText(`to jane@example.com from ${ACCOUNT}`)).toBeTruthy();
    await userEvent.click(
      within(region()).getByRole("button", {
        name: `Revoke to jane@example.com from ${ACCOUNT}`,
      }),
    );
    expect(onRevoke).toHaveBeenCalledWith(g);
  });

  it("never reads as any recipient, and two grants render as two distinct rows", async () => {
    const jane = sendGrant("jane@example.com");
    const bob = sendGrant("bob@example.com");
    const onRevoke = panel([jane, bob]);
    expect(screen.queryByText(/any recipient/)).toBeNull();
    expect(within(region()).getByText(`to jane@example.com from ${ACCOUNT}`)).toBeTruthy();
    expect(within(region()).getByText(`to bob@example.com from ${ACCOUNT}`)).toBeTruthy();
    await userEvent.click(
      within(region()).getByRole("button", { name: `Revoke to bob@example.com from ${ACCOUNT}` }),
    );
    expect(onRevoke).toHaveBeenCalledWith(bob);
  });

  it("shows the empty line when no recipient is always allowed", () => {
    panel([sendGrant("jane@example.com", { kind: "new_origin" })]);
    expect(within(region()).getByText("No recipient is set to always allow.")).toBeTruthy();
  });

  it("leaves out a revoked send grant", () => {
    panel([sendGrant("jane@example.com", { revokedAt: "2026-11-11T09:00:00.000Z" })]);
    expect(within(region()).queryByRole("button")).toBeNull();
    expect(within(region()).getByText("No recipient is set to always allow.")).toBeTruthy();
  });
});
