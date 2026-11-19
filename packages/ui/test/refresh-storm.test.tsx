import { PsycheError } from "@psyche/protocol";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayEvent } from "../src/data/client.ts";
import { GatewayProvider, GatewayStore, useRun } from "../src/data/index.ts";

/**
 * The 2026-11 refresh storm: every seq gap re-ran all loaders, and a run whose `runs.get` failed
 * was fetched again on each one (11,584 rate-limited calls in 10 minutes). Both are bounded now.
 */

type Listener = (e: GatewayEvent) => void;

function fakeClient(reply: (method: string) => Promise<unknown>) {
  const calls: string[] = [];
  const listeners = new Set<Listener>();
  const client = {
    connectionState: () => "open",
    onConnectionState: () => () => {},
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request: (method: string) => {
      calls.push(method);
      return reply(method);
    },
  } as unknown as GatewayClient;
  const send = (seq: number) =>
    act(() => {
      for (const l of listeners) {
        l({ event: "device.updated", payload: {}, seq, stateVersion: seq } as never);
      }
    });
  return { client, calls, send };
}

describe("seq gaps", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a burst of gaps runs the loaders once, plus one trailing run", async () => {
    const { client, send } = fakeClient(() => Promise.resolve({}));
    const store = new GatewayStore(client);
    store.start();
    let loads = 0;
    store.registerRefresher("probe", async () => {
      loads += 1;
    });
    // seq 1, then 3, 5, 7, ...: every event after the first is a gap.
    for (let seq = 1; seq <= 201; seq += 2) await send(seq);
    expect(loads).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(loads).toBe(1);
    for (let seq = 203; seq <= 401; seq += 2) await send(seq);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(loads).toBe(2);
    store.stop();
  });

  it("a steady stream of gaps for a minute makes a bounded number of refreshes", async () => {
    const { client, send } = fakeClient(() => Promise.resolve({}));
    const store = new GatewayStore(client);
    store.start();
    let loads = 0;
    store.registerRefresher("probe", async () => {
      loads += 1;
    });
    let seq = 1;
    await send(seq);
    for (let i = 0; i < 600; i += 1) {
      seq += 2;
      await send(seq);
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    expect(loads).toBeLessThanOrEqual(31);
    store.stop();
  });
});

describe("runs that fail to load", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Trace({ runId }: { runId: string }) {
    useRun(runId);
    return null;
  }
  const fail = (code: string) => () =>
    Promise.reject(new PsycheError(code as never, "no", { retryable: false }));

  async function storm(code: string, seconds: number) {
    const { client, calls, send } = fakeClient(fail(code));
    const store = new GatewayStore(client);
    render(
      <GatewayProvider client={client} store={store}>
        <Trace runId="run_gone" />
      </GatewayProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(100));
    let seq = 1;
    await send(seq);
    for (let i = 0; i < seconds; i += 1) {
      seq += 2;
      await send(seq);
      await act(() => vi.advanceTimersByTimeAsync(1_000));
    }
    return calls.filter((c) => c === "runs.get").length;
  }

  it("never re-reads a not_found run on a refresh", async () => {
    expect(await storm("not_found", 120)).toBe(1);
  });

  it("backs off a failing run instead of reading it on every gap", async () => {
    // One gap a second for two minutes: the backoff allows only a handful of reads.
    expect(await storm("internal", 120)).toBeLessThanOrEqual(7);
  });
});
