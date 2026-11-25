import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, createThread } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeStorage } from "../src/compose/storage.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, type TestClient } from "./helpers.ts";

let composed: ComposedGateway | null = null;
let home = "";
let client: TestClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-compact-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    parts: [(s) => composeStorage(s)],
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  client = await adminClient(composed.gateway);
  return composed;
}

describe("storage.compact", () => {
  it("estimates, refuses while a run is active, then compacts and reports the result", async () => {
    const c = await setup();
    const db = c.gateway.context.db;
    const est = await client!.call<{ dbBytes: number; reclaimableBytes: number; idle: boolean }>(
      "storage.compactEstimate",
      {},
    );
    expect(est.idle).toBe(true);
    expect(est.dbBytes).toBeGreaterThan(0);

    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(run.id);
    expect((await client!.call<{ idle: boolean }>("storage.compactEstimate", {})).idle).toBe(false);
    await expect(client!.call("storage.compact", {}, "k-busy")).rejects.toThrow(
      /working on something/,
    );

    db.sqlite.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(run.id);
    const r = await client!.call<{ durationMs: number; savedBytes: number }>(
      "storage.compact",
      {},
      "k-ok",
    );
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.savedBytes).toBeGreaterThanOrEqual(0);
  });
});
