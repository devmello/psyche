import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Owner activity for approval routing: a request that changes something, never a read. */

let home = "";
let composed: ComposedGateway | null = null;
let client: TestClient | null = null;
afterEach(async () => {
  client?.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const activity = (g: ComposedGateway) =>
  [...g.gateway.context.connections()].map((c) => c.lastActivityAt);

describe("lastActivityAt", () => {
  it("is set by a side-effecting request and not by a read or the connection itself", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-activity-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: FakeModelProvider.script([]), model: "fake/model" },
    });
    client = await adminClient(composed.gateway);
    expect(activity(composed).every((a) => a === undefined)).toBe(true);
    await client.call("threads.list", {});
    expect(activity(composed).every((a) => a === undefined)).toBe(true);
    await client.call("settings.set", { key: "appearance.theme", value: "dark" }, ik());
    expect(activity(composed).some((a) => typeof a === "number")).toBe(true);
  });
});
