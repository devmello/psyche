import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import type { ModelEvent, ModelProvider, ModelRef } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CardHostState, composeSearch } from "../src/compose/search.ts";

/**
 * Search cards are a background job that calls a model: one bounded step every ten minutes (not
 * every minute), only on AC power, outside Low Power Mode, with the Mac idle, and only on a cheap
 * model (never the primary). A fake host, a fake provider and fake timers; no model is called.
 */

const dirs: string[] = [];
const stops: Array<() => unknown> = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval"] }));
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MIN = 60_000;
const BODY = `Quarterly plan: ${"hiring and budget are approved for the Lisbon offsite. ".repeat(8)}`;

function start(over: { model?: () => ModelRef | undefined; host?: () => CardHostState } = {}) {
  const home = mkdtempSync(join(tmpdir(), "psyche-cards-gate-"));
  dirs.push(home);
  const db = openDb(join(home, "psyche.sqlite"));
  const calls: string[] = [];
  const provider: ModelProvider = {
    id: "fake",
    capabilities: async () => ({}) as never,
    async *stream(req): AsyncIterable<ModelEvent> {
      calls.push(req.model);
      // Invalid JSON: no card, but the call happened (and its tokens are counted).
      yield { type: "text_delta", text: "not json" };
      yield {
        type: "usage",
        usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const host: { state: CardHostState; reads: number } = {
    state: { onAc: true, lowPowerMode: false, idleMinutes: 30 },
    reads: 0,
  };
  const search = composeSearch({
    db,
    home,
    memory: { search: async () => [], listFiles: async () => [], readFile: async () => undefined },
    tasks: { get: async () => undefined, actions: async () => [] },
    now: () => Date.UTC(2026, 10, 3),
    backfillPauseMs: 0,
    cards: {
      provider,
      model: over.model ?? (() => "fake/cheap"),
      readState: async () => {
        host.reads += 1;
        return over.host?.() ?? host.state;
      },
    },
  } as never);
  const gw = {
    bus: { subscribe: () => () => undefined, publish: () => undefined },
    context: {
      updateGate: { accepting: () => true },
      nodes: { hostHelper: () => undefined, onHostHelperChange: () => () => undefined },
    },
  };
  search.start?.(gw as never);
  stops.push(() => search.stop?.());
  stops.push(() => db.close());
  return { search, calls, host };
}

/** Let the async tick (gate read, sqlite, the fake stream) run to its end. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0);
};

async function withDoc(t: ReturnType<typeof start>) {
  // The first backfill sweeps documents no store owns: index after it finished.
  await settle();
  await t.search.index.index({
    id: "mail1",
    // Not a Library item: the Library sync would remove a document its store does not hold.
    kind: "connector",
    source: "mail",
    title: "Plan",
    text: BODY,
    provenance: "owner",
    createdAt: Date.UTC(2026, 10, 2),
  } as never);
}

describe("card ticks", () => {
  it("run every ten minutes, not every minute", async () => {
    const t = start();
    await withDoc(t);
    await vi.advanceTimersByTimeAsync(9 * MIN);
    await settle();
    expect(t.host.reads).toBe(0);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(MIN);
    await settle();
    expect(t.host.reads).toBe(1);
    expect(t.calls).toEqual(["fake/cheap"]);
    // The next hour holds six more beats at most, not sixty.
    await vi.advanceTimersByTimeAsync(60 * MIN);
    await settle();
    expect(t.host.reads).toBeLessThanOrEqual(7);
  });

  it("make no model call on battery, in Low Power Mode, or while the owner is at the keyboard", async () => {
    const t = start();
    await withDoc(t);
    const beat = async () => {
      await vi.advanceTimersByTimeAsync(10 * MIN);
      await settle();
    };
    t.host.state = { onAc: false, lowPowerMode: false, idleMinutes: 30 };
    await beat();
    t.host.state = { onAc: true, lowPowerMode: true, idleMinutes: 30 };
    await beat();
    t.host.state = { onAc: true, lowPowerMode: false, idleMinutes: 0 };
    await beat();
    expect(t.host.reads).toBe(3);
    expect(t.calls).toEqual([]);
    // Plugged in and idle: the same document gets its card attempt.
    t.host.state = { onAc: true, lowPowerMode: false, idleMinutes: 30 };
    await beat();
    expect(t.calls).toEqual(["fake/cheap"]);
  });

  it("make no model call, and read no host state, while there is no cheap model", async () => {
    let model: ModelRef | undefined;
    const t = start({ model: () => model });
    await withDoc(t);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    await settle();
    expect(t.calls).toEqual([]);
    expect(t.host.reads).toBe(0);
    // A utility model appears (the owner picked one): the next beat uses it.
    model = "fake/picked";
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await settle();
    expect(t.calls).toEqual(["fake/picked"]);
  });

  it("hold the tick when the host state cannot be read", async () => {
    const t = start({
      host: () => {
        throw new Error("pmset failed");
      },
    });
    await withDoc(t);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await settle();
    expect(t.calls).toEqual([]);
  });
});
