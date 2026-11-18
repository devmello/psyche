import { PsycheError } from "@psyche/protocol";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/data/client.ts";
import { GatewayProvider, GatewayStore, useRun } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { useLatchedVisible } from "../src/data/visible.ts";
import { FIXTURE_NOW, runTraceWorld, TRACE_IDS } from "../src/fixtures/index.ts";

/**
 * Two things keep a long chat inside the Gateway's per-device budget: a trace loads only once it
 * is on screen, and a `rate_limited` reply holds the client's non-urgent reads for the time the
 * Gateway asked for (then retries the read that was limited).
 */

const R = TRACE_IDS.runs;

/** Only elements marked `data-near="yes"` report as intersecting. */
class NearOnly {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    if ((target as HTMLElement).dataset.near !== "yes") return;
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

/** A stand-in for one chat message's trace: it loads only while it is near the screen. */
function Trace({ runId, near }: { runId: string; near: boolean }) {
  const { ref, visible } = useLatchedVisible<HTMLDivElement>();
  useRun(runId, { enabled: visible });
  return <div ref={ref} data-near={near ? "yes" : "no"} data-testid={`trace-${runId}`} />;
}

describe("trace loading in a long chat", () => {
  beforeEach(() => vi.stubGlobal("IntersectionObserver", NearOnly));
  afterEach(() => vi.unstubAllGlobals());

  it("a chat with 300 runs loads the traces on screen and no others", async () => {
    const gateway = new MockGateway(runTraceWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    const near = [R.done, R.failed, R.live];
    const runIds = Array.from({ length: 300 }, (_, i) => near[i] ?? `run_far_${i}`);
    render(
      <GatewayProvider client={gateway} store={store}>
        {runIds.map((runId, i) => (
          <Trace key={runId} runId={runId} near={i < near.length} />
        ))}
      </GatewayProvider>,
    );
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "runs.get")).toHaveLength(near.length),
    );
    const asked = gateway.calls
      .filter((c) => c.method === "runs.get")
      .map((c) => (c.params as { runId: string }).runId);
    expect(new Set(asked)).toEqual(new Set(near));
    expect(asked.some((id) => id.startsWith("run_far_"))).toBe(false);
  });
});

describe("rate_limited replies", () => {
  /** A client whose `request` answers from a script, one entry per call. */
  function scripted(replies: Array<(method: string) => Promise<unknown>>): {
    store: GatewayStore;
    calls: string[];
  } {
    const calls: string[] = [];
    let next = 0;
    const client = {
      connectionState: () => "open",
      request: (method: string) => {
        calls.push(method);
        const reply = replies[Math.min(next, replies.length - 1)];
        next += 1;
        return reply ? reply(method) : Promise.resolve({});
      },
    } as unknown as GatewayClient;
    return { store: new GatewayStore(client), calls };
  }
  const limited = (retryAfterSec: number) => () =>
    Promise.reject(
      new PsycheError("rate_limited", "slow down", { details: { retryAfterSec }, retryable: true }),
    );
  const ok = () => Promise.resolve({ runs: [] });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a limited read after retryAfterSec, and not before", async () => {
    const { store, calls } = scripted([limited(5), ok]);
    const done = store.call("runs.list", {}).then(
      () => "ok",
      () => "failed",
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(calls).toHaveLength(1);
    // Retry-after plus at most one second of jitter.
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(calls).toHaveLength(2);
    expect(await done).toBe("ok");
  });

  it("holds non-urgent reads through the pause but lets settings and security through", async () => {
    const { store, calls } = scripted([limited(10), ok, ok, ok]);
    const first = store.call("runs.list", {}).catch(() => null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls).toEqual(["runs.list"]);
    // Another non-urgent read waits; a settings read is sent straight away.
    const usage = store.call("usage.summary", {}).catch(() => null);
    const settings = store.call("settings.get", {}).catch(() => null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls).toEqual(["runs.list", "settings.get"]);
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(calls).toEqual(["runs.list", "settings.get", "runs.list", "usage.summary"]);
    await Promise.all([first, usage, settings]);
  });

  it("holds audit reads through the pause but sends a Stop at once", async () => {
    const { store, calls } = scripted([limited(10), ok, ok, ok]);
    const first = store.call("runs.list", {}).catch(() => null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls).toEqual(["runs.list"]);
    // Audit reads are background reads and wait; the user's Stop is never held.
    const audit = store.call("audit.changes", {} as never).catch(() => null);
    const stop = store.call("chat.cancel", {} as never).catch(() => null);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls).toEqual(["runs.list", "chat.cancel"]);
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(calls).toEqual(["runs.list", "chat.cancel", "runs.list", "audit.changes"]);
    await Promise.all([first, audit, stop]);
  });

  it("gives up after a few tries instead of looping", async () => {
    const { store, calls } = scripted([limited(1)]);
    const outcome = store.call("runs.list", {}).then(
      () => null,
      (err: unknown) => err,
    );
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(await outcome).toMatchObject({ code: "rate_limited" });
    expect(calls).toHaveLength(3);
  });

  it("never sends a side effect twice", async () => {
    const { store, calls } = scripted([limited(1), ok]);
    const outcome = store.call("automations.create", {} as never).then(
      () => null,
      (err: unknown) => err,
    );
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(await outcome).toMatchObject({ code: "rate_limited" });
    expect(calls).toEqual(["automations.create"]);
  });
});
