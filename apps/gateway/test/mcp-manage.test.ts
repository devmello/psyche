import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpHostEvent } from "@psyche/mcp-host";
import type { McpServerSecret, McpServerStatus, McpServerTool } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** A configured server's detail: its tools, the on/off switch and its secrets, by name. */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

/** Stands in for srt: runs the fixture unwrapped, but reports srt isolation. */
const fakeSrt = {
  isolation: "srt" as const,
  prepare: async (spec: { command: string[] }) => ({
    command: spec.command[0] as string,
    args: spec.command.slice(1),
    env: { PATH: process.env.PATH ?? "" },
  }),
};

const echo = (extra: string[] = [], more: Record<string, unknown> = {}) => ({
  id: "echo",
  name: "Echo",
  trust: "unknown",
  transport: { kind: "stdio", command: [process.execPath, SERVER, ...extra] },
  ...more,
});

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(withLauncher = true) {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-manage-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const events: McpHostEvent[] = [];
  let mcp: ComposedMcp | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [
      (s) => {
        services = s;
        mcp = composeMcp(s, {
          hostOptions: {
            ...(withLauncher ? { launcher: fakeSrt } : {}),
            onEvent: (e) => events.push(e),
            // A remote server is never reached.
            fetch: async () => {
              throw new Error("offline");
            },
          },
        });
        return mcp;
      },
    ],
  });
  await composed.vault.setup();
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  const serve = async (...servers: Record<string, unknown>[]) => {
    await owner.call("settings.set", { key: MCP_SERVERS_SETTING, value: servers }, ik());
    await (mcp as ComposedMcp).idle();
  };
  const stored = async () =>
    (
      await owner.call<{ settings: Record<string, Record<string, unknown>[]> }>("settings.get", {
        keys: [MCP_SERVERS_SETTING],
      })
    ).settings[MCP_SERVERS_SETTING] as Record<string, unknown>[];
  return {
    owner,
    mcp: mcp as ComposedMcp,
    services: services as ComposeServices,
    events,
    serve,
    stored,
  };
}

describe("MCP server tools", () => {
  it("lists a server's tools with their annotated side effect", async () => {
    const { owner, serve } = await setup();
    await serve(echo(["--write-tool"]));
    const r = await owner.call<{ tools: McpServerTool[]; available: boolean }>("mcp.tools", {
      serverId: "echo",
    });
    expect(r.available).toBe(true);
    expect(r.tools).toEqual([
      {
        name: "echo",
        description: "Echo the text back.",
        sideEffect: "read",
        enabled: true,
        blocked: false,
      },
      {
        name: "shout",
        description: "Shout the text.",
        sideEffect: "destructive",
        enabled: true,
        blocked: false,
      },
    ]);
    await expect(owner.call("mcp.tools", { serverId: "nope" })).rejects.toThrow(
      /"code":"not_found"/,
    );
  });

  it("withholds a tool from the agent without restarting the server, and offers it again", async () => {
    const { owner, services, serve, stored, events } = await setup();
    await serve(echo(["--write-tool"]));
    const connected = () =>
      events.filter((e) => e.type === "status" && e.status === "connected").length;
    expect(services.tools.get("mcp__echo__shout")).toBeDefined();
    expect(connected()).toBe(1);

    const off = await owner.call<{ tools: McpServerTool[] }>(
      "mcp.tools.set",
      { serverId: "echo", tool: "shout", enabled: false },
      ik(),
    );
    expect(off.tools.find((t) => t.name === "shout")?.enabled).toBe(false);
    expect(services.tools.get("mcp__echo__shout")).toBeUndefined();
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();
    expect((await stored())[0]).toMatchObject({ disabledTools: ["shout"] });
    // The same process: nothing restarted, so its grants were not revoked.
    expect(connected()).toBe(1);
    expect(await owner.call("mcp.status", {})).toMatchObject({
      servers: [{ id: "echo", connected: true }],
    });

    await owner.call("mcp.tools.set", { serverId: "echo", tool: "shout", enabled: true }, ik());
    expect(services.tools.get("mcp__echo__shout")).toBeDefined();
    expect((await stored())[0]).not.toHaveProperty("disabledTools");
    expect(connected()).toBe(1);
  });

  it("keeps the choice when the setting is rewritten, and refuses unknown tools", async () => {
    const { owner, services, serve } = await setup();
    await serve(echo(["--write-tool"], { disabledTools: ["echo"] }));
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(services.tools.get("mcp__echo__shout")).toBeDefined();
    await expect(
      owner.call("mcp.tools.set", { serverId: "echo", tool: "nope", enabled: false }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
  });

  it("shows a tool the description scan blocked as blocked, and never offers it", async () => {
    const { owner, services, serve } = await setup();
    await serve(echo(["--poisoned"]));
    const { tools } = await owner.call<{ tools: McpServerTool[] }>("mcp.tools", {
      serverId: "echo",
    });
    expect(tools.find((t) => t.name === "lookup")).toMatchObject({ blocked: true, enabled: true });
    await owner.call("mcp.tools.set", { serverId: "echo", tool: "lookup", enabled: true }, ik());
    expect(services.tools.get("mcp__echo__lookup")).toBeUndefined();
  });
});

describe("turning a server off", () => {
  it("keeps it configured but not running, and starts it again", async () => {
    const { owner, services, serve, stored } = await setup();
    await serve(echo(["--write-tool"], { disabledTools: ["shout"] }));
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();

    const off = await owner.call<{ server: McpServerStatus }>(
      "mcp.setEnabled",
      { serverId: "echo", enabled: false },
      ik(),
    );
    expect(off.server).toMatchObject({ id: "echo", enabled: false, connected: false });
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({
      servers: [{ id: "echo", enabled: false, connected: false }],
    });
    expect(await owner.call("mcp.tools", { serverId: "echo" })).toEqual({
      tools: [],
      available: false,
    });
    await expect(
      owner.call("mcp.tools.set", { serverId: "echo", tool: "echo", enabled: false }, ik()),
    ).rejects.toThrow(/"code":"unavailable"/);
    expect((await stored())[0]).toMatchObject({ enabled: false, disabledTools: ["shout"] });

    await owner.call("mcp.setEnabled", { serverId: "echo", enabled: true }, ik());
    const { servers } = await owner.call<{ servers: McpServerStatus[] }>("mcp.status", {});
    expect(servers[0]).not.toHaveProperty("enabled");
    expect((await stored())[0]).not.toHaveProperty("enabled");
    await expect(
      owner.call("mcp.setEnabled", { serverId: "nope", enabled: false }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
  });
});

describe("a server's secrets", () => {
  const withSecrets = () =>
    echo([], {
      transport: {
        kind: "stdio",
        command: [process.execPath, SERVER],
        env: { API_KEY: "{{cred:mcp-echo-api-key}}", LEGACY: "plain-legacy-value", EMPTY: "" },
      },
    });

  async function stockVault(owner: TestClient) {
    await owner.call(
      "vault.add",
      {
        kind: "api_key",
        name: "Echo key",
        slug: "mcp-echo-api-key",
        bindings: [{ connector: "mcp:echo" }],
        secret: { token: "old-secret-value" },
      },
      ik(),
    );
  }

  it("lists names and whether each is set, never a value", async () => {
    const { owner, serve } = await setup(false);
    await serve(withSecrets());
    await stockVault(owner);
    const r = await owner.call<{ secrets: McpServerSecret[] }>("mcp.secrets", { serverId: "echo" });
    expect(r.secrets).toEqual([
      { name: "API_KEY", storage: "vault", isSet: true },
      { name: "LEGACY", storage: "config", isSet: true },
      { name: "EMPTY", storage: "config", isSet: false },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/old-secret-value|plain-legacy-value/);
  });

  it("reports a placeholder whose vault item is missing or bound elsewhere as unset", async () => {
    const { owner, serve } = await setup(false);
    await serve(withSecrets());
    expect(
      (await owner.call<{ secrets: McpServerSecret[] }>("mcp.secrets", { serverId: "echo" }))
        .secrets[0],
    ).toMatchObject({ name: "API_KEY", isSet: false });
    await owner.call(
      "vault.add",
      {
        kind: "api_key",
        name: "Other",
        slug: "mcp-echo-api-key",
        bindings: [{ connector: "mcp:another" }],
        secret: { token: "someone-elses" },
      },
      ik(),
    );
    expect(
      (await owner.call<{ secrets: McpServerSecret[] }>("mcp.secrets", { serverId: "echo" }))
        .secrets[0],
    ).toMatchObject({ isSet: false });
  });

  it("replaces a vault secret in place, leaving the config as it was", async () => {
    const { owner, services, serve, stored } = await setup(false);
    await serve(withSecrets());
    await stockVault(owner);
    const before = JSON.stringify(await stored());
    const r = await owner.call<{ secret: McpServerSecret }>(
      "mcp.secrets.replace",
      { serverId: "echo", name: "API_KEY", value: "brand-new-secret-value" },
      ik(),
    );
    expect(r).toEqual({ secret: { name: "API_KEY", storage: "vault", isSet: true } });
    expect(JSON.stringify(r)).not.toContain("brand-new-secret-value");
    expect(JSON.stringify(await stored())).toBe(before);
    // The vault holds the new value (it is registered for redaction), under the same item.
    expect(services.vault.containsSecret("brand-new-secret-value")).toBe(true);
    const items = await owner.call<{ credentials: { slug: string }[] }>("vault.list", {});
    expect(items.credentials.filter((c) => c.slug === "mcp-echo-api-key")).toHaveLength(1);
  });

  it("moves a plain config value into the vault when it is replaced", async () => {
    const { owner, serve, stored } = await setup(false);
    await serve(withSecrets());
    const r = await owner.call<{ secret: McpServerSecret }>(
      "mcp.secrets.replace",
      { serverId: "echo", name: "LEGACY", value: "fresh-legacy-secret" },
      ik(),
    );
    expect(r.secret).toEqual({ name: "LEGACY", storage: "vault", isSet: true });
    const entry = (await stored())[0] as { transport: { env: Record<string, string> } };
    expect(entry.transport.env.LEGACY).toBe("{{cred:mcp-echo-legacy}}");
    expect(JSON.stringify(await stored())).not.toMatch(/plain-legacy-value|fresh-legacy-secret/);
    const items = await owner.call<{
      credentials: { slug: string; bindings: unknown[] }[];
    }>("vault.list", {});
    expect(items.credentials.find((c) => c.slug === "mcp-echo-legacy")?.bindings).toEqual([
      { connector: "mcp:echo" },
    ]);
  });

  it("never overwrites a vault item that belongs to something else", async () => {
    const { owner, serve, stored } = await setup(false);
    await serve(withSecrets());
    await owner.call(
      "vault.add",
      {
        kind: "api_key",
        name: "Other",
        slug: "mcp-echo-api-key",
        bindings: [{ connector: "mcp:another" }],
        secret: { token: "someone-elses" },
      },
      ik(),
    );
    const r = await owner.call<{ secret: McpServerSecret }>(
      "mcp.secrets.replace",
      { serverId: "echo", name: "API_KEY", value: "mine-now" },
      ik(),
    );
    expect(r.secret).toMatchObject({ storage: "vault", isSet: true });
    const entry = (await stored())[0] as { transport: { env: Record<string, string> } };
    expect(entry.transport.env.API_KEY).toBe("{{cred:mcp-echo-api-key-1}}");
  });

  it("refuses a name the server does not have", async () => {
    const { owner, serve } = await setup(false);
    await serve(withSecrets());
    await expect(
      owner.call("mcp.secrets.replace", { serverId: "echo", name: "NOPE", value: "x" }, ik()),
    ).rejects.toThrow(/"code":"not_found"/);
    await expect(owner.call("mcp.secrets", { serverId: "nope" })).rejects.toThrow(
      /"code":"not_found"/,
    );
  });

  it("keeps a remote server's bearer token in the vault under Authorization", async () => {
    const { owner, serve, stored } = await setup(false);
    await serve({
      id: "remote",
      name: "Remote",
      trust: "unknown",
      // Off, so nothing starts and asks for the token's approval card.
      enabled: false,
      transport: { kind: "http", url: "https://mcp.example.test/mcp" },
      auth: { kind: "bearer", credential: "{{cred:mcp-remote-token}}" },
    });
    expect(
      (await owner.call<{ secrets: McpServerSecret[] }>("mcp.secrets", { serverId: "remote" }))
        .secrets,
    ).toEqual([{ name: "Authorization", storage: "vault", isSet: false }]);
    const r = await owner.call<{ secret: McpServerSecret }>(
      "mcp.secrets.replace",
      { serverId: "remote", name: "Authorization", value: "bearer-token-value" },
      ik(),
    );
    expect(r.secret).toEqual({ name: "Authorization", storage: "vault", isSet: true });
    expect(JSON.stringify(await stored())).not.toContain("bearer-token-value");
  });
});
