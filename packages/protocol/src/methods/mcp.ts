import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, OkResult } from "./define.ts";

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

/** A `{{cred:slug}}` vault placeholder; MCP server secrets are never sent or stored as values. */
const CredPlaceholder = Type.String({
  pattern: "^\\{\\{cred:[a-z0-9][a-z0-9-]{0,63}(\\.[a-z]+)?\\}\\}$",
});

/**
 * A server the owner adds from Settings → MCP (#529): a command (stdio, always sandboxed under
 * srt or in its own container) or an HTTPS URL. Becomes one `mcp.servers` entry once its trust
 * card is approved.
 */
export const McpServerInput = Type.Object(
  {
    /** Stable id; tools register as `mcp__<id>__<tool>`. */
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    transport: Type.Union([
      Type.Object({
        kind: Type.Literal("stdio"),
        /** argv; no shell. */
        command: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
          minItems: 1,
          maxItems: 64,
        }),
        /** Plain values or `{{cred:slug}}` placeholders (each read under its own approval). */
        env: Type.Optional(
          Type.Record(
            Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }),
            Type.String({ maxLength: 4_000 }),
          ),
        ),
      }),
      Type.Object({
        kind: Type.Literal("http"),
        url: Type.String({ pattern: "^https://", maxLength: 2_000 }),
        /** Default: OAuth when the server asks for it, else none. */
        auth: Type.Optional(
          Type.Union([
            Type.Object({ kind: Type.Literal("none") }),
            Type.Object({ kind: Type.Literal("oauth") }),
            Type.Object({ kind: Type.Literal("bearer"), credential: CredPlaceholder }),
          ]),
        ),
      }),
    ]),
    /** Domains a stdio server may reach through the sandbox proxy; default none. */
    allowedDomains: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 50 }),
    ),
  },
  { $id: "McpServerInput" },
);
export type McpServerInput = Static<typeof McpServerInput>;

/** One tool as the probe saw it. Name and description are written by the server: untrusted. */
export const McpProbedTool = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    /** From the server's annotations (`readOnlyHint` / `destructiveHint`); `write` when absent. */
    sideEffect: StringEnum(["read", "write", "destructive"]),
    /** Findings from the description scan; a blocking one keeps the tool from the agent. */
    warnings: Type.Array(Type.Object({ code: Type.String(), detail: Type.String() })),
    /** Not offered to the agent (a blocking warning). */
    blocked: Type.Boolean(),
  },
  { $id: "McpProbedTool" },
);
export type McpProbedTool = Static<typeof McpProbedTool>;

/** What `mcp.probe` found, staged for `mcp.add` (expires after 30 minutes). */
export const McpProposal = Type.Object(
  {
    id: Id,
    server: McpServerInput,
    tools: Type.Array(McpProbedTool),
    /** The `tools/list` hash the trust card binds; `mcp.add` refuses a server whose list changed. */
    toolsListHash: Type.String(),
    /** Where it can reach: an HTTP server's origin, or a stdio server's allowed domains. */
    network: Type.Object({ reaches: Type.Boolean(), hosts: Type.Array(Type.String()) }),
    /** How the probe ran it: `srt`, `container`, or `remote` for an HTTP server. */
    isolation: StringEnum(["srt", "container", "remote"]),
    /** The server's stderr tail or error from the probe, redacted (untrusted). */
    diagnostics: Type.Optional(Type.String()),
    expiresAt: Type.Integer({ description: "Epoch ms" }),
  },
  { $id: "McpProposal" },
);
export type McpProposal = Static<typeof McpProposal>;

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
  "mcp.probe": defineMethod({
    params: Type.Object({ server: McpServerInput }),
    result: Type.Object(
      { proposal: McpProposal, approval: ApprovalRequest },
      { $id: "McpProbeResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: starts the server sandboxed (srt or a container; never bare), lists its tools without registering them, stops it, and opens a device-only skill_install trust card (details.kind mcp_server) with the tools and network reach. unavailable when no sandbox launcher exists for a stdio server; conflict when the id is taken.",
  }),
  "mcp.add": defineMethod({
    params: Type.Object({ proposalId: Id, approvalId: Id }),
    result: Type.Object({ server: McpServerStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: adds a probed server to mcp.servers with its approved trust card; approval_required without it, conflict when its tools changed since the probe.",
  }),
  "mcp.remove": defineMethod({
    params: Type.Object({ serverId: Type.String({ minLength: 1, maxLength: 64 }) }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: removes a server from mcp.servers; its tools unregister and its grants are revoked.",
  }),
} as const;
