import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { directLauncher } from "@psyche/mcp-host";
import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { createLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** K5: the MCP host mounted in the Gateway, servers managed through `settings.set`. */

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
const echoServer = (trust: "bundled" | "unknown") => ({
  id: "echo",
  name: "Echo",
  trust,
  transport: { kind: "stdio", command: [process.execPath, SERVER] },
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

async function setup(
  model: FakeModelProvider,
  logs: string[] = [],
  extra: Partial<Parameters<typeof composeMcp>[1]> = {},
) {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-"));
  let mcp: ComposedMcp | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: createLogger((line) => logs.push(line), "debug"),
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        // No srt here: only a server that ships with Psyche may run unwrapped.
        mcp = composeMcp(s, {
          hostOptions: { bundledServerIds: ["echo"], bundledLauncher: directLauncher() },
          ...extra,
        });
        return mcp;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { owner, mcp: mcp as ComposedMcp, services: services as ComposeServices };
}

describe("MCP host in the Gateway (K5)", () => {
  it("adds a server from settings, runs its tool through the loop, removes it and its grants", async () => {
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    model.script([call("c1", "mcp__echo__echo", { text: "hello" }), say("Echoed.")]);
    const { owner, mcp, services } = await setup(model);
    const revoke = vi.spyOn(services.rawBroker, "revokeMcpGrants");

    await owner.call(
      "settings.set",
      { key: MCP_SERVERS_SETTING, value: [echoServer("bundled")] },
      ik(),
    );
    await mcp.idle();
    expect(services.tools.get("mcp__echo__echo")).toBeDefined();
    expect(await owner.call("mcp.status", {})).toMatchObject({
      servers: [{ id: "echo", trust: "bundled", connected: true }],
    });

    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call("chat.send", { threadId: thread.id, content: "Echo hello." }, ik());
    // The call asks (connector_action); approve the card once it arms.
    const until = Date.now() + 10_000;
    let card: { approval: { id: string; kind: string }; answerToken?: string } | undefined;
    while (card === undefined) {
      if (Date.now() > until) throw new Error("no approval card");
      card = owner.events
        .filter((e) => e.event === "approval.created")
        .map((e) => e.payload as { approval: { id: string; kind: string }; answerToken?: string })
        .find((p) => p.answerToken !== undefined);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(card.approval.kind).toBe("connector_action");
    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    await owner.call("approvals.answer", {
      approvalId: card.approval.id,
      answerToken: card.answerToken,
      decision: "approve",
      scope: "once",
    });
    await composed?.gateway.context.sessions.idle();
    const last = model.requests.at(-1) as ModelRequest;
    expect(JSON.stringify(last.messages)).toContain("echo: hello");

    await owner.call("settings.set", { key: MCP_SERVERS_SETTING, value: [] }, ik());
    await mcp.idle();
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(await mcp.host.listServers()).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("echo", "removed");
  }, 30_000);

  it("refuses a non-bundled stdio server without srt or a container", async () => {
    const logs: string[] = [];
    const { owner, mcp, services } = await setup(new FakeModelProvider(), logs);
    await owner.call(
      "settings.set",
      { key: MCP_SERVERS_SETTING, value: [echoServer("unknown")] },
      ik(),
    );
    await mcp.idle();
    expect(services.tools.get("mcp__echo__echo")).toBeUndefined();
    expect(logs.join("\n")).toMatch(/mcp server (did not connect|could not be added)/);
    // What `psyche security audit` sees: no launcher, the server refused.
    expect(await owner.call("mcp.status", {})).toEqual({
      launcher: "none",
      servers: [
        expect.objectContaining({
          id: "echo",
          trust: "unknown",
          transport: "stdio",
          network: false,
          connected: false,
        }),
      ],
    });
  });

  it("runs container servers with network only through the egress allowlist", async () => {
    const calls: unknown[] = [];
    const { owner, mcp } = await setup(new FakeModelProvider(), [], {
      container: {
        ensureSandbox: async (scope, options) => {
          calls.push(["ensureSandbox", scope, options]);
          throw new Error("no container in this test");
        },
        openStdio: async () => {
          throw new Error("unreachable");
        },
      },
      egressAllowlist: (scope, domains) => {
        calls.push(["egressAllowlist", scope, domains]);
      },
    });
    await owner.call(
      "settings.set",
      {
        key: MCP_SERVERS_SETTING,
        value: [{ ...echoServer("unknown"), sandbox: { allowedDomains: ["api.example.test"] } }],
      },
      ik(),
    );
    await mcp.idle();
    expect(calls).toEqual([
      ["egressAllowlist", { kind: "task", id: "mcp:echo" }, ["api.example.test"]],
      ["ensureSandbox", { kind: "task", id: "mcp:echo" }, { network: "proxy" }],
    ]);
  });
});
