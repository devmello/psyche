// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellProvider } from "../../src/shell/context.tsx";
import { ComputerWatchPane } from "../../src/shell/panes/ComputerWatchPane.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

type Tap = (e: { event: string; payload?: unknown }) => void;

function setup(machine: string | undefined, machines: unknown) {
  const taps = new Set<Tap>();
  const calls: { method: string; params: unknown }[] = [];
  const store = {
    getState: () => ({ approvals: [] }),
    subscribe: () => () => {},
    toast: vi.fn(),
    refresh: vi.fn(async () => {}),
    tap: (cb: Tap) => {
      taps.add(cb);
      return () => taps.delete(cb);
    },
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "machines.list") {
        if (machines instanceof Error) throw machines;
        return machines;
      }
      if (method === "computerWatch.status") {
        return {
          status: {
            state: "stopped",
            display: null,
            width: 0,
            height: 0,
            apps: [],
            takenOver: false,
            frameSeq: 0,
            startedAt: null,
          },
          parked: false,
        };
      }
      return { ok: true };
    }),
  };
  render(
    <ShellProvider platform={{} as ShellPlatform} store={store as never} mac>
      <ComputerWatchPane covered={false} machine={machine} />
    </ShellProvider>,
  );
  return {
    calls,
    emit: (e: { event: string; payload?: unknown }) =>
      act(() => {
        for (const t of taps) t(e);
      }),
  };
}

const LIST = { machines: [{ id: "mch_lab", name: "lab-box" }] };

describe("the watch pane for a paired computer", () => {
  it("says it is loading, and sends nothing to the screen, until the computer's name is known", async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => {
      release = r;
    });
    const calls: string[] = [];
    const store = {
      getState: () => ({ approvals: [] }),
      subscribe: () => () => {},
      toast: vi.fn(),
      refresh: vi.fn(async () => {}),
      tap: () => () => {},
      call: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "machines.list") return slow;
        return { ok: true };
      }),
    };
    render(
      <ShellProvider platform={{} as ShellPlatform} store={store as never} mac>
        <ComputerWatchPane covered={false} machine="mch_lab" />
      </ShellProvider>,
    );
    expect(screen.getByText("Loading computer…")).toBeTruthy();
    expect(screen.queryByText("Virtual screen")).toBeNull();
    expect(calls.filter((c) => c.startsWith("computerWatch."))).toEqual([]);
    await act(async () => release(LIST));
    await waitFor(() => expect(screen.getByRole("region", { name: /lab-box/ })).toBeTruthy());
  });

  it("never looks like the Host's screen when the list fails or the id is unknown", async () => {
    setup("mch_lab", new Error("down"));
    expect(await screen.findByText("That computer isn't available.")).toBeTruthy();
    expect(screen.queryByText("Virtual screen")).toBeNull();
    cleanup();
    const unknown = setup("mch_gone", LIST);
    expect(await screen.findByText("That computer isn't available.")).toBeTruthy();
    expect(unknown.calls.filter((c) => c.method.startsWith("computerWatch."))).toEqual([]);
  });

  it("reports its visibility for its own computer only", async () => {
    const { calls } = setup("mch_lab", LIST);
    await screen.findByRole("region", { name: /lab-box/ });
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "attention.report",
        params: { pane: "vscreen", visible: true, machine: "mch_lab" },
      }),
    );
  });

  it("shows a parked card only for its own screen", async () => {
    const lab = setup("mch_lab", LIST);
    await screen.findByRole("region", { name: /lab-box/ });
    lab.emit({ event: "computerWatch.parked", payload: { apps: [] } });
    expect(screen.queryByText("Waiting for you")).toBeNull();
    lab.emit({ event: "computerWatch.parked", payload: { apps: [], machine: "mch_other" } });
    expect(screen.queryByText("Waiting for you")).toBeNull();
    lab.emit({ event: "computerWatch.parked", payload: { apps: [], machine: "mch_lab" } });
    expect(await screen.findByText("Waiting for you")).toBeTruthy();
  });

  it("the Host's pane ignores a computer's parked card", async () => {
    const host = setup(undefined, LIST);
    await screen.findByRole("region", { name: "Virtual screen" });
    host.emit({ event: "computerWatch.parked", payload: { apps: [], machine: "mch_lab" } });
    expect(screen.queryByText("Waiting for you")).toBeNull();
    host.emit({ event: "computerWatch.parked", payload: { apps: [] } });
    expect(await screen.findByText("Waiting for you")).toBeTruthy();
  });
});
