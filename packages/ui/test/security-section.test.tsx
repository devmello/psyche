import type { SecurityStateStatus } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SecuritySection } from "../src/screens/settings/SecuritySection.tsx";
import { SettingsApprovalProvider } from "../src/screens/settings/SettingsApproval.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const T0 = "2026-11-20T10:00:00.000Z";

const base = (): SecurityStateStatus => ({
  status: "sealed",
  reason: null,
  alerts: [
    {
      id: "al_changed",
      kind: "state_changed_outside",
      severity: "warning",
      details: { changes: [{ table: "devices", change: "added", name: "Intruder" }], more: 2 },
      createdAt: T0,
      acknowledgedAt: null,
    },
    {
      id: "al_old",
      kind: "state_first_seal",
      severity: "info",
      details: { devices: 1 },
      createdAt: T0,
      acknowledgedAt: T0,
    },
    {
      id: "al_req",
      kind: "recovery_requested",
      severity: "warning",
      details: { recoveryId: "rc_grant", op: "devices.grant", deviceName: "Work laptop" },
      createdAt: T0,
      acknowledgedAt: null,
    },
  ],
  recoveries: [
    {
      id: "rc_grant",
      op: "devices.grant",
      status: "waiting",
      requestedAt: T0,
      notBefore: "2026-11-21T10:00:00.000Z",
      decidedAt: null,
      deviceName: "Work laptop",
      outcome: null,
    },
    {
      id: "rc_seal",
      op: "seal.reset",
      status: "waiting",
      requestedAt: T0,
      notBefore: "2026-11-21T10:00:00.000Z",
      decidedAt: null,
      outcome: null,
    },
  ],
});

function setup(
  edit: (security: SecurityStateStatus) => SecurityStateStatus = (s) => s,
  needs = false,
) {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        w.security = edit(base());
        if (needs) w.securityNeedsApproval = true;
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <SettingsApprovalProvider>
        <SecuritySection />
      </SettingsApprovalProvider>
    </StoryWorld>,
  );
  const calls = (method: string) =>
    (gw as MockGateway | null)?.calls.filter((c) => c.method === method) ?? [];
  return { gateway: () => gw as unknown as MockGateway, calls };
}

describe("Settings → Security records", () => {
  it("lists open alerts and waiting recoveries, not reviewed alerts or the request's own alert", async () => {
    setup();
    expect(await screen.findAllByTestId("security-alert")).toHaveLength(1);
    expect(screen.getAllByTestId("security-recovery")).toHaveLength(2);
    expect(screen.getByText(/devices · Intruder/)).toBeTruthy();
    expect(screen.getByText("Intact")).toBeTruthy();
  });

  it("says so when nothing needs review", async () => {
    setup(() => ({ status: "sealed", reason: null, alerts: [], recoveries: [] }));
    expect(await screen.findByText(/Nothing to review/)).toBeTruthy();
  });

  it("marks an alert reviewed and reloads the list", async () => {
    const { calls } = setup();
    const alert = await screen.findByTestId("security-alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(screen.queryByTestId("security-alert")).toBeNull());
    expect(calls("security.alerts.acknowledge")[0]?.params).toEqual({ id: "al_changed" });
  });

  it("cancels a waiting request only after a confirm that says what happens", async () => {
    const { calls } = setup();
    const [row] = await screen.findAllByTestId("security-recovery");
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Cancel request" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/will not be made/)).toBeTruthy();
    expect(calls("security.recoveries.cancel")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(calls("security.recoveries.cancel")).toHaveLength(0);
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Cancel request" }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel request",
      }),
    );
    await waitFor(() => expect(calls("security.recoveries.cancel")).toHaveLength(1));
    expect(calls("security.recoveries.cancel")[0]?.params).toEqual({ id: "rc_grant" });
    await waitFor(() => expect(screen.getAllByTestId("security-recovery")).toHaveLength(1));
  });

  it("approves a waiting request now after a confirm", async () => {
    const { calls } = setup();
    const [row] = await screen.findAllByTestId("security-recovery");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Approve now" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/instead of on/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply now" }));
    await waitFor(() => expect(calls("security.recoveries.approve")).toHaveLength(1));
    expect(calls("security.recoveries.approve")[0]?.params).toEqual({ id: "rc_grant" });
  });

  it("offers no Approve for a re-seal or while the records are untrusted, but still Cancel", async () => {
    setup();
    const [, seal] = await screen.findAllByTestId("security-recovery");
    expect(within(seal as HTMLElement).queryByRole("button", { name: "Approve now" })).toBeNull();
    expect(
      within(seal as HTMLElement).getByRole("button", { name: "Cancel request" }),
    ).toBeTruthy();
  });

  it("hides Approve and the untrusted alert's button while untrusted", async () => {
    setup((s) => ({
      ...s,
      status: "untrusted",
      reason: "key_changed",
      alerts: [
        {
          id: "al_untrusted",
          kind: "state_untrusted",
          severity: "warning",
          details: { reason: "key_changed" },
          createdAt: T0,
          acknowledgedAt: null,
        },
      ],
    }));
    await screen.findAllByTestId("security-alert");
    expect(screen.getByText("Not trusted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Cancel request" }).length).toBeGreaterThan(0);
  });

  it("shows a refused action inline and leaves the list alone", async () => {
    const { gateway } = setup();
    const alert = await screen.findByTestId("security-alert");
    gateway().failNext("security.alerts.acknowledge", "forbidden", "needs operator.admin");
    await userEvent.click(within(alert).getByRole("button", { name: "Mark reviewed" }));
    expect((await screen.findByRole("alert")).textContent).toContain("needs operator.admin");
    expect(screen.getAllByTestId("security-alert")).toHaveLength(1);
  });

  it("follows a security.state.changed event", async () => {
    const { gateway } = setup();
    await screen.findAllByTestId("security-alert");
    act(() => {
      const w = gateway().world;
      if (w.security) w.security.alerts = w.security.alerts.filter((a) => a.id !== "al_changed");
      gateway().emit("security.state.changed", {
        status: "sealed",
        openAlerts: 0,
        waitingRecoveries: 2,
      });
    });
    await waitFor(() => expect(screen.queryByTestId("security-alert")).toBeNull());
  });

  it("shows the approval card when the Gateway asks for one and leaves the list alone", async () => {
    const { calls } = setup((s) => s, true);
    const alert = await screen.findByTestId("security-alert");
    await userEvent.click(within(alert).getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByTestId("settings-approval")).toBeTruthy();
    expect(calls("security.alerts.acknowledge")).toHaveLength(1);
    expect(screen.getAllByTestId("security-alert")).toHaveLength(1);
  });
});
