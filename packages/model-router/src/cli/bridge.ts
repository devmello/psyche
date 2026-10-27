import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assetPath } from "@psyche/assets";

/**
 * The loopback half of Psyche's MCP tool bridge for the subscription CLIs. A CLI run gets a
 * channel (random path) and spawns `mcp-stdio-bridge.mjs` as its stdio MCP server; the script
 * relays each JSON-RPC message here. `tools/list` answers with the run's tools; `tools/call`
 * waits for the agent loop, which executes the tool behind its Permission Broker and hands the
 * result back on its next model call. The CLI never runs a Psyche tool itself.
 *
 * Bound to 127.0.0.1 on an ephemeral port; every request needs the bearer token, which only
 * the spawned relay reads, from a 0600 file (never argv, env or the CLI's MCP config).
 */

export interface BridgeTool {
  /** Name the CLI advertises (`mcp__psyche__<name>` to the model). */
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface BridgeChannel {
  tools: BridgeTool[];
  /** One `tools/call`; resolves when the loop has the result. */
  call(name: string, args: unknown): Promise<McpToolResult>;
}

/** The MCP server name the CLIs see; tools are `mcp__psyche__<tool>`. */
export const BRIDGE_SERVER_NAME = "psyche";

/** Path of the stdio relay script the CLI runs. */
export const BRIDGE_SCRIPT = assetPath("packages/model-router/src/cli/mcp-stdio-bridge.mjs");

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class ToolBridge {
  readonly #token = randomBytes(24).toString("hex");
  readonly #channels = new Map<string, BridgeChannel>();
  #server: Server | undefined;
  #port: Promise<number> | undefined;

  /** Register a run's tools; returns what the stdio relay's config file must hold. */
  async open(channel: BridgeChannel): Promise<{ id: string; url: string; token: string }> {
    const port = await this.#listen();
    const id = randomBytes(12).toString("hex");
    this.#channels.set(id, channel);
    return { id, url: `http://127.0.0.1:${port}/mcp/${id}`, token: this.#token };
  }

  close(id: string): void {
    this.#channels.delete(id);
  }

  /** Stop listening (adapter shutdown). */
  async stop(): Promise<void> {
    this.#channels.clear();
    const s = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    if (s === undefined) return;
    // Relays may hold requests open (a tool call waiting on the loop): drop them.
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  #listen(): Promise<number> {
    if (this.#port !== undefined) return this.#port;
    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    this.#server = server;
    this.#port = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        // The bridge must not keep the Gateway (or a test) alive on its own.
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.#port;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const match = /^\/mcp\/([0-9a-f]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || match === null) return send(404);
    if (req.headers.authorization !== `Bearer ${this.#token}`) return send(401);
    const channel = this.#channels.get(match[1] as string);
    if (channel === undefined) return send(410);
    let msg: JsonRpc;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpc;
    } catch {
      return send(200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    }
    // Notifications (`notifications/initialized`, cancellations) get no response.
    if (msg.id === undefined || msg.id === null) return send(202);
    const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) =>
      send(200, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return reply({
          protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: channel.tools });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string") return fail(-32602, "tools/call needs a name");
        try {
          return reply(await channel.call(name, msg.params?.arguments ?? {}));
        } catch (err) {
          return reply({
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          });
        }
      }
      default:
        return fail(-32601, `method ${msg.method ?? "?"} is not supported`);
    }
  }
}
