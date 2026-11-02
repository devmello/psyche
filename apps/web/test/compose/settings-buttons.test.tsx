// @vitest-environment happy-dom

import { GatewayProvider, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureWorld, FIXTURE_NOW } from "../../../../packages/ui/src/fixtures/index.ts";
import { settingsRoute } from "../../src/compose/settings.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/**
 * The composed Settings (what the web and desktop apps render) against the kit's mock Gateway:
 * the buttons that did nothing because the shell passed no callbacks now reach the Gateway
 * (docs/design/settings-2026.md §6).
 */

afterEach(cleanup);

const platform: ShellPlatform = {
  kind: "web",
  gateway: {
    getStatus: async () => ({ phase: "paired", health: "healthy" }) as never,
    onStatus: () => () => {},
    call: async () => ({}),
    onEvent: () => () => {},
    onResync: () => () => {},
  },
  storage: { get: () => null, set: () => {} },
  notify: { show: () => {} },
};

function open(route: string, openExternal = vi.fn(async () => {})) {
  const gw = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gw}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" }, openExternal }}>
        {settingsRoute(route, () => undefined, platform)}
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  const called = (method: string) => gw.calls.some((c) => c.method === method);
  return { called, openExternal };
}

describe("Settings buttons in the composed app", () => {
  it("About → Run checks runs real checks", async () => {
    const { called } = open("/settings/about");
    fireEvent.click(await screen.findByRole("button", { name: "Run checks" }));
    expect(await screen.findByText("Answering.")).toBeTruthy();
    expect(called("sandbox.status")).toBe(true);
  });

  it("Usage shows this month from usage.summary", async () => {
    const { called } = open("/settings/usage");
    expect(await screen.findByRole("heading", { name: "This month" })).toBeTruthy();
    expect(called("usage.summary")).toBe(true);
  });

  it("Connectors → Disconnect calls the Gateway", async () => {
    const { called } = open("/settings/connectors");
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect Gmail" }, { timeout: 3000 }),
    );
    await waitFor(() => expect(called("connectors.disconnect")).toBe(true));
  });

  it("Server → Set up opens the remote-access guide", async () => {
    const { openExternal } = open("/settings/server");
    fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("server-mode"));
  });

  it("Privacy & data → Export everything saves the zip", async () => {
    const create = vi.fn(() => "blob:psyche");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { called } = open("/settings/data");
    fireEvent.click(await screen.findByRole("button", { name: "Export everything" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(called("memory.export")).toBe(true);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});
