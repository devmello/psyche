import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { AboutSection } from "../src/screens/settings/AboutSection.tsx";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { DataControlsSection } from "../src/screens/settings/DataControlsSection.tsx";
import { ServerSection } from "../src/screens/settings/ServerSection.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { UsageSection } from "../src/screens/settings/UsageSection.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Every Settings button does something in the composed app, which passes none of the old shell
 * callbacks (settings-2026 §6): each section calls the Gateway itself.
 */

function setup(ui: React.ReactElement, slots: UiSlots = {}) {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)} slots={slots}>
      {ui}
    </StoryWorld>,
  );
  const calls = (method: string) => (gw?.calls ?? []).filter((c) => c.method === method);
  return { calls };
}

describe("Settings buttons call the Gateway on their own", () => {
  it("Connectors: Disconnect and Sign in again", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<ConnectorsSection />);
    await user.click(await screen.findByRole("button", { name: "Disconnect Gmail" }));
    await waitFor(() => expect(calls("connectors.disconnect")).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "Sign in again" }));
    await waitFor(() =>
      expect(
        calls("connectors.connect").some(
          (c) => (c.params as { connectorId?: string }).connectorId !== undefined,
        ),
      ).toBe(true),
    );
  });

  it("Usage reads usage.summary", async () => {
    const { calls } = setup(<UsageSection />);
    expect(await screen.findByRole("heading", { name: "This month" })).toBeTruthy();
    expect(calls("usage.summary").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Last 7 days by model" })).toBeTruthy();
  });

  it("Server builds its status from the Gateway and Set up opens the guide", async () => {
    const openExternal = vi.fn(async () => {});
    setup(<ServerSection />, { openExternal });
    expect(
      await screen.findByText("Remote access status isn't available on this device."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("server-mode"));
    expect(screen.queryByRole("button", { name: /Start VM|Stop VM/ })).toBeNull();
  });

  it("About runs real checks", async () => {
    const { calls } = setup(<AboutSection info={null} />);
    await userEvent.click(await screen.findByRole("button", { name: "Run checks" }));
    expect(await screen.findByText("Answering.")).toBeTruthy();
    expect(calls("sandbox.status").length).toBeGreaterThan(0);
    expect(calls("memory.status").length).toBeGreaterThan(0);
  });

  it("Export saves the zip without a shell handler", async () => {
    const create = vi.fn(() => "blob:psyche");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    setup(<DataControlsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Export everything" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe("Controls nothing reads are gone (settings-2026 §6)", () => {
  const unread = [
    "vault.backend",
    "vault.fillDefault",
    "data.transcriptRecall",
    "models.image",
    "vm.clipboard",
    "vm.credentials",
    "vm.shares",
  ];

  it.each([["permissions"], ["memory"], ["model"]] as const)(
    "the %s page shows none of them",
    async (page) => {
      setup(<SettingsScreen defaultSection={page} />);
      await screen.findByRole("heading", { level: 2 });
      await new Promise((r) => setTimeout(r, 300));
      for (const key of unread)
        expect(document.querySelector(`[data-setting-key="${key}"]`), key).toBeNull();
      expect(screen.queryByText("Image")).toBeNull();
      expect(within(document.body).queryByText("Where credentials are kept")).toBeNull();
    },
  );
});
