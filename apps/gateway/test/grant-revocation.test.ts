import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHost } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway, mcpGrantRevocation } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import {
  adminClient,
  desktopClient,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

const clients: TestClient[] = [];
let t: TestGateway | null = null;
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("grants end with their device (design-28)", () => {
  it("devices.revoke calls the revocation hook after commit", async () => {
    const onDeviceRevoked = vi.fn(async () => []);
    t = await startTestGateway({ onDeviceRevoked });
    const admin = await adminClient(t.gateway);
    const desk = await desktopClient(t.gateway, newDeviceKey(), "desk-1");
    clients.push(admin, desk);
    await admin.call("devices.revoke", { deviceId: "desk-1" });
    await vi.waitFor(() => expect(onDeviceRevoked).toHaveBeenCalledWith("desk-1"));
  });

  it("a failing hook does not undo the revocation", async () => {
    const onDeviceRevoked = vi.fn(async () => {
      throw new Error("broker down");
    });
    t = await startTestGateway({ onDeviceRevoked });
    const admin = await adminClient(t.gateway);
    clients.push(admin);
    await desktopClient(t.gateway, newDeviceKey(), "desk-2").then((c) => clients.push(c));
    const res = await admin.call<{ device: { revokedAt: string | null } }>("devices.revoke", {
      deviceId: "desk-2",
    });
    expect(res.device.revokedAt).not.toBeNull();
    await vi.waitFor(() => expect(onDeviceRevoked).toHaveBeenCalled());
  });

  it("the composition root wires the Permission Broker's revokeGrantsByDevice", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-grants-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const spy = vi.spyOn(composed.broker, "revokeGrantsByDevice");
    const admin = await adminClient(composed.gateway);
    clients.push(admin);
    await desktopClient(composed.gateway, newDeviceKey(), "desk-3").then((c) => clients.push(c));
    await admin.call("devices.revoke", { deviceId: "desk-3" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("desk-3"));
  });
});

describe("MCP grants end when the server changes (security §11)", () => {
  function fakeHost(): McpHost {
    return {
      listServers: async () => [],
      addServer: async () => {
        throw new Error("unused");
      },
      removeServer: vi.fn(async () => {}),
      listTools: async () => ({ tools: [], toolsListHash: `sha256:${"0".repeat(64)}` }),
      callTool: async () => {
        throw new Error("unused");
      },
    } as unknown as McpHost;
  }

  it("revokes grants bound to another tools/list hash on tools_changed", async () => {
    const broker = { revokeMcpGrants: vi.fn(async () => []) };
    const r = mcpGrantRevocation(broker);
    r.onEvent({ type: "status", serverId: "s1" });
    expect(broker.revokeMcpGrants).not.toHaveBeenCalled();
    r.onEvent({ type: "tools_changed", serverId: "s1", hash: "sha256:new" });
    expect(broker.revokeMcpGrants).toHaveBeenCalledWith("s1", "sha256:new");
  });

  it("revokes every grant of a removed server", async () => {
    const broker = { revokeMcpGrants: vi.fn(async () => []) };
    const host = mcpGrantRevocation(broker).wrap(fakeHost());
    await host.removeServer("s2");
    expect(broker.revokeMcpGrants).toHaveBeenCalledWith("s2", "removed");
  });

  it("reports broker failures without throwing into the host", async () => {
    const onError = vi.fn();
    const broker = { revokeMcpGrants: vi.fn(async () => Promise.reject(new Error("down"))) };
    const r = mcpGrantRevocation(broker, onError);
    r.onEvent({ type: "tools_changed", serverId: "s1", hash: "sha256:x" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await expect(r.wrap(fakeHost()).removeServer("s3")).resolves.toBeUndefined();
  });
});
