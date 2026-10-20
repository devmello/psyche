// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayStatus } from "../../src/client/status.ts";
import { OfflineBanner } from "../../src/shell/components/Chrome.tsx";

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
