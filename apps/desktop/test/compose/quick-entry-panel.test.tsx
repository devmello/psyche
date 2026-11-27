// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import { QuickEntryPanel } from "../../src/compose/QuickEntryPanel.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

function setup(phase: GatewayStatus["phase"] = "paired") {
  const calls: [string, unknown][] = [];
  const listeners = new Set<(e: GatewayEvent) => void>();
  const closeWindow = vi.fn();
  const platform = {
    kind: "desktop",
    windows: { closeWindow },
    gateway: {
      getStatus: async () => ({ phase, health: "ok", attempt: 0 }) as GatewayStatus,
      onStatus: () => () => {},
      onResync: () => () => {},
      onEvent: (cb: (e: GatewayEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      call: async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === "threads.list")
          return { threads: [{ thread: { id: "th_main", kind: "main" } }] };
        if (method === "approvals.list") return { approvals: [{ status: "pending" }] };
        return {};
      },
    },
  } as unknown as ShellPlatform;
  render(<QuickEntryPanel platform={platform} />);
  return { calls, closeWindow, listeners };
}

describe("QuickEntryPanel (served from the small panel entry)", () => {
  it("sends to the main chat and closes", async () => {
    const { calls, closeWindow } = setup();
    const input = await screen.findByTestId("quick-input");
    await waitFor(() => expect(calls.some(([m]) => m === "threads.list")).toBe(true));
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    // Wait until the main thread is known.
    await waitFor(() => expect(calls.some(([m]) => m === "approvals.list")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(closeWindow).toHaveBeenCalled());
    expect(calls).toContainEqual(["chat.send", { threadId: "th_main", content: "hello" }]);
  });

  it("is disabled until paired (positive control above)", async () => {
    setup("connecting" as GatewayStatus["phase"]);
    const input = (await screen.findByTestId("quick-input")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("sets the theme and defines the bar's shell variables", async () => {
    setup();
    const bar = await screen.findByTestId("quick-entry");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBeTruthy());
    expect(bar.style.getPropertyValue("--shell-muted")).toContain("--label-secondary");
    expect(bar.style.getPropertyValue("--shell-border")).toContain("--separator");
  });

  it("Escape closes without sending", async () => {
    const { calls, closeWindow } = setup();
    const input = await screen.findByTestId("quick-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(closeWindow).toHaveBeenCalled();
    expect(calls.some(([m]) => m === "chat.send")).toBe(false);
  });
});
