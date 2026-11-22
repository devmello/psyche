import { getDeviceFamily, insertDevice } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Owner decision on B3 r1: a device paired before families were recorded never becomes a
 * `desktop` later. That family opens the watch pane of a remote Host's private screen
 * (`watchAccess`), so only a device paired as a desktop is one; an unknown family reads as not a
 * desktop everywhere. Other families are still recorded once, as before.
 */

let t: TestGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
});

async function legacyDevice() {
  t = await startTestGateway();
  const g = t.gateway;
  const key = newDeviceKey();
  insertDevice(g.context.db, {
    id: "legacy-1",
    name: "an old device",
    platform: "macos",
    role: "client",
    publicKey: key.publicKey,
    scopes: ["operator.read", "operator.write", "operator.approvals"],
    pairedAt: new Date().toISOString(),
  });
  expect(getDeviceFamily(g.context.db, "legacy-1")).toBeNull();
  const connect = async (deviceFamily: "desktop" | "cli") => {
    const c = await TestClient.open(wsUrlOf(g));
    clients.push(c);
    return handshake(c, g.origin, { key, deviceId: "legacy-1", deviceFamily });
  };
  return { g, connect };
}

describe("a legacy device with no recorded family", () => {
  it("that now declares desktop is not recorded as one", async () => {
    const { g, connect } = await legacyDevice();
    await connect("desktop");
    expect(getDeviceFamily(g.context.db, "legacy-1")).toBeNull();
  });

  it("still records another family once", async () => {
    const { g, connect } = await legacyDevice();
    await connect("cli");
    expect(getDeviceFamily(g.context.db, "legacy-1")).toBe("cli");
  });
});
