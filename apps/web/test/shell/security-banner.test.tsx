// @vitest-environment happy-dom

import type { SecurityStateStatus } from "@psyche/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { SecurityStateBanner } from "../../src/shell/components/SecurityStateBanner.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/**
 * The security-records banner (docs/design/security-state-integrity-2026.md §7.3): shown on every
 * screen while an alert is open or a request from the Mac waits; reviewing needs the owner's
 * approval card when presence is set up.
 */

afterEach(cleanup);

const changed: SecurityStateStatus = {
  status: "sealed",
  reason: null,
  alerts: [
    {
      id: "a1",
      kind: "state_changed_outside",
      severity: "warning",
      details: { changes: [{ table: "devices", change: "added", name: "rogue" }] },
      createdAt: "2026-11-05T10:00:00.000Z",
      acknowledgedAt: null,
    },
  ],
  recoveries: [],
};

function platform(calls: Record<string, (p: Record<string, unknown>) => unknown>) {
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(e: GatewayEvent) => void>();
  const p = {
    kind: "web",
    gateway: {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params });
        const fn = calls[method];
        if (!fn) throw Object.assign(new Error(`no ${method}`), { code: "unknown_method" });
        return fn(params);
      },
      onStatus: () => () => undefined,
      getStatus: async () => ({ phase: "paired" }),
      onEvent: (cb: (e: GatewayEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onResync: () => () => undefined,
    },
  } as unknown as ShellPlatform;
  const emit = (event: string) => {
    for (const l of listeners) l({ event, payload: {}, seq: 1, stateVersion: 1 });
  };
  return { p, seen, emit };
}

describe("SecurityStateBanner", () => {
  it("shows nothing while the records are sealed and quiet, or on an older Gateway", async () => {
    const quiet = platform({
      "security.state.get": () => ({ status: "sealed", reason: null, alerts: [], recoveries: [] }),
    });
    render(<SecurityStateBanner platform={quiet.p} />);
    await waitFor(() => expect(quiet.seen).toHaveLength(1));
    expect(screen.queryByTestId("security-banner")).toBeNull();
    cleanup();
    const old = platform({});
    render(<SecurityStateBanner platform={old.p} />);
    await waitFor(() => expect(old.seen).toHaveLength(1));
    expect(screen.queryByTestId("security-banner")).toBeNull();
  });

  it("names an undone change, lists it, and is marked reviewed with an approval", async () => {
    let state = changed;
    let asked = 0;
    const g = platform({
      "security.state.get": () => state,
      "security.alerts.acknowledge": (params) => {
        asked++;
        if (params.approvalId === undefined) {
          throw Object.assign(new Error("needs approval"), {
            code: "approval_required",
            details: { approvalId: "ap1" },
          });
        }
        state = { ...state, alerts: [] };
        return { alert: { ...changed.alerts[0], acknowledgedAt: "now" } };
      },
    });
    render(<SecurityStateBanner platform={g.p} />);
    const banner = await screen.findByTestId("security-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toMatch(/undid a change to its security records/);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Added: devices · rogue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText(/Approve the card with Touch ID/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(asked).toBe(2));
    expect(g.seen.at(-2)?.params).toEqual({ id: "a1", approvalId: "ap1" });
    await waitFor(() => expect(screen.queryByTestId("security-banner")).toBeNull());
  });

  it("shows a waiting request from the Mac with Cancel, and refreshes on the event", async () => {
    let state: SecurityStateStatus = { status: "sealed", reason: null, alerts: [], recoveries: [] };
    const g = platform({
      "security.state.get": () => state,
      "security.recoveries.cancel": () => ({ recovery: {} }),
    });
    render(<SecurityStateBanner platform={g.p} />);
    await waitFor(() => expect(g.seen).toHaveLength(1));
    state = {
      ...state,
      recoveries: [
        {
          id: "r1",
          op: "devices.approve",
          status: "waiting",
          requestedAt: "2026-11-05T10:00:00.000Z",
          notBefore: "2026-11-06T10:00:00.000Z",
          decidedAt: null,
          deviceName: "laptop",
          outcome: null,
        },
      ],
    };
    act(() => g.emit("security.state.changed"));
    const banner = await screen.findByTestId("security-banner");
    expect(banner.textContent).toMatch(/applies on .* unless you cancel it/);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/approve the device laptop/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(g.seen.some((c) => c.method === "security.recoveries.cancel")).toBe(true),
    );
  });

  it("an untrusted state cannot be dismissed and offers no approve-now", async () => {
    const g = platform({
      "security.state.get": () => ({
        status: "untrusted",
        reason: "ledger_mismatch",
        alerts: [
          {
            id: "u1",
            kind: "state_untrusted",
            severity: "warning",
            details: { reason: "ledger_mismatch" },
            createdAt: "2026-11-05T10:00:00.000Z",
            acknowledgedAt: null,
          },
        ],
        recoveries: [
          {
            id: "r2",
            op: "seal.reset",
            status: "waiting",
            requestedAt: "2026-11-05T10:00:00.000Z",
            notBefore: "2026-11-06T10:00:00.000Z",
            decidedAt: null,
            outcome: null,
          },
        ],
      }),
    });
    render(<SecurityStateBanner platform={g.p} />);
    const banner = await screen.findByTestId("security-banner");
    expect(banner.textContent).toMatch(/failed their check/);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel request" })).toBeTruthy();
  });
});
