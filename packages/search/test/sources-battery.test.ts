import { describe, expect, it } from "vitest";
import {
  defaultSourcesConfig,
  type PowerState,
  type SourceAdapter,
  SourceIndexer,
  type SourceItem,
} from "../src/index.ts";
import { setup } from "./helpers.ts";

/**
 * "Index on battery": the owner's setting lets backfills, first reads, sweeps and Rebuild run on
 * battery too, at half the pages per tick. Low Power Mode still pauses them, and a refused Rebuild
 * names the real reason.
 */

const item = (n: number): SourceItem => ({
  nativeId: `n${n}`,
  title: `Note ${n}`,
  text: `text of note ${n}`,
  createdAt: 1_000 + n,
  provenance: "owner",
});

/** Ten notes in pages of the size asked for; `calls` counts pages read. */
function stub(total = 10) {
  const state = { calls: 0, ids: undefined as string[] | undefined };
  const adapter: SourceAdapter = {
    id: "notes",
    unavailable: () => undefined,
    async pull(cursor, { limit }) {
      state.calls += 1;
      const from = typeof cursor === "number" ? cursor : 0;
      const to = Math.min(total, from + limit);
      return {
        items: Array.from({ length: to - from }, (_, i) => item(from + i)),
        cursor: to,
        hasMore: to < total,
      };
    },
    async listIds() {
      state.calls += 1;
      return { ids: state.ids ?? Array.from({ length: total }, (_, i) => `n${i}`), complete: true };
    },
  };
  return { adapter, state };
}

function harness(over: { runOnBattery?: boolean; power?: PowerState } = {}) {
  const { index } = setup();
  const { adapter, state } = stub();
  const config = defaultSourcesConfig();
  config.sources.notes.enabled = true;
  const world = {
    power: over.power ?? { onBattery: true, lowPower: false },
    runOnBattery: over.runOnBattery ?? false,
  };
  const indexer = new SourceIndexer(index, [adapter], {
    config: () => config,
    power: () => world.power,
    runOnBattery: () => world.runOnBattery,
    pauseMs: 0,
    pageSize: 1,
    pagesPerTick: 4,
    sweepEveryMs: 0,
  });
  return { index, indexer, world, state };
}

describe("Index on battery", () => {
  it("is off by default: a backfill waits for power", async () => {
    const h = harness();
    await h.indexer.tick();
    expect(await h.index.count()).toBe(0);
    expect(h.state.calls).toBe(0);
  });

  it("on: a first read runs on battery at half the pages per tick, then finishes", async () => {
    const h = harness({ runOnBattery: true });
    await h.indexer.tick();
    // pagesPerTick 4 -> 2 pages on battery, one note a page.
    expect(await h.index.count()).toBe(2);
    for (let i = 0; i < 6; i++) await h.indexer.tick();
    expect(await h.index.count()).toBe(10);
    expect(h.indexer.status().sources.find((s) => s.id === "notes")?.backfilled).toBe(true);
  });

  it("on power the full page budget is used, setting or not", async () => {
    const h = harness({ power: { onBattery: false, lowPower: false } });
    await h.indexer.tick();
    expect(await h.index.count()).toBe(4);
  });

  it("is read live: switching it on starts the waiting backfill with no restart", async () => {
    const h = harness();
    await h.indexer.tick();
    expect(await h.index.count()).toBe(0);
    h.world.runOnBattery = true;
    await h.indexer.tick();
    expect(await h.index.count()).toBe(2);
    h.world.runOnBattery = false;
    await h.indexer.tick();
    // Off again: the source is not filled yet, so it waits once more.
    expect(await h.index.count()).toBe(2);
  });

  it("off: a filled source still keeps up on battery, one page", async () => {
    const h = harness({ power: { onBattery: false, lowPower: false } });
    for (let i = 0; i < 3; i++) await h.indexer.tick();
    expect(await h.index.count()).toBe(10);
    const before = h.state.calls;
    h.world.power = { onBattery: true, lowPower: false };
    await h.indexer.tick();
    expect(h.state.calls).toBe(before + 1);
  });

  it("Low Power Mode still pauses indexing with the setting on", async () => {
    const h = harness({ runOnBattery: true, power: { onBattery: true, lowPower: true } });
    await h.indexer.tick();
    expect(await h.index.count()).toBe(0);
    expect(h.state.calls).toBe(0);
    // Plugged in but in Low Power Mode is paused too.
    h.world.power = { onBattery: false, lowPower: true };
    await h.indexer.tick();
    expect(h.state.calls).toBe(0);
    await h.indexer.pullSource("notes");
    expect(h.state.calls).toBe(0);
  });

  it("pullSource follows the setting for a source that is not filled", async () => {
    const h = harness();
    await h.indexer.pullSource("notes");
    expect(h.state.calls).toBe(0);
    h.world.runOnBattery = true;
    await h.indexer.pullSource("notes");
    expect(h.state.calls).toBe(2);
  });

  it("the nightly sweep runs on battery only when allowed", async () => {
    const h = harness({ power: { onBattery: false, lowPower: false } });
    for (let i = 0; i < 3; i++) await h.indexer.tick();
    expect(await h.index.count()).toBe(10);
    h.state.ids = ["n0"];
    h.world.power = { onBattery: true, lowPower: false };
    await h.indexer.tick();
    expect(await h.index.count()).toBe(10);
    h.world.runOnBattery = true;
    await h.indexer.tick();
    expect(await h.index.count()).toBe(1);
  });

  describe("Rebuild", () => {
    it("on battery with the setting off says so, and names the setting; nothing is removed", async () => {
      const h = harness({ power: { onBattery: false, lowPower: false } });
      for (let i = 0; i < 3; i++) await h.indexer.tick();
      h.world.power = { onBattery: true, lowPower: false };
      const err = await h.indexer.rebuild("notes").catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "power" });
      expect((err as Error).message).toContain("The Mac is on battery");
      expect((err as Error).message).toContain("Index on battery");
      expect((err as Error).message).not.toContain("Low Power");
      expect(await h.index.count()).toBe(10);
    });

    it("on battery with the setting on goes ahead", async () => {
      const h = harness({ power: { onBattery: false, lowPower: false } });
      for (let i = 0; i < 3; i++) await h.indexer.tick();
      h.world.power = { onBattery: true, lowPower: false };
      h.world.runOnBattery = true;
      await h.indexer.rebuild("notes");
      expect(await h.index.count()).toBe(0);
      await h.indexer.kick();
      expect(await h.index.count()).toBe(2);
    });

    it("in Low Power Mode it is refused whatever the setting, saying Low Power Mode", async () => {
      const h = harness({ runOnBattery: true, power: { onBattery: false, lowPower: false } });
      for (let i = 0; i < 3; i++) await h.indexer.tick();
      h.world.power = { onBattery: true, lowPower: true };
      const err = await h.indexer.rebuild("notes").catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "power" });
      expect((err as Error).message).toContain("Low Power Mode is on");
      expect((err as Error).message).not.toContain("Plug in");
      expect(await h.index.count()).toBe(10);
      // Plugged in but in Low Power Mode: still Low Power Mode, never "plug in".
      h.world.power = { onBattery: false, lowPower: true };
      const again = await h.indexer.rebuild("notes").catch((e: unknown) => e);
      expect((again as Error).message).toContain("Low Power Mode is on");
      expect((again as Error).message).not.toContain("battery");
    });

    it("both reasons are named when both hold and the setting is off", async () => {
      const h = harness({ power: { onBattery: true, lowPower: true } });
      const err = await h.indexer.rebuild("notes").catch((e: unknown) => e);
      expect((err as Error).message).toContain("Low Power Mode is on and the Mac is on battery");
    });
  });
});
