import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertLibraryItem, openDb, setSetting } from "@psyche/db";
import type { PowerState } from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { composeSearch, RUN_ON_BATTERY_SETTING, SOURCES_SETTING } from "../src/compose/search.ts";

/**
 * "Index on battery" through the Gateway: the Rebuild handler's refusals name the real reason, the
 * setting is read live (no restart) for backfills, Rebuild and the Library's OCR backfill, and
 * Low Power Mode still pauses all of them. A fake power state and a fake helper; nothing real.
 */

const dirs: string[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wait = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

function start() {
  const home = mkdtempSync(join(tmpdir(), "psyche-battery-"));
  dirs.push(home);
  const db = openDb(join(home, "psyche.sqlite"));
  const world = {
    power: { onBattery: true, lowPower: false } as PowerState,
    helperCalls: [] as string[],
    ocrCalls: [] as string[],
  };
  const search = composeSearch({
    db,
    home,
    memory: { search: async () => [] },
    tasks: { get: async () => undefined, actions: async () => [] },
    now: () => Date.UTC(2026, 10, 3),
    librarySyncMs: 0,
    backfillPauseMs: 0,
    sources: {
      apple: {
        call: () => undefined,
        helper: () => undefined,
        contacts: () => async (capability: string) => {
          world.helperCalls.push(capability);
          if (capability === "contacts.list")
            return { contacts: [{ id: "c1", name: "Jordan Rivera" }], total: 1, truncated: false };
          return { contact: { id: "c1", givenName: "Jordan", familyName: "Rivera" } };
        },
        ownAddresses: () => [],
        now: () => Date.UTC(2026, 10, 3),
      },
      files: {
        folders: () => [],
        ocr: {
          enabled: () => false,
          // As compose/index.ts wires it: the same power reader the indexer uses.
          power: () => world.power,
          recognize: async (path: string) => {
            world.ocrCalls.push(path);
            return { text: "scanned lease for the flat", pages: 1 };
          },
        },
      },
      power: () => world.power,
    },
  } as never);
  stops.push(() => search.stop?.());
  const run = async (method: string, params: unknown) => {
    const handler = search.handlers?.[method];
    if (handler === undefined) throw new Error(`no ${method}`);
    return handler.run({} as never, params as never);
  };
  const setOnBattery = (on: boolean) => setSetting(db, RUN_ON_BATTERY_SETTING, on);
  return { home, db, search, world, run, setOnBattery };
}

/** What Rebuild refused with, or undefined when it went ahead. */
const refusal = (t: ReturnType<typeof start>) =>
  t
    .run("search.sources.rebuild", { source: "contacts" })
    .then(() => undefined)
    .catch((e: unknown) => e as { code: string; message: string });

const turnOn = (t: ReturnType<typeof start>, sources: Record<string, object>) =>
  setSetting(t.db, SOURCES_SETTING, { sources });

describe("Rebuild's refusal names the real reason", () => {
  it("battery with the setting off: says battery and names the setting", async () => {
    const t = start();
    turnOn(t, { contacts: { enabled: true } });
    const err = await refusal(t);
    expect(err).toMatchObject({ code: "unavailable" });
    expect(err?.message).toContain("The Mac is on battery");
    expect(err?.message).toContain("Index on battery");
    expect(err?.message).not.toContain("Plug in to rebuild");
  });

  it("Low Power Mode: says Low Power Mode, even with the setting on", async () => {
    const t = start();
    turnOn(t, { contacts: { enabled: true } });
    t.setOnBattery(true);
    t.world.power = { onBattery: true, lowPower: true };
    const err = await refusal(t);
    expect(err).toMatchObject({ code: "unavailable" });
    expect(err?.message).toContain("Low Power Mode is on");
    expect(err?.message).not.toContain("Plug in");
  });

  it("battery with the setting on, read live: Rebuild goes ahead and starts reading", async () => {
    const t = start();
    turnOn(t, { contacts: { enabled: true } });
    expect(await refusal(t)).toMatchObject({ code: "unavailable" });
    t.setOnBattery(true);
    await t.run("search.sources.rebuild", { source: "contacts" });
    await wait(() => t.world.helperCalls.includes("contacts.read"));
  });
});

describe("a backfill on battery", () => {
  it("waits with the setting off, runs when it is switched on, and stays paused in Low Power Mode", async () => {
    const t = start();
    turnOn(t, { contacts: { enabled: true } });
    await t.search.sourceTick();
    expect(t.world.helperCalls).toEqual([]);
    t.world.power = { onBattery: true, lowPower: true };
    t.setOnBattery(true);
    await t.search.sourceTick();
    expect(t.world.helperCalls).toEqual([]);
    t.world.power = { onBattery: true, lowPower: false };
    await t.search.sourceTick();
    expect(t.world.helperCalls).toEqual(["contacts.list", "contacts.read"]);
  });
});

describe("the Library's OCR backfill", () => {
  function withScan(t: ReturnType<typeof start>) {
    mkdirSync(join(t.home, "library", "scans"), { recursive: true });
    writeFileSync(join(t.home, "library", "scans", "lease.png"), "png");
    insertLibraryItem(t.db, {
      kind: "image",
      name: "lease.png",
      mime: "image/png",
      path: "scans/lease.png",
      size: 3,
      sha256: "sha256:1",
      origin: "upload",
    });
    turnOn(t, { files: { enabled: true, ocr: true } });
  }

  it("waits for power with the setting off, and reads on battery with it on", async () => {
    const t = start();
    withScan(t);
    await t.search.backfill.start({ full: true }).done;
    expect(t.world.ocrCalls).toEqual([]);
    t.setOnBattery(true);
    await t.search.backfill.start({ full: true }).done;
    expect(t.world.ocrCalls).toHaveLength(1);
  });

  it("stays off in Low Power Mode whatever the setting", async () => {
    const t = start();
    withScan(t);
    t.setOnBattery(true);
    t.world.power = { onBattery: true, lowPower: true };
    await t.search.backfill.start({ full: true }).done;
    expect(t.world.ocrCalls).toEqual([]);
  });
});
