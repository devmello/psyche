import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "@psyche/memory";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

/** G12: the Gateway listens before the memory store's first sync; an early read still sees boot files. */

let composed: ComposedGateway | null = null;
let home: string | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await composed?.stop("test").catch(() => undefined);
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("memory boot (G12)", () => {
  it("binds the Gateway before the first sync finishes, and an early read waits for it", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-memboot-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "boot.md"), "boot okapi notes");

    // Hold the first sync until the test releases it.
    const original = SqliteMemoryStore.prototype.sync;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let syncDone = false;
    vi.spyOn(SqliteMemoryStore.prototype, "sync").mockImplementation(async function (
      this: SqliteMemoryStore,
    ) {
      await held;
      const result = await original.call(this);
      syncDone = true;
      return result;
    });

    const model = new FakeModelProvider().script([]);
    try {
      composed = await composeGateway({
        env: {},
        logger: silentLogger,
        retentionIntervalMs: 0,
        background: false,
        config: { home, port: 0, dbPath: join(home, "psyche.db") },
        model: { provider: model, model: "fake/model" },
      });
      // composeGateway resolved (the socket is bound) while the sync is still held.
      expect(composed.gateway.port).toBeGreaterThan(0);
      expect(syncDone).toBe(false);

      const early = composed.memory.search("okapi");
      release();
      const hits = await early;
      expect(syncDone).toBe(true);
      expect(hits.map((h) => h.chunk.source)).toContain("boot.md");
    } finally {
      release();
    }
  });
});
