import type {
  McpCallOptions,
  McpHost,
  McpServerConfig,
  McpServerInfo,
  McpToolList,
  McpToolResult,
  ToolSpec,
} from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../canonical.ts";
import { captureModelVisible } from "../capture.ts";
import { fail } from "./errors.ts";

export interface FakeMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  sideEffect?: ToolSpec["sideEffect"];
  handler?: (args: unknown) => unknown;
}

interface ServerState {
  config: McpServerConfig;
  tools: FakeMcpTool[];
}

/**
 * In-memory MCP host. Tools are registered per server with `serve(serverId, tools)`; changing
 * a tool (`serve` again with a different description or schema) changes `toolsListHash`, and
 * calls bound to the old hash fail with `conflict`.
 */
export class FakeMcpHost implements McpHost {
  readonly calls: { serverId: string; tool: string; args: unknown }[] = [];
  #servers = new Map<string, ServerState>();

  async listServers(): Promise<McpServerInfo[]> {
    return [...this.#servers.values()].map((s) => this.#info(s));
  }

  async addServer(config: McpServerConfig): Promise<McpServerInfo> {
    if (this.#servers.has(config.id)) return fail("conflict", `server ${config.id} exists`);
    const state: ServerState = { config: structuredClone(config), tools: [] };
    this.#servers.set(config.id, state);
    return this.#info(state);
  }

  async removeServer(serverId: string): Promise<void> {
    this.#servers.delete(serverId);
  }

  /** Set the tool list a server reports (adds the server as `unknown` stdio if missing). */
  serve(serverId: string, tools: FakeMcpTool[], trust: McpServerConfig["trust"] = "unknown"): this {
    const state = this.#servers.get(serverId) ?? {
      config: {
        id: serverId,
        name: serverId,
        transport: { kind: "stdio", command: [serverId] },
        trust,
      },
      tools: [],
    };
    state.tools = tools;
    this.#servers.set(serverId, state);
    return this;
  }

  #specs(s: ServerState): ToolSpec[] {
    return s.tools.map((t) => ({
      name: `mcp__${s.config.id}__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object" },
      sideEffect: t.sideEffect ?? "write",
      provenanceOut: s.config.trust === "bundled" ? "trusted" : "untrusted",
      descriptionProvenance: s.config.trust === "bundled" ? "trusted" : "untrusted",
    }));
  }

  #hash(s: ServerState) {
    return sha256(
      canonicalJSON(
        s.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? null,
        })),
      ),
    );
  }

  #info(s: ServerState): McpServerInfo {
    return {
      id: s.config.id,
      name: s.config.name,
      trust: s.config.trust,
      status: "connected",
      protocolVersion: "2026-07-28",
      toolsListHash: this.#hash(s),
    };
  }

  #server(serverId: string): ServerState {
    const s = this.#servers.get(serverId);
    if (s === undefined) return fail("not_found", `server ${serverId} not found`);
    return s;
  }

  async listTools(serverId: string): Promise<McpToolList> {
    const s = this.#server(serverId);
    return { tools: this.#specs(s), toolsListHash: this.#hash(s) };
  }

  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    options: McpCallOptions,
  ): Promise<McpToolResult> {
    if (options.signal?.aborted === true) return fail("cancelled", "call aborted");
    const s = this.#server(serverId);
    if (options.toolsListHash !== this.#hash(s)) {
      return fail("conflict", "tools/list changed since approval (rug pull defense)");
    }
    const t = s.tools.find((x) => x.name === tool);
    if (t === undefined) return fail("not_found", `tool ${tool} not found on ${serverId}`);
    this.calls.push({ serverId, tool, args: structuredClone(args) });
    const provenance = s.config.trust === "bundled" ? "trusted" : "untrusted";
    let result: McpToolResult;
    try {
      result = {
        content: t.handler === undefined ? null : t.handler(args),
        isError: false,
        provenance,
      };
    } catch (err) {
      result = {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
        provenance,
      };
    }
    captureModelVisible("tool_result", result.content, {
      where: `FakeMcpHost(${serverId}).${tool}`,
    });
    return result;
  }
}
