import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function compose(): Promise<ComposedGateway> {
  return composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
}

describe("composition root restart", () => {
  it("restarts on the same database with the notifications tables from the migration ledger", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-compose-"));
    composed = await compose();
    const first = await composed.notifier.notify({
      kind: "system",
      title: "Hello",
      body: "first boot",
    });
    await composed.stop("restart");
    composed = await compose();
    const ledger = composed.db.sqlite
      .prepare("SELECT id FROM _migrations WHERE id = '202610190200_notifications_init'")
      .get();
    expect(ledger).toBeDefined();
    const listed = await composed.notifier.list();
    expect(listed.map((n) => n.id)).toContain(first.id);
  });

  it("closes the database it opened itself on stop", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-compose-"));
    const c = await compose();
    await c.stop("test");
    expect(c.db.sqlite.open).toBe(false);
    // A second stop path (tests, shutdown races) must not throw on the closed handle.
    expect(() => c.db.close()).not.toThrow();
  });

  it("leaves a caller-supplied database open", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-compose-"));
    const db = openDb(join(home, "own.db"));
    try {
      const c = await composeGateway({
        env: {},
        logger: silentLogger,
        retentionIntervalMs: 0,
        background: false,
        db,
        config: { home, port: 0, dbPath: join(home, "own.db"), webRoot: null },
        model: { provider: new FakeModelProvider(), model: "fake/model" },
      });
      await c.stop("test");
      expect(db.sqlite.open).toBe(true);
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
