import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `mcp.*` (architecture §4.9; security §11 "MCP servers"): how the Gateway runs MCP servers, for
 * `psyche security audit` and Settings. Server configs themselves live in the `mcp.servers`
 * setting; this reports what the host made of them.
 */

export const McpServerStatus = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    trust: StringEnum(["bundled", "verified", "unknown"]),
    transport: StringEnum(["stdio", "http"]),
    /** Reaches the network: a remote (http) server, or a stdio server with allowed domains. */
    network: Type.Boolean(),
    /** Its tools are registered (it connected). */
    connected: Type.Boolean(),
  },
  { $id: "McpServerStatus" },
);
export type McpServerStatus = Static<typeof McpServerStatus>;

export const McpMethods = {
  "mcp.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      /**
       * How stdio servers are isolated: `srt` (sandbox-runtime), `container` (each in its own
       * sandbox container) or `none` (no launcher: non-bundled stdio servers are refused, never
       * run bare).
       */
      launcher: StringEnum(["srt", "container", "none"]),
      servers: Type.Array(McpServerStatus),
    }),
    scope: "operator.read",
    description:
      "The MCP launcher in use and each configured server's trust, transport and network reach.",
  }),
} as const;
