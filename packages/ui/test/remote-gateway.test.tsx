import type { Device, PairingRequest } from "@psyche/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupFingerprint } from "../src/lib/fingerprint.ts";
import { ComputerUseSection } from "../src/screens/settings/ComputerUseSection.tsx";
import { DevicesPanel, defaultPairScopes } from "../src/screens/settings/DevicesSection.tsx";
import { GatewaysGroup } from "../src/screens/settings/GatewaysGroup.tsx";
import { type GatewayEntry, type GatewaysSlot, UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const request = (over: Partial<PairingRequest> = {}): PairingRequest =>
  ({
    id: "pr_1",
    kind: "device",
    code: "ABCD-2345",
    status: "pending",
    deviceId: "d9",
    display: "Psyche Desktop (ThinkPad) (macos, desktop; claimed by the device)",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    transport: "ws",
    remoteAddress: "100.64.0.9",
    ...over,
  }) as PairingRequest;

const noDevices: Device[] = [];

describe("a pairing request from another computer (remote-gateway design §3.4, §3.5)", () => {
  it("starts with read, write and approvals ticked and admin off", () => {
    expect(defaultPairScopes(request())).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
    ]);
    // A request from this Mac keeps what it had.
    expect(defaultPairScopes(request({ remoteAddress: "127.0.0.1" }))).toEqual([
      "operator.read",
      "operator.write",
    ]);
    expect(defaultPairScopes(request({ transport: "unix", remoteAddress: "unix" }))).toEqual([
      "operator.read",
      "operator.write",
    ]);
  });

  it("approves with exactly the ticked scopes: admin is an opt-in", async () => {
    const onApprove = vi.fn();
    render(
      <StoryWorld>
        <DevicesPanel
          devices={noDevices}
          pairing={[request()]}
          nodes={[]}
          onApprove={onApprove}
          gatewayFingerprint={`sha256:${"cd34".repeat(16)}`}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("From 100.64.0.9")).toBeTruthy();
    expect(screen.getByText("This Gateway's key cd34 cd34 cd34 cd34 cd34 cd34")).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Admin" }) as HTMLInputElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "pr_1" }), [
      "operator.read",
      "operator.write",
      "operator.approvals",
    ]);
  });

  it("shows no network details for a request from this Mac", () => {
    render(
      <StoryWorld>
        <DevicesPanel
          devices={noDevices}
          pairing={[request({ remoteAddress: "127.0.0.1" })]}
          nodes={[]}
          gatewayFingerprint={`sha256:${"cd34".repeat(16)}`}
        />
      </StoryWorld>,
    );
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText(/This Gateway's key/)).toBeNull();
  });
});

describe("fingerprint grouping", () => {
  it("is the same on both screens", () => {
    expect(groupFingerprint(`sha256:${"0123456789abcdef".repeat(4)}`)).toBe(
      "0123 4567 89ab cdef 0123 4567",
    );
  });
});

function slot(entries: GatewayEntry[], over: Partial<GatewaysSlot> = {}): GatewaysSlot {
  return {
    list: async () => entries,
    add: vi.fn(async (address: string) => ({
      id: "gw_1",
      name: address,
      origin: `https://${address}`,
      remote: true,
      active: false,
      pinned: false,
    })),
    remove: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
    ...over,
  };
}

const thisMac: GatewayEntry = {
  id: "this-mac",
  name: "This Mac",
  origin: null,
  remote: false,
  active: true,
  pinned: false,
};
const studio: GatewayEntry = {
  id: "gw_0123456789ab",
  name: "studio-mac",
  origin: "https://studio-mac.tail1234.ts.net",
  remote: true,
  active: false,
  pinned: true,
};

describe("Settings → Gateways on this computer", () => {
  it("lists This Mac and the saved Gateways, and marks which is active and pinned", async () => {
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways: slot([thisMac, studio]) }}>
          <GatewaysGroup />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    expect(await screen.findByText("studio-mac")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Identity pinned")).toBeTruthy();
    expect(screen.getByText("https://studio-mac.tail1234.ts.net")).toBeTruthy();
  });

  it("keeps This Mac's Gateway running by default and offers to stop it as a separate step", async () => {
    const gateways = slot([thisMac, studio]);
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways }}>
          <GatewaysGroup />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Switch to studio-mac" }));
    expect(
      screen.getByText(
        "Psyche restarts on studio-mac. Psyche on this Mac keeps running, so its automations continue.",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(gateways.switchTo).toHaveBeenCalledWith("gw_0123456789ab", undefined);
    await userEvent.click(
      screen.getByRole("button", { name: "Switch and stop Psyche on this Mac" }),
    );
    expect(gateways.switchTo).toHaveBeenLastCalledWith("gw_0123456789ab", { stopLocal: true });
  });

  it("says why an address was refused, in the owner's words", async () => {
    const gateways = slot([thisMac], {
      add: async () => {
        throw Object.assign(new Error("gateway address"), {
          code: "invalid_params",
          details: { problem: "needs_full_name" },
        });
      },
    });
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ gateways }}>
          <GatewaysGroup />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    await userEvent.type(await screen.findByLabelText("Address"), "studio-mac");
    await userEvent.click(screen.getByRole("button", { name: "Add Gateway" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Use the full name, like studio-mac.your-tailnet.ts.net. A short name can't be checked.",
        ),
      ).toBeTruthy(),
    );
  });

  it("draws nothing where there is no switcher (the web)", () => {
    const { container } = render(
      <StoryWorld>
        <GatewaysGroup />
      </StoryWorld>,
    );
    expect(container.textContent).not.toContain("Gateways on this computer");
  });
});

describe("computer use on a client of another computer (decision G5)", () => {
  it("says it works at the Host and shows no controls", () => {
    render(
      <StoryWorld>
        <UiSlotsProvider value={{ remoteHost: "studio-mac" }}>
          <ComputerUseSection />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    expect(screen.getByTestId("computer-use-remote").textContent).toBe(
      "Computer use works at studio-mac. Ask from there, or use the browser.",
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
