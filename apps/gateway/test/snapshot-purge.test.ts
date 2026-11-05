import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import type { signGate } from "../src/compose/skills.ts";
import { uninstallHandlers } from "../src/compose/uninstall.ts";
import { resolveConfig } from "../src/config.ts";
import type { Call } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";
import { preUpdateDir, purgePreUpdateSnapshots } from "../src/pre-update.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** The pre-update snapshots hold the owner's data, so erasing the data erases them too (L2). */

const roots: string[] = [];
const clients: TestClient[] = [];
let composed: ComposedGateway | undefined;
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fakeSnapshot(home: string): string {
  const dir = join(preUpdateDir(home), "0.4.0-to-0.5.0-x");
  mkdirSync(join(dir, "files", "state"), { recursive: true });
  writeFileSync(join(dir, "files", "state", "psyche.sqlite"), "private");
  return dir;
}

describe("purgePreUpdateSnapshots", () => {
  it("removes backups/pre-update and nothing beside it", () => {
    const home = mkdtempSync(join(tmpdir(), "psy-purge-"));
    roots.push(home);
    const dir = fakeSnapshot(home);
    writeFileSync(join(home, "backups", "psyche-keep.tar.gz"), "owner's own backup");
    purgePreUpdateSnapshots(home);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(home, "backups", "psyche-keep.tar.gz"))).toBe(true);
    expect(() => purgePreUpdateSnapshots(home)).not.toThrow();
  });
});

describe("uninstall with data", () => {
  it("purges the snapshots once the deletion is authorized, not before", async () => {
    const home = mkdtempSync(join(tmpdir(), "psy-purge-"));
    roots.push(home);
    const dir = fakeSnapshot(home);
    const services = {
      audit: { append: vi.fn(async () => undefined) },
    } as unknown as ComposeServices;
    const call = {
      identity: { desktopShell: true, deviceId: "d1" },
      conn: { peer: { remoteLoopback: true, origin: null } },
    } as unknown as Call;
    const refuse = vi.fn(async () => {
      throw new Error("approval_required");
    }) as unknown as typeof signGate;
    const refused = uninstallHandlers(services, refuse, home)["app.uninstall.authorize"];
    await expect(
      (refused!.run as unknown as (c: Call, p: unknown) => Promise<unknown>)(call, { path: home }),
    ).rejects.toThrow("approval_required");
    expect(existsSync(dir)).toBe(true);
    const allow = vi.fn(async () => undefined) as unknown as typeof signGate;
    const granted = uninstallHandlers(services, allow, home)["app.uninstall.authorize"];
    await (granted!.run as unknown as (c: Call, p: unknown) => Promise<unknown>)(call, {
      path: home,
    });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("erasing memory", () => {
  it("memory.reset purges the snapshots, a dry run does not", async () => {
    const home = mkdtempSync(join(tmpdir(), "psy-purge-"));
    roots.push(home);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { ...resolveConfig({ PSYCHE_HOME: home }), port: 0, webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const dir = fakeSnapshot(home);
    await owner.call("memory.reset", { dryRun: true }, ik());
    expect(existsSync(dir)).toBe(true);
    await owner.call("memory.reset", {}, ik());
    expect(existsSync(dir)).toBe(false);
  });
});
