import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp, MCP_SERVERS_SETTING } from "../src/compose/mcp.ts";
import { serverConfig } from "../src/compose/mcp-add.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Verified trust: an owner-added server earns `verified` only from an exact official package or
 * vendor endpoint (security §11). Nothing here starts a third-party server: the stdio entries have
 * no launcher and are refused, which still reports their tier.
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

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-trust-"));
  let mcp: ComposedMcp | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        mcp = composeMcp(s, {
          // A remote server is never reached: the fake fetch refuses every request.
          hostOptions: {
            fetch: async () => {
              throw new Error("offline");
            },
          },
        });
        return mcp;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { owner, mcp: mcp as ComposedMcp };
}

const stdio = (id: string, command: string[], trust?: string) => ({
  id,
  name: id,
  ...(trust === undefined ? {} : { trust }),
  transport: { kind: "stdio", command },
});
const remote = (id: string, url: string, trust?: string) => ({
  id,
  name: id,
  ...(trust === undefined ? {} : { trust }),
  transport: { kind: "http", url },
});

describe("verified MCP trust", () => {
  it("stamps a server added through mcp.probe by where it comes from", () => {
    const input = (transport: Parameters<typeof serverConfig>[0]["transport"]) =>
      serverConfig({ id: "x-server", name: "X", transport });
    expect(
      input({
        kind: "stdio",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/"],
      }).trust,
    ).toBe("verified");
    expect(input({ kind: "http", url: "https://mcp.linear.app/mcp" }).trust).toBe("verified");
    expect(input({ kind: "stdio", command: ["npx", "-y", "left-pad-mcp"] }).trust).toBe("unknown");
    expect(input({ kind: "http", url: "https://mcp.linear.app.evil.test/mcp" }).trust).toBe(
      "unknown",
    );
  });

  it("re-derives the tier of every stored server: a claim does not make it verified", async () => {
    const { owner, mcp } = await setup();
    await owner.call(
      "settings.set",
      {
        key: MCP_SERVERS_SETTING,
        value: [
          // Official and stamped unknown by an older Gateway: now verified.
          remote("linear", "https://mcp.linear.app/mcp", "unknown"),
          stdio("fs", ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]),
          // Claims verified, but the command was edited to run something else.
          stdio("edited", ["sh", "-c", "npx @modelcontextprotocol/server-filesystem"], "verified"),
          remote("lookalike", "https://mcp.linear.app.evil.test/mcp", "verified"),
          // A bundled claim stays the host's to refuse (this id does not ship with Psyche).
          stdio("fake-bundled", ["node", "x.js"], "bundled"),
        ],
      },
      ik(),
    );
    await mcp.idle();
    const { servers } = await owner.call<{ servers: { id: string; trust: string }[] }>(
      "mcp.status",
      {},
    );
    const tier = Object.fromEntries(servers.map((s) => [s.id, s.trust]));
    expect(tier).toMatchObject({
      linear: "verified",
      fs: "verified",
      edited: "unknown",
      lookalike: "unknown",
    });
  });
});
