// @vitest-environment happy-dom

import { GatewayProvider, setUiPlatform, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureWorld, FIXTURE_NOW } from "../../../../packages/ui/src/fixtures/index.ts";
import { ComputerUseSettings } from "../../src/compose/permissions.tsx";
import type { HelperPermissionsState, ShellPlatform } from "../../src/shell/platform.ts";

/**
 * Settings → Computer use shows what Psyche Helper was granted (macOS grants are per app), says
 * so when the helper is offline, and re-reads when the window regains focus.
 */

afterEach(() => {
  cleanup();
  setUiPlatform(undefined);
});

const base: ShellPlatform = {
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

const state = (over: Partial<HelperPermissionsState> = {}): HelperPermissionsState => ({
  helper: "online",
  accessibility: "not_determined",
  screenRecording: "not_determined",
  ...over,
});

function open(permissions: NonNullable<ShellPlatform["permissions"]>) {
  setUiPlatform("macos");
  const gw = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gw}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ComputerUseSettings platform={{ ...base, permissions }} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
}

describe("Settings → Computer use reads Psyche Helper, not Psyche.app", () => {
  it("shows the helper's state even when Psyche.app is allowed", async () => {
    const status = vi.fn(async () => ({ accessibility: "granted", screenRecording: "granted" }));
    open({
      status,
      request: vi.fn(),
      helperStatus: async () => state({ accessibility: "not_determined" }),
      helperRequest: vi.fn(),
    } as never);
    expect(
      await screen.findByRole("button", { name: /Allow Psyche Helper for Accessibility/ }),
    ).toBeTruthy();
    expect(status).not.toHaveBeenCalled();
    expect(screen.queryAllByText("Granted")).toHaveLength(0);
  });

  it("says the helper is offline instead of Granted, with no Allow button", async () => {
    open({
      status: async () => ({ accessibility: "granted", screenRecording: "granted" }),
      request: vi.fn(),
      helperStatus: async () => state({ helper: "offline" }),
      helperRequest: vi.fn(),
    } as never);
    expect((await screen.findAllByText("Helper offline")).length).toBe(2);
    expect(screen.queryAllByText("Granted")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Allow Psyche Helper/ })).toBeNull();
  });

  it("Allow asks through the helper, and the row updates from its answer", async () => {
    const helperRequest = vi.fn(async () => state({ accessibility: "granted" }));
    const request = vi.fn();
    open({
      status: async () => ({}),
      request,
      helperStatus: async () => state(),
      helperRequest,
    } as never);
    fireEvent.click(
      await screen.findByRole("button", { name: /Allow Psyche Helper for Accessibility/ }),
    );
    await waitFor(() => expect(helperRequest).toHaveBeenCalledWith("accessibility"));
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText("Granted").length).toBe(1));
  });

  it("re-reads when the window regains focus (the owner returns from System Settings)", async () => {
    let current = state();
    const helperStatus = vi.fn(async () => current);
    open({
      status: async () => ({}),
      request: vi.fn(),
      helperStatus,
      helperRequest: vi.fn(),
    } as never);
    await screen.findByRole("button", { name: /Allow Psyche Helper for Screen Recording/ });
    const reads = helperStatus.mock.calls.length;
    current = state({ accessibility: "granted", screenRecording: "granted" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getAllByText("Granted").length).toBe(2));
    expect(helperStatus.mock.calls.length).toBeGreaterThan(reads);
  });
});
