import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** The composed Gateway mounts `planForks.*`: one call through the real router. */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("planForks on the composed Gateway", () => {
  it("planForks.list answers through the router", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-forks-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: Thread }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    expect(await owner.call("planForks.list", { threadId: thread.id })).toEqual({ forks: [] });
  });
});
