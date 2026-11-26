import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/** `automations.cancelRetry` is operator.write: a read-only device is refused, an admin is not. */

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("automations.cancelRetry scope", () => {
  it("gives a read-only device forbidden, and a writer a real answer", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-cr-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0 },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const key = newDeviceKey();
    const deviceId = `ro-${Math.random().toString(36).slice(2)}`;
    (await desktopClient(composed.gateway, key, deviceId)).close();
    updateDevice(composed.gateway.context.db, deviceId, { scopes: ["operator.read"] });
    const readOnly = await desktopClient(composed.gateway, key, deviceId);
    clients.push(readOnly);
    expect(
      await readOnly.request("automations.cancelRetry", { runId: "run_x" }, ik()),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });

    const admin = await adminClient(composed.gateway);
    clients.push(admin);
    // Allowed past the scope check: the run just does not exist.
    expect(await admin.request("automations.cancelRetry", { runId: "run_x" }, ik())).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
