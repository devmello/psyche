// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayStatus } from "../../src/client/status.ts";
import { OfflineBanner } from "../../src/shell/components/Chrome.tsx";
import {
  PAIRING_GRACE_AFTER_PAIRED_MS,
  PAIRING_GRACE_MS,
  usePairingGrace,
} from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);

const offline: GatewayStatus = { health: "unreachable", phase: "connecting", attempt: 0 };

describe("OfflineBanner with the desktop supervisor's state", () => {
  it("says why the Gateway did not start and opens the logs", () => {
    const onShowLogs = vi.fn();
    render(
      <OfflineBanner
        status={offline}
        run={{
          kind: "stopped",
          mode: "launchd",
          reason: "The Gateway did not answer within 60 s",
          logs: "/Users/me/.psyche/logs",
        }}
        onShowLogs={onShowLogs}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("did not answer within 60 s");
    fireEvent.click(screen.getByRole("button", { name: "Show logs" }));
    expect(onShowLogs).toHaveBeenCalledOnce();
  });

  it("shows the start in progress, and nothing once paired or after Quit entirely", () => {
    const { rerender, container } = render(
      <OfflineBanner status={offline} run={{ kind: "starting", mode: "launchd" }} />,
    );
    expect(screen.getByTestId("gateway-starting-banner")).toBeTruthy();
    rerender(
      <OfflineBanner
        status={{ ...offline, phase: "paired", health: "ok" }}
        run={{ kind: "stopped", mode: "launchd", reason: "x", logs: "/l" }}
      />,
    );
    expect(container.textContent).toBe("");
    rerender(
      <OfflineBanner status={offline} run={{ kind: "stopped", mode: "launchd", reason: "quit" }} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("the pairing banner on the desktop (#539)", () => {
  const pending: GatewayStatus = { health: "ok", phase: "pending", pairingCode: "K7Q", attempt: 0 };

  function Probe({ status, desktop }: { status: GatewayStatus; desktop: boolean }) {
    const grace = usePairingGrace(status, desktop);
    return <OfflineBanner status={status} pairingGrace={grace} />;
  }

  it("says Connecting during the reconnect window and shows the code only if pending persists", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Probe status={pending} desktop />);
      expect(screen.getByTestId("connecting-banner").textContent).toBe("Connecting to Psyche…");
      expect(screen.queryByTestId("pairing-banner")).toBeNull();
      // Paired within moments, as the bootstrapped admin always is: no code ever shows.
      rerender(<Probe status={{ ...pending, phase: "paired" }} desktop />);
      rerender(<Probe status={pending} desktop />);
      act(() => vi.advanceTimersByTime(PAIRING_GRACE_MS));
      // A window that was already paired gets the longer grace.
      expect(screen.getByTestId("connecting-banner")).toBeTruthy();
      act(() => vi.advanceTimersByTime(PAIRING_GRACE_AFTER_PAIRED_MS - PAIRING_GRACE_MS));
      expect(screen.getByTestId("pairing-banner").textContent).toContain("K7Q");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the code right away on the web, where pairing is the real flow", () => {
    render(<Probe status={pending} desktop={false} />);
    expect(screen.getByTestId("pairing-banner").textContent).toContain("K7Q");
  });
});
