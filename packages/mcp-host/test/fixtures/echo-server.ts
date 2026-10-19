import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * HTTP echo reference server for the host tests: Streamable HTTP, 2026-07-28 with the SDK's
 * stateless 2025-era fallback (or modern-only with `legacy: "reject"`). The tool list is mutable
 * so tests can stage a "rug pull" (changed description) between two `tools/list` calls.
 */
export interface EchoServerOptions {
  legacy?: "stateless" | "reject";
  /** Behave like a 2025-11-25 server: answer `server/discover` with method-not-found. */
  legacyOnly?: boolean;
  /** Return 401 unless `Authorization: Bearer <token>` matches; the challenge names the PRM URL. */
  requireToken?: () => string | undefined;
  /** Served before the MCP handler (OAuth metadata, mock AS endpoints). */
  extraRoutes?: (req: Request) => Promise<Response | undefined> | Response | undefined;
}

export interface EchoServer {
  url: string;
  origin: string;
  /** Description of the `echo` tool; change it and the next `tools/list` differs. */
  state: { echoDescription: string; extraTool: boolean; readOnlyHint: boolean };
  requests: { method: string; path: string; mcpMethod: string | null; auth: string | null }[];
  close(): Promise<void>;
}

function buildServer(state: EchoServer["state"]): McpServer {
  const server = new McpServer({ name: "psyche-echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: state.echoDescription,
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: state.readOnlyHint },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "delete_everything",
    {
      description: "Deletes every record.",
      inputSchema: z.object({}),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async () => ({ content: [{ type: "text", text: "deleted" }] }),
  );
  server.registerTool(
    "confirm_deploy",
    {
      description: "Asks for confirmation through a multi-round-trip request, then deploys.",
      inputSchema: z.object({ env: z.string() }),
      annotations: { readOnlyHint: false },
    },
    async ({ env }, ctx) => {
      const schema = z.object({ confirm: z.boolean() });
      const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", schema);
      if (answer === undefined && ctx.mcpReq.inputResponses?.confirm === undefined) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Deploy to ${env}?`,
              requestedSchema: schema,
            }),
          },
        });
      }
      return {
        content: [
          { type: "text", text: answer?.confirm === true ? `deployed to ${env}` : "cancelled" },
        ],
      };
    },
  );
  server.registerTool(
    "show_chart",
    {
      description: "Renders a chart in an MCP App.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://echo/chart.html" } },
    },
    async () => ({ content: [{ type: "text", text: "chart shown" }] }),
  );
  server.registerResource(
    "chart",
    "ui://echo/chart.html",
    { mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><title>chart</title><div id=chart></div>",
          _meta: { ui: { csp: { connectDomains: [] } } },
        },
      ],
    }),
  );
  if (state.extraTool) {
    server.registerTool(
      "extra",
      { description: "Added later.", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "extra" }] }),
    );
  }
  return server;
}

export async function startEchoServer(options: EchoServerOptions = {}): Promise<EchoServer> {
  const state = { echoDescription: "Echoes the text back.", extraTool: false, readOnlyHint: true };
  const requests: EchoServer["requests"] = [];
  const handler = createMcpHandler(() => buildServer(state), {
    legacy: options.legacy ?? "stateless",
  });
  const mcpFetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      path: url.pathname,
      mcpMethod: req.headers.get("mcp-method"),
      auth: req.headers.get("authorization"),
    });
    const extra = await options.extraRoutes?.(req);
    if (extra !== undefined) return extra;
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (options.legacyOnly === true && req.method === "POST") {
      const body = (await req.clone().json()) as { id?: unknown; method?: string };
      if (body.method === "server/discover") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32601, message: "Method not found" },
        });
      }
    }
    const expected = options.requireToken?.();
    if (options.requireToken !== undefined) {
      const auth = req.headers.get("authorization");
      if (expected === undefined || auth !== `Bearer ${expected}`) {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
    }
    return handler.fetch(req);
  };
  const node = toNodeHandler({ fetch: mcpFetch } as never);
  const server: Server = createServer((req, res) => {
    void node(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    state,
    requests,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
