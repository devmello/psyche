// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import {
  SPLASH_ESCAPE_MS,
  StartupSplash,
  splashLine,
} from "../../src/shell/components/StartupSplash.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const connecting: GatewayStatus = { health: "unknown", phase: "connecting", attempt: 0 };
const healthy: GatewayStatus = { health: "ok", phase: "verifying", attempt: 0 };
const paired: GatewayStatus = { health: "ok", phase: "paired", attempt: 0, scopes: [] };

function platform(over: Partial<ShellPlatform["gateway"]> = {}, splash = true): ShellPlatform {
  return {
    kind: "desktop",
    chrome: { titleBar: "inset", ...(splash ? { splash: true } : {}) },
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: () => () => {},
      onEvent: () => () => {},
      onResync: () => () => {},
      call: async () => ({}),
      ...over,
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
}

describe("splash line", () => {
  it("says what Psyche is doing, in Psyche's words", () => {
    const line = (
      s: GatewayStatus,
      run?: Parameters<typeof splashLine>[0]["run"],
      helper?: "starting",
    ) => splashLine({ status: s, run, helper }).text;
    expect(line(connecting)).toBe("Psyche is starting…");
    expect(line(connecting, { kind: "starting", mode: "launchd", step: "installing" })).toBe(
      "Setting up Psyche on this Mac…",
    );
    expect(line(connecting, { kind: "starting", mode: "launchd", step: "waiting" })).toBe(
      "Almost ready…",
    );
    expect(line(connecting, { kind: "running", mode: "dev" })).toBe("Almost ready…");
    expect(line(healthy, { kind: "running", mode: "launchd" })).toBe("Connecting…");
    expect(line(healthy, { kind: "running", mode: "launchd" }, "starting")).toBe(
      "Getting Psyche ready on your Mac…",
    );
    expect(line(paired)).toBe("Ready");
    expect(
      splashLine({
        status: connecting,
        run: { kind: "stopped", mode: "launchd", reason: "psyched is not bundled" },
        helper: undefined,
      }),
    ).toEqual({ tone: "error", text: "Psyche couldn't start", reason: "psyched is not bundled" });
  });
});

describe("StartupSplash (#539)", () => {
  it("is the main window's first content and gives way in place once paired", () => {
    vi.useFakeTimers();
    try {
      const p = platform();
      const { rerender } = render(
        <StartupSplash
          platform={p}
          status={connecting}
          run={{ kind: "unknown" }}
          helper={undefined}
        />,
      );
      expect(screen.getByTestId("startup-splash")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("Psyche is starting…");
      rerender(
        <StartupSplash
          platform={p}
          status={paired}
          run={{ kind: "running", mode: "launchd" }}
          helper={undefined}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe("Ready");
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByTestId("startup-splash")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Show logs and Retry when the start failed, and the app on request", () => {
    const showLogs = vi.fn(async () => {});
    const retry = vi.fn(async () => {});
    render(
      <StartupSplash
        platform={platform({ showLogs, retry })}
        status={connecting}
        run={{ kind: "stopped", mode: "launchd", reason: "launchctl could not load", logs: "/l" }}
        helper={undefined}
      />,
    );
    expect(screen.getByText("launchctl could not load")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(showLogs).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Open Psyche anyway" }));
    expect(screen.queryByTestId("startup-splash")).toBeNull();
  });

  it("never traps the owner: the app is one click away after a few seconds", () => {
    vi.useFakeTimers();
    try {
      render(
        <StartupSplash
          platform={platform()}
          status={connecting}
          run={{ kind: "starting", mode: "launchd", step: "waiting" }}
          helper={undefined}
        />,
      );
      expect(screen.queryByRole("button", { name: "Open Psyche anyway" })).toBeNull();
      act(() => vi.advanceTimersByTime(SPLASH_ESCAPE_MS));
      expect(screen.getByRole("button", { name: "Open Psyche anyway" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show when main decided there is nothing to wait for", () => {
    render(
      <StartupSplash
        platform={platform({}, false)}
        status={connecting}
        run={undefined}
        helper={undefined}
      />,
    );
    expect(screen.queryByTestId("startup-splash")).toBeNull();
  });
});
