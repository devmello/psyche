import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { Methods } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  adminClient,
  TestClient as Client,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  type TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Cookie import (docs/design/cookie-import-2026.md): the Gateway only records it. No method
 * imports, and only the desktop shell's own connection may write the audit entry.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function gateway(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-cookie-record-"));
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

/** A paired device with every scope, admin included, that is not the desktop shell. */
async function adminDevice(gw: ComposedGateway, family: "ios" | "cli"): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `${family}-1`;
  const first = await Client.open(wsUrlOf(gw.gateway));
  await handshake(first, gw.gateway.origin, { key, deviceId, deviceFamily: family });
  first.close();
  updateDevice(gw.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.admin"],
    pairedAt: new Date().toISOString(),
  });
  const c = await Client.open(wsUrlOf(gw.gateway));
  clients.push(c);
  await handshake(c, gw.gateway.origin, { key, deviceId, deviceFamily: family });
  return c;
}

const RECORD = {
  action: "imported",
  browser: "chrome",
  sites: [
    { domain: "github.com", cookies: 3 },
    { domain: "ucsc.edu", cookies: 2 },
  ],
} as const;

describe("browser.cookieImport.record", () => {
  it("no protocol method imports cookies: the only cookie method is the admin record", () => {
    const cookieMethods = Object.keys(Methods).filter((m) => /cookie/i.test(m));
    expect(cookieMethods).toEqual(["browser.cookieImport.record"]);
    const def = Methods["browser.cookieImport.record"];
    expect(def.scope).toBe("operator.admin");
  });

  it("writes domains and counts from the desktop shell", async () => {
    const gw = await gateway();
    const desk = await adminClient(gw.gateway);
    clients.push(desk);
    await desk.call("browser.cookieImport.record", RECORD, ik());
    const entries = await gw.audit.query({ kind: "browser.cookies.imported" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toEqual({ browser: "chrome", sites: RECORD.sites, total: 5 });
  });

  it("needs admin scope even on the desktop shell", async () => {
    const gw = await gateway();
    const desk = await desktopClient(gw.gateway);
    clients.push(desk);
    await expect(desk.call("browser.cookieImport.record", RECORD, ik())).rejects.toThrow(
      /requires scope operator.admin/,
    );
  });

  it("refuses a value or a cookie name in the params", async () => {
    const gw = await gateway();
    const desk = await adminClient(gw.gateway);
    clients.push(desk);
    await expect(
      desk.call(
        "browser.cookieImport.record",
        { ...RECORD, sites: [{ domain: "github.com", cookies: 1, value: "s3cr3t" }] },
        ik(),
      ),
    ).rejects.toThrow(/invalid_params/);
    await expect(
      desk.call("browser.cookieImport.record", { ...RECORD, names: ["user_session"] }, ik()),
    ).rejects.toThrow(/invalid_params/);
    expect(await gw.audit.query({ kind: "browser.cookies.imported" })).toHaveLength(0);
  });

  it.each(["ios", "cli"] as const)(
    "refuses an admin %s device that isn't the desktop",
    async (f) => {
      const gw = await gateway();
      const other = await adminDevice(gw, f);
      await expect(other.call("browser.cookieImport.record", RECORD, ik())).rejects.toThrow(
        /"code":"forbidden"/,
      );
      expect(await gw.audit.query({ kind: "browser.cookies.imported" })).toHaveLength(0);
    },
  );
});
