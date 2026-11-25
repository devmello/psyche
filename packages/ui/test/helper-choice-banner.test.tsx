import type { ApprovalRequest } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type GatewayClient,
  GatewayProvider,
  GatewayRequestError,
  GatewayStore,
} from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import {
  HelperChoiceBanner,
  HelperOfflineBanner,
} from "../src/screens/settings/HelperOfflineBanner.tsx";
import { SettingsApprovalContext } from "../src/screens/settings/shared.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

const candidates = [
  { deviceId: "dev_old_a1f3", name: "Psyche (Helper)", pairedAt: "2026-11-06T13:03:00.000Z" },
  { deviceId: "dev_new_9c2d", name: "Psyche (Helper)", pairedAt: "2026-11-13T05:27:00.000Z" },
];

describe("HelperChoiceBanner", () => {
  it("tells identical-looking helpers apart by what the Gateway knows, and pins the one tapped", async () => {
    const onChoose = vi.fn().mockResolvedValue(undefined);
    render(<HelperChoiceBanner candidates={candidates} onChoose={onChoose} />);
    const banner = screen.getByTestId("helper-choice-banner");
    expect(banner.textContent).toContain("More than one Psyche Helper is connected");
    expect(banner.textContent).not.toContain("Two");
    const buttons = within(banner).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toMatch(/^Use the helper paired .*Nov 6.*\(…a1f3\)$/);
    expect(buttons[1]?.textContent).toMatch(/^Use the helper paired .*Nov 13.*\(…9c2d\)$/);
    // The name is secondary text, a claim the helper makes about itself.
    expect(banner.textContent).toContain("Calls itself: Psyche (Helper)");
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("dev_new_9c2d"));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("works for a helper with no known pairing time, and for three helpers", () => {
    render(
      <HelperChoiceBanner
        candidates={[
          ...candidates,
          { deviceId: "dev_third_77ee", name: "Psyche (Helper)", pairedAt: null },
        ]}
        onChoose={vi.fn()}
      />,
    );
    const buttons = within(screen.getByTestId("helper-choice-banner")).getAllByRole("button");
    expect(buttons.map((b) => b.textContent).at(-1)).toBe("Use the helper (…77ee)");
  });

  it("says why when the choice could not be saved, and lets the owner retry", async () => {
    const onChoose = vi.fn().mockRejectedValueOnce(new Error("offline"));
    render(<HelperChoiceBanner candidates={candidates} onChoose={onChoose} />);
    const first = within(screen.getByTestId("helper-choice-banner")).getAllByRole("button")[0];
    fireEvent.click(first as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId("helper-choice-error").textContent).toContain("offline"),
    );
    onChoose.mockResolvedValueOnce(undefined);
    fireEvent.click(first as HTMLElement);
    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(2));
  });

  it("hands an approval request to the Settings banner and writes again with the approval", async () => {
    const asked = vi.fn();
    const onChoose = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError("settings.set", "approval_required", "x", { approvalId: "ap_9" }),
      );
    render(
      <SettingsApprovalContext.Provider value={asked}>
        <HelperChoiceBanner candidates={candidates} onChoose={onChoose} />
      </SettingsApprovalContext.Provider>,
    );
    fireEvent.click(
      within(screen.getByTestId("helper-choice-banner")).getAllByRole("button")[1] as HTMLElement,
    );
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    const pending = asked.mock.calls[0]?.[0] as {
      key: string;
      approvalId: string;
      label: string;
      retry: (id: string) => Promise<unknown>;
    };
    expect(pending).toMatchObject({
      key: "devices.hostHelperDeviceId",
      approvalId: "ap_9",
      label: "Which Psyche Helper to use",
    });
    expect(screen.queryByTestId("helper-choice-error")).toBeNull();
    onChoose.mockResolvedValueOnce(undefined);
    await pending.retry("ap_9");
    expect(onChoose).toHaveBeenLastCalledWith("dev_new_9c2d", "ap_9");
  });
});

describe("HelperOfflineBanner with a verifier enrolled", () => {
  function gateway(statusAmbiguous: boolean) {
    const inner = new MockGateway(
      (() => {
        const w = createFixtureWorld();
        w.settings["devices.helper.availability"] = {
          connected: false,
          failures: 0,
          retryAt: 0,
          contactsDenied: false,
          ambiguous: candidates,
        };
        w.settings["devices.hostHelper.status"] = {
          ambiguous: statusAmbiguous,
          helpers: statusAmbiguous ? 2 : 0,
        };
        return w;
      })(),
      { now: () => FIXTURE_NOW },
    );
    const writes: unknown[] = [];
    const base = inner.world.approvals[0] as ApprovalRequest;
    const client: GatewayClient = {
      async request(method, params, opts) {
        const p = params as { key?: string; approvalId?: string };
        if (method === "settings.set") writes.push(params);
        if (
          method === "settings.set" &&
          p.key === "devices.hostHelperDeviceId" &&
          p.approvalId === undefined
        ) {
          const { target: _target, ...rest } = base;
          const approval: ApprovalRequest = {
            ...rest,
            id: "ap_pin",
            kind: "policy_change",
            summary: "Change devices.hostHelperDeviceId",
            details: { setting: p.key, value: "x" },
            requestedBy: { deviceId: "dev_this" } as ApprovalRequest["requestedBy"],
            surfaces: ["desktop", "notification"],
            scopesOffered: ["once"],
            deviceOnly: true,
            requiresAuthentication: false,
            taint: false,
            status: "pending",
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
          inner.world.approvals.push(approval);
          inner.world.answerTokens[approval.id] = "tok_pin";
          inner.emit("approval.created", { approval, answerToken: "tok_pin" });
          throw new GatewayRequestError(method, "approval_required", "Approve the change first", {
            approvalId: approval.id,
          });
        }
        return inner.request(method, params, opts);
      },
      subscribe: (l) => inner.subscribe(l),
      connectionState: () => inner.connectionState(),
      onConnectionState: (l) => inner.onConnectionState(l),
    };
    render(
      <GatewayProvider client={client} store={new GatewayStore(client, { now: () => FIXTURE_NOW })}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <HelperOfflineBanner state={{ kind: "offline" } as never} onReconnect={vi.fn()} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    return { writes };
  }

  it("shows the plain-tap card on the first tap, then pins with the approval once approved", async () => {
    const { writes } = gateway(true);
    const banner = await screen.findByTestId("helper-choice-banner");
    await userEvent.click(within(banner).getAllByRole("button")[1] as HTMLElement);
    const card = await screen.findByTestId("settings-approval");
    // Words, not the setting key.
    expect(card.textContent).toContain("Which Psyche Helper to use");
    expect(card.textContent).not.toContain("devices.hostHelperDeviceId needs");
    await waitFor(() => expect(within(card).queryByText("Loading the approval…")).toBeNull());
    const allow = within(card).getByRole("button", { name: "Allow" });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(allow);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      key: "devices.hostHelperDeviceId",
      value: "dev_new_9c2d",
      approvalId: "ap_pin",
    });
  });

  it("shows Reconnect, not the choice, when the registry reports no conflict (a list left over from a restart)", async () => {
    gateway(false);
    expect(await screen.findByTestId("helper-offline-banner")).toBeTruthy();
    expect(screen.queryByTestId("helper-choice-banner")).toBeNull();
  });
});
