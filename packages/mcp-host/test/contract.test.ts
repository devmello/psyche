import type { McpHost } from "@psyche/protocol";
import { FakeMcpHost } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PsycheMcpHost } from "../src/index.ts";
import { startEchoServer } from "./fixtures/echo-server.ts";

/**
 * `McpHost` contract (packages/protocol/src/contracts/McpHost.ts), run against the fake and the
 * real host so both keep the same observable behavior. Each harness yields a host with server
 * "echo" serving a tool "echo", and a `rugPull()` that changes that tool's description.
 */
interface Harness {
  host: McpHost;
  rugPull(): void;
  close(): Promise<void>;
}

const harnesses: Record<string, () => Promise<Harness>> = {
  FakeMcpHost: async () => {
    const host = new FakeMcpHost();
    await host.addServer({
      id: "echo",
      name: "Echo",
      trust: "unknown",
      transport: { kind: "http", url: "https://echo.example/mcp" },
    });
    host.serve("echo", [{ name: "echo", description: "Echoes.", handler: (a) => a }]);
    return {
      host,
      rugPull: () =>
        host.serve("echo", [{ name: "echo", description: "Changed.", handler: (a) => a }]),
      close: async () => {},
    };
  },
  PsycheMcpHost: async () => {
    const server = await startEchoServer();
    const host = new PsycheMcpHost();
    await host.addServer({
      id: "echo",
      name: "Echo",
      trust: "unknown",
      transport: { kind: "http", url: server.url },
    });
    return {
      host,
      rugPull: () => {
        server.state.echoDescription = "Changed.";
      },
      close: async () => {
        await host.close();
        await server.close();
      },
    };
  },
};

for (const [name, make] of Object.entries(harnesses)) {
  describe(`McpHost contract: ${name}`, () => {
    it("lists the server, refuses a duplicate id, exposes mcp__ tools with a hash", async () => {
      const h = await make();
      try {
        const servers = await h.host.listServers();
        expect(servers).toMatchObject([{ id: "echo", trust: "unknown", status: "connected" }]);
        await expect(
          h.host.addServer({
            id: "echo",
            name: "again",
            trust: "unknown",
            transport: { kind: "http", url: "https://echo.example/mcp" },
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        const list = await h.host.listTools("echo");
        expect(list.toolsListHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        const echo = list.tools.find((t) => t.name === "mcp__echo__echo");
        expect(echo).toMatchObject({ provenanceOut: "untrusted" });
        expect(echo?.sideEffect).not.toBe("read");
      } finally {
        await h.close();
      }
    });

    it("binds calls to the tools/list hash (rug pull → conflict)", async () => {
      const h = await make();
      try {
        const { toolsListHash } = await h.host.listTools("echo");
        const ok = await h.host.callTool("echo", "echo", { text: "x" }, { toolsListHash });
        expect(ok).toMatchObject({ isError: false, provenance: "untrusted" });
        h.rugPull();
        const after = await h.host.listTools("echo");
        expect(after.toolsListHash).not.toBe(toolsListHash);
        await expect(
          h.host.callTool("echo", "echo", { text: "x" }, { toolsListHash }),
        ).rejects.toMatchObject({ code: "conflict" });
      } finally {
        await h.close();
      }
    });

    it("unknown servers and tools are not_found; aborted calls are cancelled; removal works", async () => {
      const h = await make();
      try {
        await expect(h.host.listTools("missing")).rejects.toMatchObject({ code: "not_found" });
        const { toolsListHash } = await h.host.listTools("echo");
        await expect(h.host.callTool("echo", "nope", {}, { toolsListHash })).rejects.toMatchObject({
          code: "not_found",
        });
        const ac = new AbortController();
        ac.abort();
        await expect(
          h.host.callTool("echo", "echo", {}, { toolsListHash, signal: ac.signal }),
        ).rejects.toMatchObject({ code: "cancelled" });
        await h.host.removeServer("echo");
        expect(await h.host.listServers()).toEqual([]);
      } finally {
        await h.close();
      }
    });
  });
}
