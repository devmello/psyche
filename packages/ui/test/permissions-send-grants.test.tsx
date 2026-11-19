import type { Grant } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionsPanel } from "../src/screens/settings/PermissionsSection.tsx";

/** Settings → Permissions lists the recipients an email send is always allowed to, with Remove. */

function grant(over: Partial<Grant>): Grant {
  return {
    id: "grant-send-jane",
    kind: "send_email",
    scope: "always",
    grantKey: "send_email:me@example.com:jane@example.com",
    subject: { recipient: "jane@example.com", account: "me@example.com" },
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

describe("Settings: recipients an email send is always allowed to", () => {
  it("lists the grant by recipient and Remove calls the revoke for that grant", async () => {
    const g = grant({});
    const onRevoke = panel([g]);
    const group = screen.getByRole("region", { name: "Recipients you always allow" });
    expect(within(group).getByText("to jane@example.com")).toBeTruthy();
    await userEvent.click(
      within(group).getByRole("button", { name: "Revoke to jane@example.com" }),
    );
    expect(onRevoke).toHaveBeenCalledWith(g);
  });

  it("shows the empty line when no recipient is always allowed", () => {
    panel([grant({ kind: "new_origin", subject: { origin: "https://a.example" } })]);
    const group = screen.getByRole("region", { name: "Recipients you always allow" });
    expect(within(group).getByText("No recipient is set to always allow.")).toBeTruthy();
  });

  it("leaves out a revoked send grant", () => {
    panel([grant({ revokedAt: "2026-11-11T09:00:00.000Z" })]);
    const group = screen.getByRole("region", { name: "Recipients you always allow" });
    expect(within(group).queryByRole("button")).toBeNull();
    expect(within(group).getByText("No recipient is set to always allow.")).toBeTruthy();
  });
});
