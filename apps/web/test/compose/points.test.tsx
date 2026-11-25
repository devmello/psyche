// @vitest-environment happy-dom

import { GatewayProvider, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureWorld, FIXTURE_NOW } from "../../../../packages/ui/src/fixtures/index.ts";
import { PointsHost, pointsPortOf } from "../../src/compose/points.tsx";
import type {
  HelperPermissionsState,
  ShellCommand,
  ShellPlatform,
} from "../../src/shell/platform.ts";

/**
 * Psyche points in the composed app: the helper's permission port is offered only to a window that
 * may ask for it, and the tray's command opens the start sheet (and nothing else).
 */

afterEach(cleanup);

const granted: HelperPermissionsState = {
  helper: "online",
  accessibility: "granted",
  screenRecording: "granted",
  notifications: "granted",
};

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

const withPort = (over: Partial<ShellPlatform> = {}): ShellPlatform => ({
  ...base,
  permissions: {
    status: async () => ({}),
    request: async () => "granted",
    helperStatus: async () => granted,
    helperRequest: async () => granted,
  },
  ...over,
});

describe("pointsPortOf", () => {
  it("offers the helper calls to the desktop (positive control)", async () => {
    const port = pointsPortOf(withPort());
    expect(port).toBeDefined();
    await expect(port?.helperStatus()).resolves.toMatchObject({ accessibility: "granted" });
  });

  it("offers nothing to a window onto another Mac's Gateway", () => {
    const remote = withPort({
      chrome: { titleBar: "native", remote: { hostName: "Studio Mac" } } as never,
    });
    expect(pointsPortOf(remote)).toBeUndefined();
  });

  it("offers nothing without the desktop's helper calls", () => {
    expect(pointsPortOf(base)).toBeUndefined();
    expect(
      pointsPortOf({
        ...base,
        permissions: { status: async () => ({}), request: async () => "granted" },
      }),
    ).toBeUndefined();
  });
});

describe("the tray command", () => {
  function host(platform: ShellPlatform, listeners: ((c: ShellCommand) => void)[]) {
    const world = createFixtureWorld();
    world.hostOs = "macos";
    world.settings["points.enabled"] = true;
    world.pointsWindows = [
      {
        ref: "w1",
        app: { bundleId: "com.apple.Safari", name: "Safari" },
        title: "Tax",
        frontmost: true,
      },
    ];
    const gw = new MockGateway(world, { now: () => FIXTURE_NOW });
    const port = pointsPortOf(platform);
    render(
      <GatewayProvider client={gw}>
        <UiSlotsProvider value={{ ...(port ? { points: port } : {}) }}>
          <PointsHost
            platform={{
              ...platform,
              windows: {
                onCommand: (cb: (c: ShellCommand) => void) => {
                  listeners.push(cb);
                  return () => {};
                },
              } as never,
            }}
          />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    return gw;
  }

  it("opens the start sheet with the window main found behind Psyche chosen", async () => {
    const listeners: ((c: ShellCommand) => void)[] = [];
    const gw = host(withPort(), listeners);
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    // The setting and the Host's OS load first; only then is Points offered.
    await waitFor(() => expect(gw.calls.some((c) => c.method === "gateway.info")).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      for (const cb of listeners) cb({ type: "points", window: "w1" });
    });
    const sheet = await screen.findByTestId("points-sheet");
    expect(sheet).toBeTruthy();
    const safari = (await screen.findByRole("radio", { name: /Safari/ })) as HTMLInputElement;
    await waitFor(() => expect(safari.checked).toBe(true));
    // Opening the sheet starts nothing.
    expect(gw.calls.some((c) => c.method === "points.start")).toBe(false);
  });

  it("opens nothing in a window that has no helper port", async () => {
    const listeners: ((c: ShellCommand) => void)[] = [];
    host(base, listeners);
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      for (const cb of listeners) cb({ type: "points" });
    });
    expect(screen.queryByTestId("points-sheet")).toBeNull();
  });
});
