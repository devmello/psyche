import { describe, expect, it, vi } from "vitest";
import { startShell } from "../src/main/startup.ts";

/** A supervisor that never finishes starting the Gateway (pairing, a slow boot, an outage). */
function stuckSupervisor() {
  let started = false;
  return {
    get started() {
      return started;
    },
    ensureRunning: () => {
      started = true;
      return new Promise<void>(() => undefined);
    },
  };
}

describe("startShell (issue #441)", () => {
  it("shows and focuses the window without waiting for the Gateway", () => {
    const order: string[] = [];
    const supervisor = stuckSupervisor();
    const onShown = vi.fn();
    startShell({
      showMain: () => order.push("show"),
      focusApp: () => order.push("focus"),
      startGateway: () => {
        order.push("gateway");
        return supervisor.ensureRunning();
      },
      openedAtLogin: false,
      onShown,
      now: () => 1234,
    });
    // Synchronously: the window is up and in front while the Gateway is still starting.
    expect(order).toEqual(["show", "focus", "gateway"]);
    expect(supervisor.started).toBe(true);
    expect(onShown).toHaveBeenCalledWith(1234);
  });

  it("stays in the background when opened at login, and survives a failed Gateway start", async () => {
    const focusApp = vi.fn();
    const warn = vi.fn();
    startShell({
      showMain: () => undefined,
      focusApp,
      startGateway: () => Promise.reject(new Error("port in use")),
      openedAtLogin: true,
      warn,
    });
    expect(focusApp).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("the Gateway did not start: port in use");
  });
});
