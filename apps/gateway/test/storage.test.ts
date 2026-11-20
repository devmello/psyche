import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { clearStorage, composeStorage, sizeOf, storageUsage } from "../src/compose/storage.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/**
 * `storage.usage` and `storage.clearCache`: sizes by category under a temporary PSYCHE_HOME, and a
 * clear that touches caches and old finished recordings only.
 */

const DAY = 24 * 60 * 60 * 1000;
const homes: string[] = [];
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function bytes(path: string, n: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(n, 1));
}

function recording(home: string, id: string, endedAt: number | null): void {
  const dir = join(home, "library", "recordings", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "000001.jpg"), Buffer.alloc(300, 2));
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      taskId: id,
      startedAt: Date.now() - 9 * DAY,
      ...(endedAt === null ? {} : { endedAt }),
      frames: [],
    }),
  );
}

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "psyche-storage-"));
  homes.push(home);
  bytes(join(home, "state", "psyche.sqlite"), 1000);
  bytes(join(home, "state", "psyche.sqlite-wal"), 100);
  bytes(join(home, "state", "memory.sqlite"), 2000);
  bytes(join(home, "state", "search.sqlite"), 500);
  bytes(join(home, "library", "doc.pdf"), 4000);
  bytes(join(home, "browser", "profiles", "p1", "Cookies"), 700);
  bytes(join(home, "logs", "gateway.log"), 50);
  bytes(join(home, "cache", "conversions", "a.pdf"), 900);
  bytes(join(home, "vault", "v.db"), 80);
  return home;
}

const sizeById = (u: Awaited<ReturnType<typeof storageUsage>>) =>
  Object.fromEntries(u.categories.map((c) => [c.id, c.bytes]));

describe("storage.usage", () => {
  it("sorts the home into categories and marks only caches and recordings clearable", async () => {
    const home = fixture();
    const old = Date.now() - 9 * DAY;
    recording(home, "task_old", old);
    const u = await storageUsage(home);
    const sizes = sizeById(u);
    expect(sizes.database).toBe(1100);
    expect(sizes.memoryIndex).toBe(2500);
    expect(sizes.library).toBe(4000);
    expect(sizes.browserProfiles).toBe(700);
    expect(sizes.logs).toBe(50);
    expect(sizes.caches).toBe(900);
    expect(sizes.recordings).toBeGreaterThan(300);
    expect(sizes.other).toBe(80);
    expect(u.totalBytes).toBe(Object.values(sizes).reduce((a, b) => a + b, 0));
    expect(u.categories.filter((c) => c.clearable).map((c) => c.id)).toEqual([
      "recordings",
      "caches",
    ]);
  });

  it("does not follow symbolic links", async () => {
    const home = fixture();
    const outside = mkdtempSync(join(tmpdir(), "psyche-storage-out-"));
    homes.push(outside);
    bytes(join(outside, "big.bin"), 100_000);
    symlinkSync(outside, join(home, "cache", "link"));
    expect(await sizeOf(join(home, "cache"))).toBeLessThan(2000);
  });
});

describe("storage.clearCache", () => {
  it("empties caches and deletes recordings older than 7 days, and nothing else", async () => {
    const home = fixture();
    recording(home, "task_old", Date.now() - 9 * DAY);
    recording(home, "task_new", Date.now() - DAY);
    recording(home, "task_live", null);
    const before = await storageUsage(home);
    const r = await clearStorage(home, ["caches", "recordings"]);
    expect(r.cleared).toEqual(["caches", "recordings"]);
    expect(r.freedBytes).toBeGreaterThanOrEqual(900 + 300);
    expect(existsSync(join(home, "cache"))).toBe(true);
    expect(existsSync(join(home, "cache", "conversions"))).toBe(false);
    expect(existsSync(join(home, "library", "recordings", "task_old"))).toBe(false);
    expect(existsSync(join(home, "library", "recordings", "task_new"))).toBe(true);
    // An unfinished recording is never touched.
    expect(existsSync(join(home, "library", "recordings", "task_live"))).toBe(true);
    // Everything that is not rebuildable is exactly as it was.
    const after = sizeById(await storageUsage(home));
    const was = sizeById(before);
    for (const id of ["database", "memoryIndex", "library", "browserProfiles", "logs", "other"]) {
      expect(after[id], id).toBe(was[id]);
    }
  });

  it("clears only the target asked for", async () => {
    const home = fixture();
    recording(home, "task_old", Date.now() - 9 * DAY);
    const r = await clearStorage(home, ["caches"]);
    expect(r.cleared).toEqual(["caches"]);
    expect(existsSync(join(home, "library", "recordings", "task_old"))).toBe(true);
  });

  it("ignores a target that is not clearable, even if a client sends one", async () => {
    const home = fixture();
    const r = await clearStorage(home, ["database", "library", "logs"] as never);
    expect(r).toEqual({ cleared: [], freedBytes: 0 });
    expect(existsSync(join(home, "state", "psyche.sqlite"))).toBe(true);
    expect(existsSync(join(home, "library", "doc.pdf"))).toBe(true);
  });

  it("leaves a cache that is a link alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-storage-"));
    homes.push(home);
    const outside = mkdtempSync(join(tmpdir(), "psyche-storage-out-"));
    homes.push(outside);
    bytes(join(outside, "keep.bin"), 10);
    symlinkSync(outside, join(home, "cache"));
    await clearStorage(home, ["caches"]);
    expect(existsSync(join(outside, "keep.bin"))).toBe(true);
  });

  it("an old file mtime does not matter, only the recording's end time", async () => {
    const home = fixture();
    recording(home, "task_new", Date.now() - DAY);
    const dir = join(home, "library", "recordings", "task_new");
    const long = new Date(Date.now() - 30 * DAY);
    utimesSync(dir, long, long);
    await clearStorage(home, ["recordings"]);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("storage.* on the running Gateway", () => {
  it("needs operator.admin, and clears through the real method", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-storage-"));
    homes.push(home);
    bytes(join(home, "cache", "conversions", "a.pdf"), 900);
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeStorage(s)],
    });
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    for (const [method, params] of [
      ["storage.usage", {}],
      ["storage.clearCache", {}],
    ] as const) {
      expect(await desk.request(method, params, ik())).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
    const admin = await adminClient(composed.gateway);
    clients.push(admin);
    const usage = await admin.call<{ categories: { id: string }[]; totalBytes: number }>(
      "storage.usage",
      {},
    );
    expect(usage.categories.map((c) => c.id)).toContain("caches");
    const cleared = await admin.call<{ cleared: string[]; freedBytes: number }>(
      "storage.clearCache",
      { targets: ["caches"] },
      ik(),
    );
    expect(cleared.cleared).toEqual(["caches"]);
    expect(cleared.freedBytes).toBeGreaterThanOrEqual(900);
    expect(existsSync(join(home, "state", "psyche.sqlite"))).toBe(true);
    expect(existsSync(join(home, "cache", "conversions"))).toBe(false);
  });
});
