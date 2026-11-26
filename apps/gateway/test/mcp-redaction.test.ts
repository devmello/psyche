import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting, setSetting } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, desktopClient, ik, seedMcpServers, type TestClient } from "./helpers.ts";

/**
 * N5: `settings.get` is `operator.read`, so any paired device could read a tool server's env
 * values, URL tokens and auth. Nothing of the kind leaves the Gateway through settings reads,
 * writes or `settings.changed` events, while the Gateway itself still starts servers from the
 * real stored config.
 */

vi.setConfig({ testTimeout: 60_000 });

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));
const SECRETS = ["plain-env-secret", "URLTOKEN123", "oauth-client-secret", "bearer-slug"];

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-redaction-"));
  const launched: Record<string, string>[] = [];
  const launcher = {
    isolation: "srt" as const,
    prepare: async (spec: { command: string[]; serverEnv: Record<string, string> }) => {
      launched.push({ ...spec.serverEnv });
      return {
        command: spec.command[0] as string,
        args: spec.command.slice(1),
        env: { PATH: process.env.PATH ?? "" },
      };
    },
  };
  let services: ComposeServices | undefined;
  let mcp: ReturnType<typeof composeMcp> | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        mcp = composeMcp(s, { hostOptions: { launcher } });
        return mcp;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  const reader = await desktopClient(composed.gateway);
  clients.push(owner, reader);
  return {
    owner,
    reader,
    launched,
    services: services as ComposeServices,
    mcp: mcp as NonNullable<typeof mcp>,
  };
}

const entries = (env: Record<string, string>) => [
  {
    id: "echo",
    name: "Echo",
    trust: "unknown",
    transport: { kind: "stdio", command: [process.execPath, SERVER], env },
    sandbox: { allowedDomains: [] },
  },
  {
    id: "web",
    name: "Web",
    trust: "unknown",
    enabled: false,
    transport: { kind: "http", url: "https://api.example.com/mcp?token=URLTOKEN123" },
    auth: { kind: "oauth", clientId: "oauth-client-secret", scopes: ["read"] },
  },
  {
    id: "keyed",
    name: "Keyed",
    trust: "unknown",
    enabled: false,
    transport: { kind: "http", url: "https://keyed.example.com/mcp" },
    auth: { kind: "bearer", credential: "{{cred:bearer-slug}}" },
  },
];

describe("settings never carry a tool server's secrets", () => {
  it("settings.get: an admin and a non-admin device both get none", async () => {
    const { owner, reader, services } = await setup();
    setSetting(services.db, MCP_SERVERS_SETTING, entries({ PLAIN: "plain-env-secret" }));
    for (const who of [owner, reader]) {
      const got = JSON.stringify(await who.call("settings.get", { keys: [MCP_SERVERS_SETTING] }));
      for (const s of SECRETS) expect(got).not.toContain(s);
      // Positive control: the list is still there, with names and shape.
      expect(got).toContain('"id":"echo"');
      expect(got).toContain('"PLAIN":""');
      expect(got).toContain("api.example.com/mcp?token=***");
      // And the whole-settings read does not leak it either.
      const all = JSON.stringify(await who.call("settings.get", {}));
      for (const s of SECRETS) expect(all).not.toContain(s);
    }
    // The stored value is untouched.
    expect(JSON.stringify(getSetting(services.db, MCP_SERVERS_SETTING)?.value)).toContain(
      "plain-env-secret",
    );
  });

  it("the settings.changed event carries none, and the Gateway still starts the server from the real config", async () => {
    const { owner, reader, launched, services, mcp } = await setup();
    seedMcpServers(services, entries({ PLAIN: "plain-env-secret" }));
    await mcp.idle();
    const frames = JSON.stringify([...owner.events, ...reader.events]);
    for (const s of SECRETS) expect(frames).not.toContain(s);
    // Positive control: the event did arrive, and names the setting.
    expect(frames).toContain("settings.changed");
    expect(frames).toContain(MCP_SERVERS_SETTING);
    // The Gateway itself started the server with the real value.
    expect(launched.at(-1)?.PLAIN).toBe("plain-env-secret");
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();
  });

  it("settings.set refuses mcp.servers for an admin and a non-admin, and the stored value stays", async () => {
    const { owner, reader, services } = await setup();
    seedMcpServers(services, entries({ PLAIN: "plain-env-secret" }));
    const before = JSON.stringify(getSetting(services.db, MCP_SERVERS_SETTING)?.value);
    for (const who of [owner, reader]) {
      const res = await who.request("settings.set", { key: MCP_SERVERS_SETTING, value: [] }, ik());
      expect(res).toMatchObject({ ok: false });
      expect(JSON.stringify(res)).toMatch(/use_mcp_methods|forbidden/);
    }
    expect(JSON.stringify(getSetting(services.db, MCP_SERVERS_SETTING)?.value)).toBe(before);
    // Positive control: an ordinary setting is still writable by the admin.
    expect(
      await owner.request("settings.set", { key: "ui.test", value: "dark" }, ik()),
    ).toMatchObject({
      ok: true,
    });
  });

  it("a read followed by an mcp.* change keeps every secret", async () => {
    const { owner, services, mcp } = await setup();
    seedMcpServers(services, entries({ PLAIN: "plain-env-secret" }));
    await mcp.idle();
    await owner.call("settings.get", { keys: [MCP_SERVERS_SETTING] });
    await owner.call("mcp.setEnabled", { serverId: "echo", enabled: false }, ik());
    await mcp.idle();
    await owner.call("mcp.setEnabled", { serverId: "echo", enabled: true }, ik());
    await mcp.idle();
    const stored = JSON.stringify(getSetting(services.db, MCP_SERVERS_SETTING)?.value);
    for (const s of SECRETS.slice(0, 3)) expect(stored).toContain(s);
  });
});
